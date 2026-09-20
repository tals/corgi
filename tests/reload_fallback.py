#!/usr/bin/env python3
"""Overflow the actual replay budget; live handoff must keep the PTY child alive."""
import json, os, pathlib, shlex, sys, unittest
import smoke
if os.environ.get('CORGI_TEST_EXE'):smoke.EXE=os.environ['CORGI_TEST_EXE']

class ReloadFallback(unittest.TestCase):
    setUp=smoke.Runtime.setUp
    tearDown=smoke.Runtime.tearDown
    run_cli=smoke.Runtime.run_cli
    rpc=smoke.Runtime.rpc
    session=smoke.Runtime.session
    until=smoke.Runtime.until
    def test_exhausted_journal_preserves_process_input_and_resize_recovery(self):
        sizes=pathlib.Path(self.temp.name,'sizes.jsonl')
        program=pathlib.Path(self.temp.name,'terminal.py')
        program.write_text('''import json,os,signal,sys
log=sys.argv[1]
def resized(*_):
    size=os.get_terminal_size(0)
    with open(log,'a') as f:f.write(json.dumps([size.columns,size.lines])+'\\n')
signal.signal(signal.SIGWINCH,resized)
# Repeated carriage returns exhaust the 64 MiB journal without huge scrollback.
chunk=b'\\r'*65536
for _ in range(1025):
    rest=chunk
    while rest:rest=rest[os.write(1,rest):]
print('READY',os.getpid(),flush=True)
for line in sys.stdin:print('ALIVE',os.getpid(),line.strip(),flush=True)
''')
        pane=self.rpc(op='new',command=f'exec {shlex.quote(sys.executable)} {shlex.quote(str(program))} {shlex.quote(str(sizes))}')['pane']
        def text():return self.rpc(op='read',pane=pane)['text']
        self.until(lambda:'READY' in text(),timeout=30)
        before=self.session();pid=next(p['pid'] for p in before['panes'] if p['id']==pane)
        geometry=next(p for p in before['panes'] if p['id']==pane)
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        after=self.session()
        self.assertNotEqual(before['server_pid'],after['server_pid'])
        self.assertEqual(next(p['pid'] for p in after['panes'] if p['id']==pane),pid)
        def events():return [json.loads(s) for s in sizes.read_text().splitlines()] if sizes.exists() else []
        self.until(lambda:len(events())>=2)
        self.assertEqual(events()[-2:],[[geometry['cols']-1,geometry['rows']],[geometry['cols'],geometry['rows']]])
        self.assertIn('READY',text())
        self.rpc(op='send',pane=pane,text='still here',enter=True)
        self.until(lambda:f'ALIVE {pid} still here' in text())
        # The compact snapshot starts a new valid journal for subsequent reloads.
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.rpc(op='send',pane=pane,text='twice',enter=True)
        self.until(lambda:f'ALIVE {pid} twice' in text())

if __name__=='__main__':unittest.main(verbosity=2)
