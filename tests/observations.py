#!/usr/bin/env python3
"""Real runtime observation/read-receipt tests; no provider inference."""
import datetime, json, pathlib, time, unittest
import smoke
from viewers import Viewer

class Observations(smoke.Runtime):
    def setUp(self):
        self.viewers=[]
        super().setUp()
        self.pane=self.command('pane.create', workspace=1, command='sleep 60')['pane']
        self.log=pathlib.Path(self.temp.name,'transcript.jsonl')
        self.log.write_text(json.dumps({'type':'session_meta','payload':{'id':'session'}})+'\n')
        self.seq=time.time_ns()//1000
        self.turn=0
        self.hook('SessionStart',turn_id='')
    def tearDown(self):
        for v in self.viewers:v.close()
        super().tearDown()
    def hook(self,event,provider='codex',**extra):
        self.seq=max(self.seq+1,time.time_ns()//1000)
        return self.rpc(op='hook',pane=self.pane,provider=provider,seq=self.seq,event={
            'hook_event_name':event,'session_id':'session',
            **({'turn_id':str(self.turn)} if provider=='codex' else {}),
            'transcript_path':str(self.log),**extra})
    def state(self):return next(p for p in self.panes() if p['id']==self.pane)
    def append(self,kind='task_complete',turn=None,partial=False,**extra):
        record={'type':'event_msg','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),
                'payload':{'type':kind,'turn_id':str(self.turn if turn is None else turn),**extra}}
        with self.log.open('a') as f:f.write(json.dumps(record)+('' if partial else '\n'))
    def finish(self):
        self.turn+=1
        self.hook('UserPromptSubmit');self.hook('Stop');self.append()
        self.until(lambda:self.state()['completed']==self.turn)
    def test_provisional_stop_partial_record_and_unread_survives_new_work(self):
        self.turn=1
        self.hook('UserPromptSubmit');self.hook('Stop')
        time.sleep(.35)
        self.assertEqual((self.state()['state'],self.state()['unread']),('working',False))
        self.append(turn='old');time.sleep(.3)
        self.assertFalse(self.state()['unread'])
        self.append(partial=True);time.sleep(.3)
        self.assertFalse(self.state()['unread'])
        with self.log.open('a') as f:f.write('\n')
        self.until(lambda:self.state()['unread'])
        self.assertEqual(self.state()['state'],'idle')
        self.turn+=1;self.hook('UserPromptSubmit');self.hook('PreToolUse',tool_name='Bash')
        self.assertTrue(self.state()['unread'])
        self.assertEqual(self.state()['activity'],'Bash')
        self.hook('PostToolUse',tool_name='Bash')
        self.assertEqual(self.state()['recent_activity'],'used: Bash')
    def test_duplicate_stop_does_not_revive_finished_or_replace_newer_turn(self):
        self.finish()
        self.hook('Stop');time.sleep(.3)
        self.assertEqual((self.state()['state'],self.state()['completed']),('idle',1))
        self.turn=2;self.hook('UserPromptSubmit')
        self.hook('Stop',turn_id='1');time.sleep(.3)
        self.assertEqual(self.state()['state'],'working')
        self.assertFalse(self.state()['pending_stop'])
        self.assertEqual(self.state()['completed'],1)
    def test_interrupt_retains_unread_outcome_without_stop(self):
        self.turn=1;self.hook('UserPromptSubmit');self.hook('Interrupt')
        self.assertTrue(self.state()['unread'])
        agent=next(p for p in self.session()['panes'] if p['id']==self.pane)['agent']
        self.assertEqual(agent['observation']['outcome'],'interrupted')
        self.assertEqual(agent['state'],'idle')
        self.hook('Interrupt');self.assertEqual(self.state()['completed'],1)
    def test_automatic_permission_review_does_not_request_human_input(self):
        self.hook('UserPromptSubmit')
        self.hook('PreToolUse',tool_name='Bash')
        self.hook('PermissionRequest',tool_name='Bash')
        time.sleep(.7)
        self.assertEqual((self.state()['state'],self.state()['attention']),('working','none'))
        self.hook('PostToolUse',tool_name='Bash')
        self.assertEqual((self.state()['state'],self.state()['attention']),('working','none'))

    def test_read_receipt_does_not_clear_a_newer_permission_prompt(self):
        self.finish();stamp=next(p for p in self.session()['panes'] if p['id']==self.pane)['agent']['changed_at']
        self.turn=2;self.hook('UserPromptSubmit');self.hook('PreToolUse',tool_name='request_user_input')
        self.rpc(op='pane.acknowledge',protocol=1,pane=self.pane,session='session',through=1,attention_at=stamp)
        self.assertFalse(self.state()['unread'])
        self.assertEqual(self.state()['attention'],'needs_input')

    def test_old_receipt_and_wrong_session_do_not_read_new_completion(self):
        self.finish();old=self.state()['completed'];self.finish()
        self.rpc(op='pane.acknowledge',protocol=1,pane=self.pane,session='session',through=old)
        self.assertTrue(self.state()['unread'])
        result=self.raw_rpc(op='pane.acknowledge',protocol=1,pane=self.pane,session='wrong',through=2)
        self.assertEqual(result['err'],'StaleAcknowledgement')
        self.assertTrue(self.state()['unread'])
        self.rpc(op='pane.acknowledge',protocol=1,pane=self.pane,session='session',through=2)
        self.assertFalse(self.state()['unread'])
    def test_active_viewer_visits_read_background_viewer_does_not(self):
        other=self.command('pane.create', workspace=1, command='sleep 60')['pane']
        v=Viewer(self);v.focus(other)
        self.finish();v.poll()
        self.assertTrue(self.state()['unread'])
        v.input('\x1b[O');v.focus(self.pane)
        self.assertTrue(self.state()['unread'])
        v.input('\x1b[I')
        self.until(lambda:not self.state()['unread'])
    def test_continuation_cancels_pending_and_reload_does_not_replay(self):
        self.turn=1;self.hook('UserPromptSubmit');self.hook('Stop')
        self.hook('PreToolUse',tool_name='Bash');self.append()
        time.sleep(.4);self.assertFalse(self.state()['unread'])
        self.hook('Stop');self.append()
        self.until(lambda:self.state()['unread'])
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.assertEqual(self.state()['completed'],1)
        time.sleep(.4);self.assertEqual(self.state()['completed'],1)
    def test_bad_identity_symlink_and_oversized_record(self):
        self.turn=1;self.hook('UserPromptSubmit')
        self.log.write_text(json.dumps({'type':'session_meta','payload':{'id':'other'}})+'\n')
        self.hook('Stop');self.append();time.sleep(.4)
        self.assertFalse(self.state()['unread'])
        self.hook('UserPromptSubmit')
        target=self.log.with_suffix('.actual')
        self.log.rename(target);self.log.symlink_to(target)
        self.hook('Stop');time.sleep(.35)
        self.assertFalse(self.state()['unread'])
        self.log.unlink();target.rename(self.log)
        self.hook('UserPromptSubmit')
        self.log.write_text(json.dumps({'type':'session_meta','payload':{'id':'session'}})+'\n'+'x'*300000+'\n')
        self.hook('Stop');self.append()
        self.until(lambda:self.state()['unread'])
    def test_unread_survives_cold_recovery_and_pending_stop_survives_reload(self):
        self.turn=1;self.hook('UserPromptSubmit');self.hook('Stop')
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.append();self.until(lambda:self.state()['unread'])
        self.run_cli('checkpoint');self.run_cli('shutdown');self.run_cli('start')
        self.assertTrue(self.state()['unread'])
        self.assertEqual(self.state()['state'],'done')
        self.assertEqual(self.state()['completed'],1)
        v=Viewer(self);v.focus(self.pane)
        self.until(lambda:not self.state()['unread'])
    def test_native_completion_is_correlated_and_unread_survives_next_turn(self):
        ident=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        def snapshot():return self.session()['native_sessions'][0]
        self.until(lambda:snapshot()['ready'])
        def event(method,turn,status=None):
            value={'id':turn}
            if status:value['status']=status
            self.rpc(op='native.send',session=ident,message={'method':'test/event','params':{'method':method,'params':{'threadId':'thread','turn':value}}})
        event('turn/started','one');self.until(lambda:snapshot()['state']=='working')
        event('turn/completed','one','completed');self.until(lambda:snapshot()['observation']['completed']==1)
        event('turn/started','two');self.until(lambda:snapshot()['state']=='working')
        self.assertEqual(snapshot()['observation']['read'],0)
        event('turn/completed','one','completed');time.sleep(.1)
        self.assertEqual(snapshot()['state'],'working')
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        event('turn/completed','two','interrupted');self.until(lambda:snapshot()['state']=='idle')
        self.assertEqual(snapshot()['observation']['outcome'],'interrupted')
        self.assertEqual(snapshot()['observation']['completed'],2)

    def test_claude_uses_fresh_post_turn_record_not_assistant_or_stop_summary(self):
        self.hook('UserPromptSubmit',provider='claude');self.hook('Stop',provider='claude')
        def write(kind,subtype):
            with self.log.open('a') as f:f.write(json.dumps({'type':kind,'subtype':subtype,'sessionId':'session','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')})+'\n')
        write('assistant','end_turn');write('system','stop_hook_summary');time.sleep(.4)
        self.assertFalse(self.state()['unread'])
        write('system','turn_duration');self.until(lambda:self.state()['unread'])
        self.hook('Stop',provider='claude');time.sleep(.35)
        self.assertEqual((self.state()['state'],self.state()['completed']),('idle',1))
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.hook('Stop',provider='claude');time.sleep(.35)
        self.assertEqual((self.state()['state'],self.state()['completed']),('idle',1))
        self.hook('UserPromptSubmit',provider='claude');self.hook('Stop',provider='claude')
        write('system','turn_duration');self.until(lambda:self.state()['completed']==2)

for name in dir(smoke.Runtime):
    if name.startswith('test_') and name not in Observations.__dict__:setattr(Observations,name,None)
if __name__=='__main__':unittest.main(verbosity=2)
