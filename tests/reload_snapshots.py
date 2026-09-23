#!/usr/bin/env python3
"""Large output volumes must not inflate live snapshots or lose PTY children."""
import json, os, pathlib, shlex, sys, unittest
import smoke
if os.environ.get('CORGI_TEST_EXE'):smoke.EXE=os.environ['CORGI_TEST_EXE']

class ReloadSnapshots(unittest.TestCase):
    setUp=smoke.Runtime.setUp
    tearDown=smoke.Runtime.tearDown
    run_cli=smoke.Runtime.run_cli
    rpc=smoke.Runtime.rpc
    command=smoke.Runtime.command
    open_pane=smoke.Runtime.open_pane
    session=smoke.Runtime.session
    until=smoke.Runtime.until
    def test_large_output_preserves_process_input_and_resize_recovery(self):
        self.check_reload(1, 1025)

    def test_multiple_noisy_panes_use_compact_snapshots(self):
        # Four panes each emit 50 MiB while retaining a small screen.
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
# Repeated carriage returns produce output without growing scrollback.
chunk=b'\\r'*65536
for _ in range(int(sys.argv[2])):
    rest=chunk
    while rest:rest=rest[os.write(1,rest):]
print('READY',os.getpid(),flush=True)
for line in sys.stdin:print('ALIVE',os.getpid(),line.strip(),flush=True)
''')
        panes=[]
        for _ in range(pane_count):
            pane=self.open_pane(command=f'exec {shlex.quote(sys.executable)} {shlex.quote(str(program))} {shlex.quote(str(sizes))} {chunks}')['pane']
            panes.append(pane)
            self.until(lambda:'READY' in self.command('pane.read', target=pane, view='screen')['text'],timeout=30)
        def text():return self.command('pane.read', target=pane, view='screen')['text']
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
        self.command('pane.input', target=pane, data=('still here') + '\r')
        self.until(lambda:f'ALIVE {pid} still here' in text())
        # A restored terminal can be captured and restored again.
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.command('pane.input', target=pane, data=('twice') + '\r')
        self.until(lambda:f'ALIVE {pid} twice' in text())

if __name__=='__main__':unittest.main(verbosity=2)
