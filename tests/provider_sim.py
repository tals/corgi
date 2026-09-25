"""Provider-side fixtures shared by Corgi's process integration tests.

These simulate provider output, never Corgi's state machine. Native and ordinary
terminal programs remain real child processes; CodexObserver serves the actual
read-only WebSocket protocol. Response gates freeze a reply at request time so
scenarios can deliver stale observations without relying on arbitrary sleeps.
"""
import base64
import hashlib
import json
import pathlib
import socket
import struct
import sys
import threading

NATIVE_PROVIDER = r'''#!/usr/bin/env python3
import sys, json
if '--version' in sys.argv:
    print('codex-cli 1.2.3-fixture');sys.exit(0)
claude = '--print' in sys.argv
def emit(x): print(json.dumps(x), flush=True)
turn_number = 0
active_turn = None
last_turn = None
def ensure_turn():
    global turn_number, active_turn, last_turn
    if active_turn is None:
        turn_number += 1
        active_turn = 'turn' if turn_number == 1 else f'turn-{turn_number}'
        last_turn = active_turn
        if not claude: emit({'method':'turn/started','params':{'threadId':'t','turn':{'id':active_turn}}})
    return active_turn
def finish_turn(result):
    global active_turn
    emit({'type':'result','result':result} if claude else {'method':'turn/completed','params':{'threadId':'t','turn':{'id':active_turn or last_turn,'status':'completed'}}})
    active_turn = None
for line in sys.stdin:
    v = json.loads(line)
    if v.get('method') == 'initialize': emit({'id': v['id'], 'result': {'version':'fixture'}})
    elif v.get('method') == 'initialized': emit({'method':'ready'})
    elif v.get('method') == 'test/approval':
        ensure_turn()
        emit({'type':'control_request','request_id':'permission-1','request':{'subtype':'can_use_tool','tool_name':'Bash'}} if claude else {'id':900,'method':'item/commandExecution/requestApproval','params':{'threadId':'t'}})
    elif v.get('method') == 'test/flood':
        for i in range(150): emit({'type':'fixture','n':i})
    elif v.get('method') == 'test/tool-start':
        ensure_turn()
        ident=v['params']['id']
        emit({'type':'assistant','message':{'content':[{'type':'tool_use','id':ident,'name':'Bash','input':{}}]}} if claude else {'method':'item/started','params':{'threadId':'t','turnId':active_turn,'item':{'id':ident,'type':'commandExecution'}}})
    elif v.get('method') == 'test/tool-stop':
        ident=v['params']['id']
        emit({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':ident,'content':'done'}]}} if claude else {'method':'item/completed','params':{'threadId':'t','turnId':active_turn,'item':{'id':ident,'type':'commandExecution'}}})
    elif v.get('method') == 'test/turn-end':
        finish_turn('done')
    elif v.get('id') == 900 or v.get('type') == 'control_response':
        finish_turn('complete')
    elif v.get('method') == 'test/event':emit(v['params'])
    elif v.get('method') == 'test/exit': sys.exit(0)
    elif 'id' in v: emit({'id':v['id'],'result':{'echo':v}})
'''

ORDINARY_PROVIDER = r'''
import os,sys,json,pathlib,subprocess,datetime
provider=pathlib.Path(sys.argv[0]).name
path=pathlib.Path(os.environ['CODEX_HOME'],'hooks.json') if provider=='codex' else pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'],'settings.json')
transcript=pathlib.Path(os.environ['HOME'],'ordinary-'+provider+'.jsonl')
transcript.write_text(json.dumps({'type':'session_meta','payload':{'id':'ordinary-'+provider}})+'\n')
turn=0
def event(name):
    global turn
    if not path.exists():return
    if name=='UserPromptSubmit':turn+=1
    for group in json.loads(path.read_text()).get('hooks',{}).get(name,[]):
        for hook in group['hooks']:
            subprocess.run(['/bin/sh','-c',hook['command']],input=json.dumps({'hook_event_name':name,'session_id':'ordinary-'+provider,'turn_id':str(turn),'transcript_path':str(transcript)}),text=True)
    if name=='Stop':
        stamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        record={'type':'event_msg','timestamp':stamp,'payload':{'type':'task_complete','turn_id':str(turn)}} if provider=='codex' else {'type':'system','subtype':'turn_duration','sessionId':'ordinary-'+provider,'timestamp':stamp}
        with transcript.open('a') as f:f.write(json.dumps(record)+'\n')
if '--loading' in sys.argv:
    print('\x1b[2J\x1b[H\x1b]2;⠋ Starting\x07Initializing (esc to interrupt)',flush=True)
    for line in sys.stdin:
        if line.strip()=='ready':break
event('SessionStart')
print('\x1b[2J\x1b[H\x1b]2;✳ Ready\x07› ',flush=True)
for line in sys.stdin:
    command=line.strip()
    if command=='exit':break
    if command=='work':
        event('UserPromptSubmit');print('\x1b[2J\x1b[H\x1b]2;⠋ Task\x07Working (esc to interrupt)',flush=True)
    elif command=='tool':
        print('\x1b[2J\x1b[H• Working (20s • esc to interrupt) · 1 background t…\n› Ask Codex to do anything',flush=True)
    elif command=='block':
        event('PermissionRequest');print('\x1b[2J\x1b[H\x1b]2;Action Required\x07enter to confirm or esc to cancel',flush=True)
    elif command=='stop':
        event('Stop');print('\x1b[2J\x1b[H\x1b]2;✳ Ready\x07› ',flush=True)
event('SessionEnd')
'''


def write_executable(path, source):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if source.startswith('#!/usr/bin/env python3'):
        source = source.replace('#!/usr/bin/env python3', '#!' + sys.executable, 1)
    path.write_text(source)
    path.chmod(0o700)
    return path


def write_ordinary_agent(path):
    """A terminal agent driven by work/tool/block/stop/exit lines on its PTY."""
    return write_executable(path, '#!' + sys.executable + '\n' + ORDINARY_PROVIDER)


def write_codex_terminal(path, session):
    """Emit a selected conversation title; each input line changes selection."""
    return write_executable(path, '''#!/usr/bin/env python3
import sys,json
print('ARGS:'+json.dumps(sys.argv[1:]),flush=True)
def title(s): print('\\x1b]0;codex | '+s+'\\x07',end='',flush=True)
title(''' + repr(session[:29] + '...') + ''')
for line in sys.stdin:
    value=line.strip()
    if value=='exit': break
    if value.startswith('screen:'):
        screen='Working (esc to interrupt)' if value=='screen:working' else '› '
        print('\\x1b[2J\\x1b[H'+screen,flush=True)
    else:
        title(value)
''')


class TerminalAttachment:
    """A fixture handle for one real Corgi pane, independent of conversation."""

    def __init__(self, runtime, pane):
        self.runtime = runtime
        self.pane = pane

    def send(self, text):
        self.runtime.command('pane.input', target=self.pane, data=text + '\r')

    def select(self, session, abbreviate=True):
        self.send(session[:29] + '...' if abbreviate else session)

    def state(self):
        return next(p for p in self.runtime.panes() if p['id'] == self.pane)


def _exact(peer, length):
    data = b''
    while len(data) < length:
        chunk = peer.recv(length - len(data))
        if not chunk:
            raise EOFError()
        data += chunk
    return data


def _receive(peer):
    header = _exact(peer, 2)
    length = header[1] & 127
    if length == 126:
        length = struct.unpack('!H', _exact(peer, 2))[0]
    elif length == 127:
        length = struct.unpack('!Q', _exact(peer, 8))[0]
    mask = _exact(peer, 4) if header[1] & 128 else bytes(4)
    data = _exact(peer, length)
    return json.loads(bytes(value ^ mask[index % 4] for index, value in enumerate(data)))


def _frame(value):
    data = json.dumps(value).encode()
    length = len(data)
    if length < 126:
        size = bytes([length])
    elif length <= 65535:
        size = b'\x7e' + struct.pack('!H', length)
    else:
        size = b'\x7f' + struct.pack('!Q', length)
    return b'\x81' + size + data


class HeldResponse:
    """One frozen protocol reply, captured by wait() and delivered by release()."""

    def __init__(self, method, session):
        self.method = method
        self.session = session
        self.request = None
        self.response = None
        self._captured = threading.Event()
        self._released = threading.Event()

    def matches(self, request):
        return (request['method'] == self.method and
                (self.session is None or request.get('params', {}).get('threadId') == self.session))

    def wait(self, timeout=4):
        if not self._captured.wait(timeout):
            raise AssertionError('provider did not request held ' + self.method)
        return self

    def release(self):
        self._released.set()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.release()


class CodexObserver:
    """Read-only app-server fixture with independent clients and response gates.

    Existing tests may mutate states/turns/items directly. New scenarios can use
    set_turn() to change a turn atomically, hold() to pause exactly one response,
    and wait_for_request() to synchronize against actual observer activity.
    """

    def __init__(self, codex_home, sessions):
        self.ids = list(sessions)
        self.states = {session: 'idle' for session in self.ids}
        self.turns = {session: ('old-' + str(index), 'completed')
                      for index, session in enumerate(self.ids)}
        self.items = {}
        self.paths = {}
        self.names = {}
        self.children = []
        self.wait_items = []
        self.waiting = False
        self.child_error = False
        self.errors = []
        self.methods = []
        self.requests = []
        self._condition = threading.Condition()
        self._holds = []
        self._gates = []
        self._stopped = threading.Event()
        self._peers = []
        self._workers = []
        directory = pathlib.Path(codex_home, 'app-server-control')
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / 'app-server-control.sock'
        self._listener = socket.socket(socket.AF_UNIX)
        self._listener.bind(str(self.path))
        self._listener.listen()
        self._listener.settimeout(.2)
        self._acceptor = threading.Thread(target=self._serve, daemon=True)
        self._acceptor.start()

    def set_turn(self, session, turn, status, *, waiting=False, items=None):
        with self._condition:
            if session not in self.ids:
                self.ids.append(session)
            self.states[session] = 'active' if status == 'inProgress' else 'idle'
            self.turns[session] = (turn, status)
            if not isinstance(self.waiting, dict):
                self.waiting = {sid: self.waiting for sid in self.ids}
            self.waiting[session] = waiting
            if items is not None:
                self.items[session] = items

    def hold(self, method, session=None):
        """Hold the next matching reply after computing it from current state."""
        gate = HeldResponse(method, session)
        with self._condition:
            self._holds.append(gate)
            self._gates.append(gate)
        return gate

    def hold_turn(self, session, turn, status, **options):
        """Change a turn and gate its next reply atomically against polling."""
        with self._condition:
            self.set_turn(session, turn, status, **options)
            return self.hold('thread/turns/list', session)

    def wait_for_request(self, method, *, session=None, after=0, timeout=4):
        """Return the matching request index, for use as the next `after` value."""
        def match():
            for index in range(after, len(self.requests)):
                request = self.requests[index]
                if request['method'] == method and (session is None or request.get('params', {}).get('threadId') == session):
                    return index + 1
            return None
        with self._condition:
            index = self._condition.wait_for(match, timeout)
            if index is None:
                raise AssertionError('provider did not request ' + method)
            return index

    def close(self):
        self._stopped.set()
        self._listener.close()
        self._acceptor.join(3)
        for gate in self._gates:
            gate.release()
        for peer in self._peers:
            try:
                peer.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for worker in self._workers:
            worker.join(3)
        self.path.unlink(missing_ok=True)

    def _serve(self):
        while not self._stopped.is_set():
            try:
                peer, _ = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self._peers.append(peer)
            worker = threading.Thread(target=self._serve_peer, args=(peer,), daemon=True)
            self._workers.append(worker)
            worker.start()

    def _serve_peer(self, peer):
        try:
            header = b''
            while not header.endswith(b'\r\n\r\n'):
                header += _exact(peer, 1)
            key = next(line.split(b':', 1)[1].strip() for line in header.split(b'\r\n')
                       if line.lower().startswith(b'sec-websocket-key:'))
            accept = base64.b64encode(hashlib.sha1(key + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
            peer.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
            while not self._stopped.is_set():
                request = _receive(peer)
                with self._condition:
                    self.methods.append(request['method'])
                    self.requests.append(request)
                    self._condition.notify_all()
                    if request['method'] == 'initialized':
                        continue
                    response = self._response(request)
                    data = _frame(response)
                    gate = next((hold for hold in self._holds if hold.matches(request)), None)
                    if gate:
                        self._holds.remove(gate)
                        gate.request = request
                        # Deserialized copy prevents later fixture mutations from
                        # changing the reply that the scenario chose to delay.
                        gate.response = json.loads(json.dumps(response))
                        gate._captured.set()
                if gate:
                    gate._released.wait()
                if self._stopped.is_set():
                    return
                # Exercise frames split across separate socket writes.
                peer.sendall(data[:3])
                peer.sendall(data[3:])
        except (EOFError, BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            if not self._stopped.is_set():
                self.errors.append(repr(error))
        finally:
            peer.close()

    def _response(self, request):
        method = request['method']
        params = request.get('params', {})
        if method == 'initialize':
            result = {}
        elif method == 'thread/loaded/list':
            result = {'data': self.ids, 'nextCursor': None}
        elif method == 'thread/read':
            session = params['threadId']
            waiting = self.waiting.get(session, False) if isinstance(self.waiting, dict) else self.waiting
            result = {'thread': {'id': session, 'name': self.names.get(session, ''), 'path': self.paths.get(session, ''), 'status': {
                'type': self.states[session], 'activeFlags': ['waitingOnUserInput'] if waiting else []}}}
        elif method == 'thread/turns/list':
            session = params['threadId']
            turn, status = self.turns[session]
            result = {'data': [{'id': turn, 'status': status, 'items': self.items.get(session, [])}], 'nextCursor': None}
        elif method == 'thread/list':
            if params['sourceKinds'] != ['subAgent'] or not params['useStateDbOnly']:
                raise AssertionError('observer must request only subagents from state DB')
            offset = int(params.get('cursor') or 0)
            if offset and self.child_error:
                return {'id': request['id'], 'error': {'code': -32603, 'message': 'fixture page failed'}}
            result = {'data': self.children[offset:offset + 2],
                      'nextCursor': str(offset + 2) if offset + 2 < len(self.children) else None}
        elif method == 'thread/items/list':
            if params['sortDirection'] != 'desc':
                raise AssertionError('observer must request items newest first')
            offset = int(params.get('cursor') or 0)
            result = {'data': self.wait_items[offset:offset + 2],
                      'nextCursor': str(offset + 2) if offset + 2 < len(self.wait_items) else None}
        else:
            raise AssertionError('mutating or unexpected RPC ' + method)
        return {'id': request['id'], 'result': result}
