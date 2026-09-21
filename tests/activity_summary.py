#!/usr/bin/env python3
"""Read-only Codex observation -> replaceable inference -> dedicated sidebar row."""
import json, os, pathlib, tempfile, time, unittest
from unittest.mock import patch
import codex_titles
import smoke

class Summaries(codex_titles.Titles):
    attach=smoke.Runtime.attach
    write=smoke.Runtime.write
    message=smoke.Runtime.message
    get_type=smoke.Runtime.get_type
    frame_with=smoke.Runtime.frame_with
    def setUp(self):
        self.backend_dir=tempfile.TemporaryDirectory(prefix='corgi-summary-')
        root=pathlib.Path(self.backend_dir.name)
        self.log=root/'calls.jsonl'
        self.control=root/'control.json'
        self.control.write_text(json.dumps({'delay':0,'label':'Tracing pane focus'}))
        program=root/'worker'
        program.write_text('''#!/usr/bin/env python3
import json,sys,time,pathlib
payload=json.load(sys.stdin)
with open('''+repr(str(self.log))+''','a') as f:f.write(json.dumps(payload)+'\\n')
control=json.loads(pathlib.Path('''+repr(str(self.control))+''').read_text())
time.sleep(control['delay'])
print(control['label'],flush=True)
''')
        program.chmod(0o700)
        with patch.dict(os.environ,{'CORGI_SUMMARY_COMMAND':str(program)}):super().setUp()
    def tearDown(self):
        try:super().tearDown()
        finally:self.backend_dir.cleanup()
    def start_turn(self,tid='active'):
        self.items[codex_titles.A]=[
            {'type':'userMessage','content':[{'type':'text','text':'Fix terminal focus'}]},
            {'type':'agentMessage','text':'I am tracing pane focus changes.'}]
        self.states[codex_titles.A]='active';self.turns[codex_titles.A]=(tid,'inProgress')
    def test_summary_second_row_and_unchanged_input(self):
        self.rpc(op='pane.rename',protocol=1,pane=self.pane,name='A deliberately long agent name')
        self.start_turn()
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.attach()
        screen=self.frame_with('Tracing pane focus')
        self.assertIn('A deliberately long',screen[13][:27])
        self.assertNotIn('Tracing',screen[13][:27])
        self.assertIn('Tracing pane focus',screen[14][:27])
        self.assertNotIn('agent name',screen[14][:27])
        payload=json.loads(self.log.read_text().splitlines()[0])
        self.assertEqual(payload['provider'],'codex')
        self.assertIn('tracing pane focus',payload['evidence'])
        time.sleep(1.2)
        self.assertEqual(len(self.log.read_text().splitlines()),1)
        self.states[codex_titles.A]='idle';self.turns[codex_titles.A]=('active','completed')
        self.until(lambda:self.state()['activity']=='◡‿◡')
        self.frame_with('◡‿◡',row=14)
    def test_late_result_after_completion_is_discarded(self):
        self.control.write_text(json.dumps({'delay':1.5,'label':'Old stale activity'}))
        self.start_turn()
        self.until(lambda:self.log.exists())
        self.states[codex_titles.A]='idle';self.turns[codex_titles.A]=('active','completed')
        self.until(lambda:self.state()['activity']=='◡‿◡')
        time.sleep(1.8)
        self.assertEqual(self.state()['activity'],'◡‿◡')
    def test_bad_backend_output_falls_back_without_retry_loop(self):
        self.control.write_text(json.dumps({'delay':0,'label':'This is much too many words'}))
        self.start_turn()
        self.until(lambda:self.log.exists())
        time.sleep(1.0)
        self.assertEqual(self.state()['activity'],'')
        self.attach()
        screen=self.frame_with('codex',row=13)
        self.assertEqual(screen[14][4:27].strip(),'')
        self.assertEqual(len(self.log.read_text().splitlines()),1)

if __name__=='__main__':unittest.main()
