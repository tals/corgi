#!/usr/bin/env python3
"""Read-only Codex observation -> replaceable inference -> dedicated sidebar row."""
import json, os, pathlib, tempfile, time, unittest, datetime
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
        program=pathlib.Path(__file__).with_name('inference_harness.py').resolve()
        self.transcript=root/'activity.jsonl'
        self.transcript.write_text(json.dumps({'type':'session_meta','payload':{'id':codex_titles.A}})+'\n')
        self.tool_index=0
        with patch.dict(os.environ,{'CORGI_INFERENCE_PROVIDER':'codex','CORGI_INFERENCE_BIN':str(program),'CORGI_INFERENCE_TEST_LOG':str(self.log),'CORGI_INFERENCE_TEST_CONTROL':str(self.control)}):super().setUp()
        self.paths[codex_titles.A]=str(self.transcript)
        time.sleep(.8) # Allow the transcript reader to seed its initial baseline.
    def tearDown(self):
        try:super().tearDown()
        finally:self.backend_dir.cleanup()
    def start_turn(self,tid='active',wave=True):
        self.items[codex_titles.A]=[
            {'type':'userMessage','content':[{'type':'text','text':'Fix terminal focus'}]},
            {'type':'agentMessage','text':'I am tracing pane focus changes.'}]
        self.states[codex_titles.A]='active';self.turns[codex_titles.A]=(tid,'inProgress')
        self.append_record('event_msg',{'type':'task_started','turn_id':tid})
        self.until(lambda:self.state()['state']=='working')
        if wave:self.tools(3)
    def append_record(self,kind,payload):
        with self.transcript.open('a') as f:
            f.write(json.dumps({'type':kind,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'payload':payload})+'\n')
    def tools(self,n,command='rg focus src',complete=True):
        ids=[]
        for _ in range(n):
            self.tool_index+=1;ident=f'call-{self.tool_index}';ids.append(ident)
            self.append_record('response_item',{'type':'function_call','call_id':ident,'name':'exec_command','arguments':json.dumps({'cmd':command})})
            if complete:self.finish_tool(ident)
        return ids
    def finish_tool(self,ident):
        self.append_record('response_item',{'type':'function_call_output','call_id':ident,'output':'result'})
    def calls(self):return self.log.read_text().splitlines() if self.log.exists() else []
    def test_first_wave_waits_for_completions_and_duplicates_do_not_count(self):
        self.start_turn(wave=False)
        time.sleep(.5);self.assertEqual(self.calls(),[])
        ids=self.tools(3,complete=False)
        time.sleep(.5);self.assertEqual(self.calls(),[])
        self.finish_tool(ids[0]);self.finish_tool(ids[0]);self.finish_tool(ids[1])
        time.sleep(.5);self.assertEqual(self.calls(),[])
        self.finish_tool(ids[2])
        self.until(lambda:len(self.calls())==1)
        self.assertIn('rg focus src',json.loads(self.calls()[0])['evidence'])
    def test_later_wave_refreshes_under_throttle_even_when_commentary_is_unchanged(self):
        self.start_turn()
        self.until(lambda:len(self.calls())==1)
        first=time.monotonic()
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.control.write_text(json.dumps({'delay':0,'label':'Testing pane focus'}))
        self.tools(3,command='zig build test')
        time.sleep(1)
        self.assertEqual(len(self.calls()),1)
        self.until(lambda:len(self.calls())==2,timeout=24)
        self.assertGreater(time.monotonic()-first,18)
        self.assertEqual(len(pathlib.Path(str(self.log)+'.processes').read_text().splitlines()),1)
        self.until(lambda:self.state()['activity']=='Testing pane focus')
        self.assertIn('zig build test',json.loads(self.calls()[1])['evidence'])
    def test_new_turn_needs_its_own_wave(self):
        self.start_turn()
        self.until(lambda:len(self.calls())==1)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.start_turn(tid='second',wave=False)
        self.until(lambda:self.state()['activity']=='')
        self.tools(2)
        time.sleep(1)
        self.assertEqual(len(self.calls()),1)
    def test_watched_workspace_still_collects_tools(self):
        self.attach()
        self.rpc(op='focus',pane=self.pane)
        self.start_turn()
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.assertEqual(len(self.calls()),1)
    def test_summary_second_row_and_unchanged_input(self):
        self.command('pane.rename', name='A deliberately long agent name', target=self.pane)
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
        self.until(lambda:self.state()['state']=='idle')
        self.assertEqual(self.state()['activity'],'')
        screen=self.frame_with('ᐯ',row=14)
        self.assertNotIn('Tracing pane focus',screen[14][:27])
    def test_late_result_after_completion_is_discarded(self):
        self.control.write_text(json.dumps({'delay':1.5,'label':'Old stale activity'}))
        self.start_turn()
        self.until(lambda:self.log.exists())
        self.states[codex_titles.A]='idle';self.turns[codex_titles.A]=('active','completed')
        self.until(lambda:self.state()['state']=='idle')
        self.assertEqual(self.state()['activity'],'')
        time.sleep(1.8)
        self.assertEqual(self.state()['activity'],'')
    def test_bad_backend_output_falls_back_without_retry_loop(self):
        self.control.write_text(json.dumps({'delay':0,'label':'This is much too many words'}))
        self.start_turn()
        self.until(lambda:self.log.exists())
        time.sleep(1.0)
        self.assertEqual(self.state()['activity'],'')
        self.attach()
        screen=self.frame_with('codex',row=13)
        self.assertTrue(screen[14][4:27].strip())
        self.assertNotIn('This is much too many words','\n'.join(screen))
        self.assertEqual(len(self.log.read_text().splitlines()),1)

if __name__=='__main__':unittest.main()
