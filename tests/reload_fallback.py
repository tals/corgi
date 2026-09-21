#!/usr/bin/env python3
"""Large output journals must not inflate live snapshots or lose PTY children."""
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
        self.check_reload(1, 1025)

    def test_combined_journals_over_manifest_limit_use_compact_snapshots(self):
        # Each 50 MiB journal is valid, but four base64 journals exceed 256 MiB.
        self.check_reload(4, 800)

    def check_reload(self, pane_count, chunks):
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
for _ in range(int(sys.argv[2])):
    rest=chunk
    while rest:rest=rest[os.write(1,rest):]
print('READY',os.getpid(),flush=True)
for line in sys.stdin:print('ALIVE',os.getpid(),line.strip(),flush=True)
''')
        panes=[]
        for _ in range(pane_count):
            pane=self.rpc(op='new',command=f'exec {shlex.quote(sys.executable)} {shlex.quote(str(program))} {shlex.quote(str(sizes))} {chunks}')['pane']
            panes.append(pane)
            self.until(lambda:'READY' in self.rpc(op='read',pane=pane)['text'],timeout=30)
        def text():return self.rpc(op='read',pane=pane)['text']
        before=self.session();pid=next(p['pid'] for p in before['panes'] if p['id']==pane)
        geometry=next(p for p in before['panes'] if p['id']==pane)
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        after=self.session()
        self.assertNotEqual(before['server_pid'],after['server_pid'])
        self.assertEqual([(p['id'],p['pid']) for p in before['panes']],[(p['id'],p['pid']) for p in after['panes']])
        self.assertEqual(next(p['pid'] for p in after['panes'] if p['id']==pane),pid)
        def events():return [json.loads(s) for s in sizes.read_text().splitlines()] if sizes.exists() else []
        self.until(lambda:len(events())>=2*pane_count)
        if pane_count == 1:
            self.assertEqual(events()[-2:],[[geometry['cols']-1,geometry['rows']],[geometry['cols'],geometry['rows']]])
        self.assertIn('READY',text())
        self.rpc(op='send',pane=pane,text='still here',enter=True)
        self.until(lambda:f'ALIVE {pid} still here' in text())
        # The compact snapshot starts a new valid journal for subsequent reloads.
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.rpc(op='send',pane=pane,text='twice',enter=True)
        self.until(lambda:f'ALIVE {pid} twice' in text())

if __name__=='__main__':unittest.main(verbosity=2)
