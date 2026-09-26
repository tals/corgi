#!/usr/bin/env python3
"""Read-only Codex observation -> replaceable inference -> dedicated sidebar row."""
import json, os, pathlib, tempfile, time, unittest, datetime, re
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
    def summary_logs(self):
        prefix='info(activity_summary): '
        lines=pathlib.Path(self.temp.name,'server.log').read_text().splitlines()
        return [json.loads(line[len(prefix):]) for line in lines if line.startswith(prefix)]
    def test_tool_icon_survives_polls_and_tracks_yielded_background_build(self):
        self.start_turn(wave=False)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        call=self.tools(1,command='zig build',complete=False)[0]
        self.until(lambda:self.state()['tool_active'])
        time.sleep(1.2)
        self.assertTrue(self.state()['tool_active'])
        # A yielded command has completed its tool call but its build still runs.
        self.sim.background_tasks={codex_titles.A:[{'processId':'build-1','command':'zig build'}]}
        self.until(lambda:next(c for c in self.session()['conversations'] if c['agent']['session']==codex_titles.A)['background_tasks']['items'])
        self.finish_tool(call)
        time.sleep(1.2)
        self.assertTrue(self.state()['tool_active'])
        self.until(lambda:any('Currently running background tasks:\nBuilding project' in json.loads(call)['evidence'] for call in self.calls()),timeout=12)
        from viewer_client import Viewer
        viewer=Viewer(self,100,30)
        try:self.until(lambda:'🔧' in viewer.poll()['data'])
        finally:viewer.close()
        self.sim.background_tasks={}
        self.until(lambda:not self.state()['tool_active'])
        # Another foreground call must clear independently when it finishes.
        call=self.tools(1,complete=False)[0]
        self.until(lambda:self.state()['tool_active'])
        self.finish_tool(call)
        self.until(lambda:not self.state()['tool_active'])
    def test_summary_log_records_exact_request_and_output(self):
        raw='  "Tracing pane focus"\n'
        self.control.write_text(json.dumps({'delay':0,'label':raw}))
        self.start_turn(wave=False)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        records=self.summary_logs()
        request=next(r for r in records if r['event']=='request')
        result=next(r for r in records if r['event']=='result')
        self.assertEqual(request['input'],self.calls()[0])
        self.assertIn('2 or 3 words',request['instructions'])
        self.assertEqual(request['context'],result['context'])
        self.assertEqual(request['context']['source']['panes'],[self.pane])
        self.assertEqual(request['context']['source']['session'],codex_titles.A)
        self.assertEqual(request['context']['turn'],'active')
        self.assertEqual(json.loads(result['output']),{'label':raw})
        self.assertEqual(result['status'],'validated')
    def test_summary_log_identifies_inference_error(self):
        self.control.write_text(json.dumps({'delay':0,'fail':True}))
        self.start_turn(wave=False)
        self.until(lambda:any(r['event']=='result' for r in self.summary_logs()))
        request,result=self.summary_logs()[:2]
        self.assertEqual(request['context'],result['context'])
        self.assertEqual(request['input'],self.calls()[0])
        self.assertEqual(result['context']['source']['panes'],[self.pane])
        self.assertEqual((result['status'],result['err']),('inference_error','InferenceFailed'))
        self.assertIsNone(result['output'])
        self.assertEqual(self.state()['activity'],'')
    def test_short_summary_is_usable_without_retry(self):
        for i,label in enumerate(['Tracing tool activity code','Inspecting logs and summary behavior','Checking tool calls and background builds']):
            self.control.write_text(json.dumps({'delay':0,'label':label}))
            self.start_turn(tid=f'concise-{i}',wave=False)
            self.until(lambda:self.state()['activity']==label)
            result=[r for r in self.summary_logs() if r['event']=='result'][-1]
            self.assertEqual((result['status'],json.loads(result['output'])['label']),('validated',label))
            time.sleep(1)
            self.assertEqual(len(self.calls()),i+1)
    def test_compaction_overrides_current_activity_and_remains_in_timeline(self):
        from viewer_client import Viewer
        def conversation():
            return next(c for c in self.session()['conversations'] if c['agent']['session']==codex_titles.A)
        def points():return [p['activity'] for p in conversation()['timeline']['points']]
        self.start_turn(wave=False)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.attachment.send('screen:compacting')
        self.until(lambda:self.state()['compacting'])
        self.assertEqual(points(),['Tracing pane focus','Compacting context'])
        # Repeated protocol polls must preserve the terminal-only compaction.
        time.sleep(1.2)
        self.assertTrue(self.state()['compacting'])
        viewer=Viewer(self,100,30)
        try:
            frame=viewer.poll()['data']
            rows=smoke.screen_text(re.sub(r'\x1b_G.*?\x1b\\','',frame),100,30)
            y=next(i for i,row in enumerate(rows) if i>15 and 'codex' in row)
            viewer.input(f'\x1b[<35;6;{y+1}M')
            time.sleep(.6)
            def timeline_rows():
                frame=viewer.poll()['data']
                return smoke.screen_text(re.sub(r'\x1b_G.*?\x1b\\','',frame),100,30)
            rows=timeline_rows()
            self.assertTrue(any('now  ●  Compacting context' in row for row in rows),rows)
            self.assertFalse(any('now  ●  Tracing pane focus' in row for row in rows),rows)
            self.attachment.send('screen:working')
            self.until(lambda:not self.state()['compacting'])
            self.assertEqual(points(),['Tracing pane focus','Compacting context','Tracing pane focus'])
            rows=timeline_rows()
            self.assertTrue(any('○  Compacting context' in row for row in rows),rows)
            self.assertTrue(any('now  ●  Tracing pane focus' in row for row in rows),rows)
        finally:viewer.close()
    def test_compaction_clears_after_live_reload_while_the_same_turn_keeps_working(self):
        def conversation():
            return next(c for c in self.session()['conversations'] if c['agent']['session']==codex_titles.A)
        def points():return [p['activity'] for p in conversation()['timeline']['points']]
        self.start_turn(wave=False)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.attachment.send('screen:compacting')
        self.until(lambda:self.state()['compacting'])
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.until(lambda:self.state()['compacting'] and points()==['Compacting context'])
        self.attachment.send('screen:working')
        self.until(lambda:not self.state()['compacting'])
        self.assertEqual(self.state()['state'],'working')
        self.assertEqual(points(),['Compacting context','Tracing pane focus'])
    def test_activity_timeline_tracks_intervals_and_preserves_own_breakdown(self):
        from viewer_client import Viewer
        def conversation():
            return next(c for c in self.session()['conversations'] if c['agent']['session']==codex_titles.A)
        total=[0,0,0]
        def spend(values):
            for i,value in enumerate(values):total[i]+=value
            def tokens(v):return dict(input_tokens=v[0],cached_input_tokens=v[1],output_tokens=v[2])
            self.append_record('event_msg',dict(type='token_count',info=dict(total_token_usage=tokens(total),last_token_usage=tokens(values))))
            self.until(lambda:conversation()['usage']['tokens']['input']==total[0])
        for i,(label,values) in enumerate([
            ('Reading source',(1000,600,200)),
            ('Tracing usage',(4500,3000,900)),
            ('Running tests',(6000,4000,1600)),
        ]):
            self.control.write_text(json.dumps({'delay':0,'label':label}))
            self.start_turn(tid=f'timeline-{i}',wave=False)
            self.until(lambda:len(conversation()['timeline']['points'])==i+1)
            spend(values)
        spend((400,200,100))
        self.until(lambda:self.session()['system_usage']['tokens']['input']==3000)
        self.assertEqual(self.session()['system_model'],'gpt-6-luna')
        self.assertEqual(self.session()['system_usage']['tokens'],dict(input=3000,cached_input=1800,output=30))
        points=conversation()['timeline']['points']
        self.assertEqual([p['usage']['tokens']['input']+p['usage']['tokens']['output'] for p in points],[1200,5400,0])
        self.assertEqual([p['activity'] for p in points],['Reading source','Tracing usage','Running tests'])
        self.assertEqual(sorted(p['at'] for p in points),[p['at'] for p in points])
        self.assertTrue(all(p['usage']['known'] and not p['usage']['partial'] for p in points))
        self.assertEqual(conversation()['timeline']['pending']['tokens']['input'],6400)
        self.viewers=[]
        viewer=Viewer(self,100,30)
        def hover(cols,rows):
            screen=smoke.screen_text(viewer.poll()['data'],cols,rows)
            y=next(i for i,row in enumerate(screen) if i>rows//2 and 'codex' in row)
            viewer.input(f'\x1b[<35;6;{y+1}M')
            time.sleep(.6)
            return viewer.poll()['data']
        try:
            frame=hover(100,30)
            for text in ['Total','Tokens','Cached','6.9k','7.8k','Recent','Running tests']:
                self.assertIn(text,frame)
            # Timeline columns match the overview: Tokens is uncached input
            # plus output, and Cached is cached input, for every provider.
            rows=smoke.screen_text(re.sub(r'\x1b_G.*?\x1b\\','',frame),100,30)
            # The sidebar can show the same label; timeline rows carry a marker.
            def timeline_row(label):return next(row for row in rows if label in row and ('○' in row or '●' in row))
            self.assertEqual(sum('Tokens' in row and 'Cached' in row for row in rows),1)
            self.assertRegex(next(row for row in rows if 'Total' in row),r'Total\s+6\.9k\s+7\.8k')
            self.assertRegex(timeline_row('Reading source'),r'Reading source\s+600\s+600')
            self.assertRegex(timeline_row('Tracing usage'),r'Tracing usage\s+2\.4k\s+3(\.0)?k')
            self.assertRegex(timeline_row('Running tests'),r'Running tests\s+3\.9k\+\s+4\.2k\+')
            positions=[next(i for i,row in enumerate(rows) if label in row and ('○' in row or '●' in row)) for label in ['Reading source','Tracing usage','Running tests']]
            self.assertEqual(positions,list(range(positions[0],positions[0]+3)))
            pathlib.Path('/tmp/corgi-timeline-frame.json').write_text(json.dumps(dict(cols=100,rows=30,frame=frame)))
            # The Corgi badge separates background inference from agent spend.
            viewer.request(op='badge',visible=True)
            viewer.input('\x1b[<35;3;1M')
            time.sleep(.6)
            overview=viewer.poll()['data']
            for text in ['Corgi (Activity summarizer)','Top agents','Model','Tokens','Cached','8.1k tokens (+9.6k cached)']:
                self.assertIn(text,overview)
            # Decode rows after removing Kitty image commands. Cached input is
            # shown separately from input-minus-cache plus output in this table.
            rows=smoke.screen_text(re.sub(r'\x1b_G.*?\x1b\\','',overview),100,30)
            system_row=next(row for row in rows if 'Corgi (Activity summarizer)' in row)
            agent_row=next(row for row in rows if 'codex ·' in row)
            self.assertRegex(system_row,r'Corgi \(Activity summarizer\)\s+◆ gpt-6-luna\s+1\.2k\s+1\.8k\s+1\.2k')
            self.assertRegex(agent_row,r'codex · \S+\s+—\s+6\.9k\s+7\.8k')
            self.assertNotIn('tracked sessions',overview)
            pathlib.Path('/tmp/corgi-overview-frame.json').write_text(json.dumps(dict(cols=100,rows=30,frame=overview)))
            viewer.request(op='badge',visible=False)
            frame=hover(100,30)
            # Viewing repeatedly never consumes the pending interval.
            viewer.poll();viewer.poll()
            self.assertEqual(conversation()['timeline']['pending']['tokens']['input'],6400)
            self.states[codex_titles.A]='idle';self.turns[codex_titles.A]=('timeline-2','completed')
            self.until(lambda:self.state()['state']=='idle')
            frame=viewer.poll()['data']
            self.assertIn(' last',frame)
            self.assertNotIn('3.9k+',frame)
            self.assertEqual(len(conversation()['timeline']['points']),3)
            viewer.request(op='size',cols=64,rows=13)
            viewer.input('\x1b[<35;63;1M')
            small=hover(64,13)
            for text in ['Total','6.9k','7.8k','Recent','Running tests']:self.assertIn(text,small)
            self.assertNotIn('Own usage',small)
        finally:viewer.close()
    def test_commentary_fires_without_tools_and_one_completion_refreshes(self):
        self.start_turn(wave=False)
        self.until(lambda:len(self.calls())==1)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.assertIn('tracing pane focus',json.loads(self.calls()[0])['evidence'])
        ids=self.tools(1,complete=False)
        self.finish_tool(ids[0]);self.finish_tool(ids[0])
        self.until(lambda:len(self.calls())==2,timeout=12)
        self.assertIn('rg focus src',json.loads(self.calls()[1])['evidence'])
        time.sleep(8.5)
        self.assertEqual(len(self.calls()),2)
    def test_running_command_refreshes_before_completion_without_repeated_inference(self):
        self.start_turn(wave=False)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.control.write_text(json.dumps({'delay':0,'label':'Running smoke tests'}))
        self.tools(1,command='python3 tests/smoke.py --long-running',complete=False)
        self.until(lambda:self.state()['activity']=='Running smoke tests',timeout=12)
        evidence=json.loads(self.calls()[-1])['evidence']
        self.assertIn('Currently running tools',evidence)
        self.assertIn('python3 tests/smoke.py',evidence)
        count=len(self.calls())
        time.sleep(8.5)
        self.assertEqual(len(self.calls()),count)
    def test_later_wave_refreshes_under_throttle_even_when_commentary_is_unchanged(self):
        self.start_turn()
        self.until(lambda:len(self.calls())==1)
        first=time.monotonic()
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.control.write_text(json.dumps({'delay':0,'label':'Testing pane focus'}))
        self.tools(3,command='zig build test')
        time.sleep(1)
        self.assertEqual(len(self.calls()),1)
        self.until(lambda:len(self.calls())==2,timeout=12)
        self.assertGreater(time.monotonic()-first,6)
        self.assertEqual(len(pathlib.Path(str(self.log)+'.processes').read_text().splitlines()),1)
        self.until(lambda:self.state()['activity']=='Testing pane focus')
        self.assertIn('zig build test',json.loads(self.calls()[1])['evidence'])
    def test_new_turn_reuses_actor_conversation_without_waiting_for_tools(self):
        self.start_turn(wave=False)
        self.until(lambda:len(self.calls())==1)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.start_turn(tid='second',wave=False)
        self.until(lambda:len(self.calls())==2)
        second=json.loads(self.calls()[1])
        self.assertEqual(second['turn'],'second')
        self.assertEqual(second['previous'],'Tracing pane focus')
        self.assertIn('Tracing pane focus',second['history'][0])
        sessions=[json.loads(line) for line in pathlib.Path(str(self.log)+'.sessions').read_text().splitlines()]
        self.assertEqual(sessions[0]['pid'],sessions[1]['pid'])
        self.assertEqual(sessions[0]['thread'],sessions[1]['thread'])
        self.assertEqual(sessions[1]['turn'],2)
    def test_setup_switches_provider_persists_choice_and_auto_follows_agents(self):
        status=self.session()['inference']
        self.assertEqual((status['choice'],status['provider'],status['model']),('codex','codex','gpt-6-luna'))
        self.start_turn(wave=False)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.until(lambda:self.session()['inference']['locked'])
        reply=self.rpc(op='inference.configure',protocol=1,choice='claude')
        self.assertTrue(reply['saved'])
        self.assertEqual((reply['inference']['provider'],reply['inference']['locked']),('claude',False))
        self.assertEqual(json.loads(pathlib.Path(self.path+'.settings.json').read_text()),{'inference':'claude'})
        self.assertEqual(self.session()['system_model'],'claude-haiku-4-5-20251001')
        self.control.write_text(json.dumps({'delay':0,'label':'Running tests'}))
        self.start_turn(tid='after-switch',wave=False)
        self.until(lambda:self.state()['activity']=='Running tests')
        # The Codex harness was stopped and a Claude harness answered.
        self.assertEqual(len(pathlib.Path(str(self.log)+'.processes').read_text().splitlines()),2)
        self.assertEqual(self.rpc(op='inference.configure',protocol=1,choice='off')['inference']['provider'],None)
        # The pane runs a Codex agent, so automatic selection follows it.
        status=self.rpc(op='inference.configure',protocol=1,choice='auto')['inference']
        self.assertEqual((status['choice'],status['provider']),('auto','codex'))
        self.assertGreaterEqual(status['codex_launches'],1)
        self.assertEqual(status['claude_launches'],0)
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
        actor=next(c for c in self.session()['conversations'] if c['agent']['session']==codex_titles.A)
        self.assertEqual(actor['timeline']['points'],[])
    def test_bad_backend_output_falls_back_without_retry_loop(self):
        self.control.write_text(json.dumps({'delay':0,'label':'This label has far too many words'}))
        self.start_turn()
        self.until(lambda:self.log.exists())
        time.sleep(1.0)
        self.assertEqual(self.state()['activity'],'')
        self.attach()
        screen=self.frame_with('codex',row=13)
        self.assertTrue(screen[14][4:27].strip())
        self.assertNotIn('This label has far too many words','\n'.join(screen))
        self.assertEqual(len(self.log.read_text().splitlines()),1)
        records=self.summary_logs()
        request=next(r for r in records if r['event']=='request')
        result=next(r for r in records if r['event']=='result')
        self.assertEqual(request['input'],self.calls()[0])
        self.assertEqual(result['context'],request['context'])
        self.assertEqual(result['context']['source']['panes'],[self.pane])
        self.assertEqual(json.loads(result['output'])['label'],'This label has far too many words')
        self.assertEqual((result['status'],result['err']),('rejected','InvalidWordCount'))

    def test_abstention_waits_for_evidence_without_failure_backoff(self):
        self.control.write_text(json.dumps({'label':None}))
        self.start_turn(wave=False)
        self.until(lambda:any(r.get('status')=='abstained' for r in self.summary_logs()))
        self.assertEqual(self.state()['activity'],'')
        self.assertEqual(self.state()['state'],'working')
        time.sleep(9)
        self.assertEqual(len(self.calls()),1) # unchanged evidence is not queried again
        self.control.write_text(json.dumps({'label':'Fixing cursor visibility'}))
        self.items[codex_titles.A][-1]['text']='I am fixing cursor visibility.'
        self.until(lambda:self.state()['activity']=='Fixing cursor visibility',timeout=12)
        self.assertEqual(len(self.calls()),2) # no 60-second error retry delay

    def test_abstention_clears_stale_activity_without_changing_lifecycle(self):
        self.start_turn(wave=False)
        self.until(lambda:self.state()['activity']=='Tracing pane focus')
        self.control.write_text(json.dumps({'label':None}))
        self.items[codex_titles.A]=[{'type':'userMessage','content':[{'type':'text','text':'continue'}]}]
        self.until(lambda:any(r.get('status')=='abstained' for r in self.summary_logs()),timeout=12)
        self.until(lambda:self.state()['activity']=='')
        self.assertEqual(self.state()['state'],'working')
        self.assertEqual(self.state()['attention'],'none')


class ClaudeSummaries(unittest.TestCase):
    """Claude hooks and transcript evidence feed the same labeller and timeline."""
    rpc=smoke.Runtime.rpc
    raw_rpc=smoke.Runtime.raw_rpc
    command=smoke.Runtime.command
    until=smoke.Runtime.until
    session=smoke.Runtime.session
    run_cli=smoke.Runtime.run_cli
    def setUp(self):
        self.backend_dir=tempfile.TemporaryDirectory(prefix='corgi-summary-')
        root=pathlib.Path(self.backend_dir.name)
        self.log=root/'calls.jsonl'
        self.control=root/'control.json'
        self.control.write_text(json.dumps({'delay':0,'label':'Tracing hook routing'}))
        program=pathlib.Path(__file__).with_name('inference_harness.py').resolve()
        with patch.dict(os.environ,{'CORGI_INFERENCE_PROVIDER':'codex','CORGI_INFERENCE_BIN':str(program),'CORGI_INFERENCE_TEST_LOG':str(self.log),'CORGI_INFERENCE_TEST_CONTROL':str(self.control)}):smoke.Runtime.setUp(self)
        self.pane=self.command('pane.create',workspace=1,command='sleep 60')['pane']
        self.transcript=root/'claude.jsonl'
        self.transcript.write_text('')
        self.seq=time.time_ns()//1000
    def tearDown(self):
        try:smoke.Runtime.tearDown(self)
        finally:self.backend_dir.cleanup()
    def hook(self,event,**extra):
        self.seq=max(self.seq+1,time.time_ns()//1000)
        return self.rpc(op='hook',pane=self.pane,provider='claude',seq=self.seq,event={'hook_event_name':event,'session_id':'claude-s','prompt_id':'prompt-1','transcript_path':str(self.transcript),**extra})
    def record(self,**fields):
        stamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        with self.transcript.open('a') as f:f.write(json.dumps({'sessionId':'claude-s','timestamp':stamp,**fields})+'\n')
    def agent(self):
        return next(p for p in self.session()['panes'] if p['id']==self.pane)['agent']
    def conversation(self):
        return next(c for c in self.session()['conversations'] if c['agent']['session']=='claude-s')
    def test_running_command_alone_gets_summary_without_completion_or_commentary(self):
        self.control.write_text(json.dumps({'delay':0,'label':'Running smoke tests'}))
        self.hook('SessionStart')
        time.sleep(.6)
        self.hook('UserPromptSubmit')
        self.hook('PreToolUse',tool_name='Bash',tool_input={'command':'python3 tests/smoke.py'})
        self.record(type='assistant',message={'id':'m1','content':[
            {'type':'tool_use','id':'smoke','name':'Bash','input':{'command':'python3 tests/smoke.py'}}]})
        self.until(lambda:self.agent()['activity']=='Running smoke tests')
        calls=self.log.read_text().splitlines()
        self.assertEqual(len(calls),1)
        self.assertIn('Currently running tools',json.loads(calls[0])['evidence'])
        time.sleep(8.5)
        self.assertEqual(len(self.log.read_text().splitlines()),1)
    def test_claude_labels_timeline_and_cached_usage_match_codex(self):
        self.hook('SessionStart')
        time.sleep(.6) # Let the reader seed its baseline on the empty transcript.
        self.hook('UserPromptSubmit')
        self.hook('PreToolUse',tool_name='Read',tool_input={'file_path':'/repo/src/server.zig'})
        self.assertEqual(self.agent()['activity'],'Reading server.zig')
        self.record(type='assistant',message={'id':'m1','usage':{'input_tokens':100,'cache_read_input_tokens':900,'cache_creation_input_tokens':50,'output_tokens':40},'content':[
            {'type':'text','text':'Tracing how hooks reach panes'},
            {'type':'tool_use','id':'t1','name':'Bash','input':{'command':'rg routeHook','description':'Find hook routing'}}]})
        self.until(lambda:self.agent()['activity']=='Tracing hook routing')
        # Commentary can be summarized before a tool finishes. Complete it only
        # after the first label, then wait through the worker's 8-second cooldown
        # for the new evidence instead of assuming the first request included it.
        self.record(type='user',message={'content':[{'type':'tool_result','tool_use_id':'t1','content':'ok'}]})
        self.until(lambda:'Find hook routing' in json.loads(self.log.read_text().splitlines()[-1])['evidence'],timeout=12)
        call=json.loads(self.log.read_text().splitlines()[-1])
        self.assertIn('Tracing how hooks reach panes',json.dumps(call))
        self.assertIn('Find hook routing',json.dumps(call))
        # An inferred label is not replaced by the next direct tool label.
        self.hook('PreToolUse',tool_name='Read',tool_input={'file_path':'/repo/src/agents.zig'})
        self.assertEqual(self.agent()['activity'],'Tracing hook routing')
        conversation=self.conversation()
        self.assertEqual(conversation['usage']['tokens'],dict(input=1050,cached_input=900,output=40))
        self.assertEqual([p['activity'] for p in conversation['timeline']['points']],['Tracing hook routing'])
        self.hook('Stop')
        self.record(type='system',subtype='turn_duration')
        self.until(lambda:self.agent()['state']=='idle')

    def test_claude_label_survives_text_written_during_inference(self):
        self.control.write_text(json.dumps({'delay':1.5,'label':'Tracing hook routing'}))
        self.hook('SessionStart')
        time.sleep(.6)
        self.hook('UserPromptSubmit')
        self.record(type='assistant',message={'id':'m1','content':[{'type':'text','text':'Tracing how hooks reach panes'}]})
        self.until(lambda:self.log.exists())
        # Claude narrates before most tools; newer text must not discard the label.
        self.record(type='assistant',message={'id':'m2','content':[{'type':'text','text':'Checking the attachment router next'}]})
        self.until(lambda:self.agent()['activity']=='Tracing hook routing',timeout=6)
        self.assertEqual([p['activity'] for p in self.conversation()['timeline']['points']],['Tracing hook routing'])

if __name__=='__main__':unittest.main()
