#!/usr/bin/env python3
"""PTY titles bind sessions; a read-only WebSocket observer supplies state."""
import base64, hashlib, json, os, pathlib, shlex, socket, struct, threading, time, unittest
import smoke
import tempfile
tempfile.tempdir="/tmp"

A='01901234-1234-1234-1234-123456789abc'
B='01911234-1234-1234-1234-123456789abc'
CLIENT='''#!/usr/bin/env python3
import sys,json
print('ARGS:'+json.dumps(sys.argv[1:]),flush=True)
def title(s): print('\\x1b]0;codex | '+s+'\\x07',end='',flush=True)
title("'''+A[:29]+'''...")
for line in sys.stdin:
    title(line.strip())
'''
def exact(peer,n):
    b=b''
    while len(b)<n:
        v=peer.recv(n-len(b))
        if not v:raise EOFError()
        b+=v
    return b

def receive(peer):
    h=exact(peer,2);n=h[1]&127
    if n==126:n=struct.unpack('!H',exact(peer,2))[0]
    elif n==127:n=struct.unpack('!Q',exact(peer,8))[0]
    mask=exact(peer,4) if h[1]&128 else bytes(4)
    data=exact(peer,n)
    return json.loads(bytes(v^mask[i%4] for i,v in enumerate(data)))

def frame(v):
    b=json.dumps(v).encode();n=len(b)
    return b'\x81'+(bytes([n]) if n<126 else b'\x7e'+struct.pack('!H',n))+b

class Titles(unittest.TestCase):
    run_cli=smoke.Runtime.run_cli
    rpc=smoke.Runtime.rpc
    raw_rpc=smoke.Runtime.raw_rpc
    until=smoke.Runtime.until
    def setUp(self):
        self.client=None;self.client_file=None;self.proc=None
        smoke.Runtime.setUp(self)
        self.errors=[];self.methods=[];self.stop=False;self.peers=[]
        self.items={};self.paths={}
        self.children=[];self.wait_items=[];self.child_error=False
        self.ids=[A,B];self.states={A:'idle',B:'idle'};self.turns={A:('old','completed'),B:('old-b','completed')};self.waiting=False
        directory=pathlib.Path(self.env['CODEX_HOME'],'app-server-control');directory.mkdir(parents=True)
        self.listener=socket.socket(socket.AF_UNIX);self.listener.bind(str(directory/'app-server-control.sock'));self.listener.listen();self.listener.settimeout(.2)
        self.worker=threading.Thread(target=self.serve,daemon=True);self.worker.start()
        fake=pathlib.Path(self.temp.name,'codex');fake.write_text(CLIENT);fake.chmod(0o700)
        self.pane=self.rpc(op='new',command=shlex.quote(str(fake))+' --dangerously-bypass-approvals-and-sandbox resume')['pane']
        self.until(lambda:self.state()['session']==A or self.errors)
        self.assertEqual(self.errors,[])
        self.rpc(op='new',command='sleep 60')
    def state(self):return next(p for p in self.rpc(op='list')['panes'] if p['id']==self.pane)
    def serve(self):
        while not self.stop:
            try:peer,_=self.listener.accept()
            except socket.timeout:continue
            except OSError:return
            self.peers.append(peer)
            try:
                peer.settimeout(2);header=b''
                while not header.endswith(b'\r\n\r\n'):header+=exact(peer,1)
                key=next(l.split(b':',1)[1].strip() for l in header.split(b'\r\n') if l.lower().startswith(b'sec-websocket-key:'))
                accept=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
                peer.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
                while not self.stop:
                    v=receive(peer);method=v['method'];self.methods.append(method)
                    if method=='initialized':continue
                    if method=='initialize':result={}
                    elif method=='thread/loaded/list':result={'data':self.ids,'nextCursor':None}
                    elif method=='thread/read':
                        sid=v['params']['threadId'];result={'thread':{'id':sid,'path':self.paths.get(sid,''),'status':{'type':self.states[sid],'activeFlags':['waitingOnUserInput'] if self.waiting else []}}}
                    elif method=='thread/turns/list':
                        sid=v['params']['threadId'];tid,status=self.turns[sid];result={'data':[{'id':tid,'status':status,'items':self.items.get(sid,[])}],'nextCursor':None}
                    elif method=='thread/list':
                        self.assertEqual(v['params']['sourceKinds'],['subAgent'])
                        self.assertTrue(v['params']['useStateDbOnly'])
                        offset=int(v['params'].get('cursor') or 0)
                        if offset and self.child_error:
                            peer.sendall(frame({'id':v['id'],'error':{'code':-32603,'message':'fixture page failed'}}));continue
                        result={'data':self.children[offset:offset+2], 'nextCursor':str(offset+2) if offset+2<len(self.children) else None}
                    elif method=='thread/items/list':
                        self.assertEqual(v['params']['sortDirection'],'desc')
                        offset=int(v['params'].get('cursor') or 0)
                        result={'data':self.wait_items[offset:offset+2], 'nextCursor':str(offset+2) if offset+2<len(self.wait_items) else None}
                    else:raise AssertionError('mutating or unexpected RPC '+method)
                    # Exercise a frame split across separate socket writes.
                    data=frame({'id':v['id'],'result':result})
                    peer.sendall(data[:3]);peer.sendall(data[3:])
            except (EOFError,BrokenPipeError,ConnectionResetError):pass
            except Exception as e:
                if not self.stop:self.errors.append(repr(e))
            finally:peer.close()
    def tearDown(self):
        self.stop=True;self.listener.close()
        for p in self.peers:
            try:p.shutdown(socket.SHUT_RDWR)
            except OSError:pass
        self.worker.join(3)
        smoke.Runtime.tearDown(self)
    def title(self,value):self.rpc(op='send',pane=self.pane,text=value,enter=True)
    def test_resume_passthrough_and_focus_completion(self):
        text=self.rpc(op='read',pane=self.pane)['text']
        self.assertIn('ARGS:["--dangerously-bypass-approvals-and-sandbox", "resume"]',text)
        self.assertNotIn('--remote',text)
        self.assertEqual(self.state()['completed'],0)
        self.states[A]='active';self.turns[A]=('new','inProgress')
        self.until(lambda:self.state()['state']=='working')
        self.waiting=True;self.until(lambda:self.state()['state']=='blocked')
        self.waiting=False;self.states[A]='idle';self.turns[A]=('new','completed')
        self.until(lambda:self.state()['completed']==1)
        time.sleep(1);self.assertEqual(self.state()['completed'],1)
        self.title(B[:29]+'...');self.until(lambda:self.state()['session']==B)
        self.assertEqual(self.state()['completed'],1)
        self.turns[A]=('unrelated','completed');time.sleep(1)
        self.assertEqual(self.state()['completed'],1)
        self.assertEqual(self.errors,[])
    def test_ambiguous_prefix_does_not_rebind(self):
        self.ids.append(B[:-3]+'def');self.title(B[:29]+'...');time.sleep(1.5)
        self.assertNotEqual(self.state()['session'],B)
        self.ids.pop();self.until(lambda:self.state()['session']==B)
    def test_missing_title_prevents_updates(self):
        self.title('shell');time.sleep(.7)
        self.turns[A]=('after-title-gone','completed');time.sleep(1)
        self.assertEqual(self.state()['completed'],0)

    def test_subagent_counts_waits_and_viewer_layout(self):
        from viewers import Viewer
        def child(ident,parent=A,status='active',flags=()):
            return {'id':ident,'parentThreadId':parent,'status':{'type':status,'activeFlags':list(flags)}}
        def wait(turn='new',status='inProgress',sender=A):
            return {'turnId':turn,'item':{'type':'collabAgentToolCall','tool':'wait','status':status,'senderThreadId':sender}}
        self.children=[child('c1'),child('c2'),child('old',status='idle'),child('unrelated',parent=B),child('c3',flags=['waitingOnApproval'])]
        self.states[A]='active';self.turns[A]=('new','inProgress')
        self.wait_items=[wait(turn='old'),wait(sender=B),wait()]
        expected={'running':2,'blocked':1,'waiting':True}
        self.until(lambda:self.state()['subagents']==expected)
        self.assertEqual(self.state()['activity'],'Waiting on agents')
        session=self.rpc(op='session.snapshot',protocol=1)
        self.assertEqual(next(p for p in session['panes'] if p['id']==self.pane)['agent']['subagents'],expected)
        self.viewers=[]
        viewer=Viewer(self)
        try:
            self.until(lambda:'↳2 !1' in viewer.poll()['data'])
            rows=smoke.screen_text(viewer.state['data'],100,30)
            line=next(i for i,r in enumerate(rows) if '↳2 !1' in r)
            self.assertIn('Waiting on',rows[line])
            self.assertEqual(rows[line][21:26],'↳2 !1')
            # Finishing/timing out the wait does not mean the children stopped.
            self.wait_items=[wait(status='completed')]
            expected['waiting']=False
            self.until(lambda:self.state()['subagents']==expected)
            self.until(lambda:'Waiting on agents' not in viewer.poll()['data'] and '◷' not in viewer.state['data'])
            self.children=[child('c1'),child('c2')]
            expected['blocked']=0
            self.until(lambda:self.state()['subagents']==expected)
            # Completion removes the badge entirely, without moving any rows.
            self.children=[child('c1',status='idle'),child('c2',status='idle')]
            self.until(lambda:self.state()['subagents']=={'running':0,'blocked':0,'waiting':False})
            self.until(lambda:'↳' not in viewer.poll()['data'])
            plain=smoke.screen_text(viewer.state['data'],100,30)
            self.assertEqual(rows[line-1],plain[line-1])
            # No children means no item-history queries in the common case.
            self.children=[]
            self.until(lambda:self.state()['subagents']['running']==0)
            time.sleep(.7);before=self.methods.count('thread/items/list')
            time.sleep(.7);self.assertEqual(self.methods.count('thread/items/list'),before)
        finally:viewer.close()
        self.assertEqual(self.errors,[])

    def test_partial_child_page_does_not_publish_partial_count_or_lose_completion(self):
        self.children=[{'id':str(i),'parentThreadId':A,'status':{'type':'active'}} for i in range(3)]
        self.until(lambda:self.state()['subagents']['running']==3)
        self.child_error=True
        self.turns[A]=('new','completed')
        self.until(lambda:self.state()['completed']==1 and self.state()['subagents']['running']==0)
        self.child_error=False
        self.until(lambda:self.state()['subagents']['running']==3)
        self.title(B[:29]+'...')
        self.until(lambda:self.state()['session']==B and self.state()['subagents']['running']==0)
        self.assertEqual(self.errors,[])

if __name__=='__main__':unittest.main()
