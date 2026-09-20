#!/usr/bin/env python3
"""Exercise real viewer controllers against isolated daemons.
Build first: ./scripts/zig build -Doptimize=ReleaseSafe -Dviewer-test-driver=true
"""
import base64, datetime, json, os, pathlib, select, shlex, socket, subprocess, sys, threading, time, unittest
import smoke as legacy
from smoke import EXE

class Viewer:
    def __init__(self, test):
        self.test=test
        self.proc=subprocess.Popen([EXE,'__viewer-test'],env=test.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        test.viewers.append(self)
        self.request(op='poll')
    def request(self, **request):
        self.proc.stdin.write(json.dumps(request)+'\n');self.proc.stdin.flush()
        self.test.assertTrue(select.select([self.proc.stdout],[],[],5)[0], 'viewer response timeout')
        line=self.proc.stdout.readline()
        if not line:
            self.proc.wait(timeout=2)
            self.test.fail('viewer exited: '+self.proc.stderr.read())
        self.state=json.loads(line)
        return self.state
    def input(self, data):return self.request(op='input',data=data)
    def action(self,name,value=''):return self.request(op='action',name=name,value=value)
    def poll(self):return self.request(op='poll')
    def focus(self,pane):return self.request(op='focus',pane=pane)
    def close(self):
        if self.proc.poll() is None:self.proc.terminate()
        self.proc.wait(timeout=3)
        for stream in (self.proc.stdin,self.proc.stdout,self.proc.stderr):stream.close()

class Viewers(unittest.TestCase):
    run_cli=legacy.Runtime.run_cli
    rpc=legacy.Runtime.rpc
    raw_rpc=legacy.Runtime.raw_rpc
    session=legacy.Runtime.session
    panes=legacy.Runtime.panes
    until=legacy.Runtime.until
    def setUp(self):
        self.viewers=[]
        legacy.Runtime.setUp(self)
    def tearDown(self):
        for viewer in self.viewers:viewer.close()
        legacy.Runtime.tearDown(self)
    def new(self,command='sleep 60',title=''):
        ws=self.session()['workspaces'][0]['id']
        return self.rpc(op='pane.create',protocol=1,workspace=ws,cwd=self.temp.name,command=command,title=title)['pane']
    def geometry(self):return {p['id']:(p['cols'],p['rows']) for p in self.session()['panes']}
    def test_workspace_away_usage_resets_on_visit_and_respects_other_viewers(self):
        pane=self.new()
        home=self.session()['workspaces'][0]['id']
        other=self.rpc(op='workspace.create',protocol=1,name='Other',cwd=self.temp.name)['workspace']
        path=pathlib.Path(self.temp.name,'usage.jsonl')
        def token_line(i,o):
            return {'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':{'input_tokens':i,'output_tokens':o}}}}
        path.write_text(json.dumps({'type':'session_meta','payload':{'id':'usage','instructions':'x'*(24*1024)}})+'\n'+json.dumps(token_line(100,10))+'\n')
        self.rpc(op='hook',pane=pane,provider='codex',seq=1,event={'hook_event_name':'SessionStart','session_id':'usage','transcript_path':str(path)})
        a=Viewer(self)
        a.request(op='workspace',workspace=other)
        time.sleep(.8) # Let the worker establish the existing-file baseline.
        def append(n,i,o):
            stamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            with path.open('a') as f:
                f.write(json.dumps({'type':'response_item','timestamp':stamp,'payload':{'type':'function_call','call_id':str(n)}})+'\n')
                f.write(json.dumps({**token_line(i,o),'timestamp':stamp})+'\n')
        def counts():
            return next(w['stats'] for w in self.session()['workspaces'] if w['id']==home)
        append(1,150,20)
        self.until(lambda:counts()['tools']==1)
        self.assertEqual((counts()['input'],counts()['output']),(50,10))
        self.rpc(op='hook',pane=pane,provider='codex',seq=2,event={'hook_event_name':'PermissionRequest','session_id':'usage'})
        self.assertIn('\x1b[1;38;2;243;139;168m1●',a.poll()['data'])
        self.assertIn('↓50↑10',a.state['data'])
        self.assertIn('0 unread',legacy.screen_text(a.state['data'],100,30)[3][:27])
        a.request(op='workspace',workspace=home)
        self.assertEqual(counts()['tools'],0)
        append(2,200,30)
        for _ in range(5):
            a.poll();time.sleep(.15)
        self.assertEqual(counts()['tools'],0)
        a.request(op='workspace',workspace=other)
        append(3,230,35)
        self.until(lambda:counts()['tools']==1)
        self.assertEqual((counts()['input'],counts()['output']),(30,5))
        b=Viewer(self)
        b.request(op='workspace',workspace=home)
        self.assertEqual(counts()['tools'],0)
        append(4,240,36)
        for _ in range(5):
            a.poll();b.poll();time.sleep(.15)
        self.assertEqual(counts()['tools'],0)

    def test_native_usage_and_attention_are_visible_and_survive_reload(self):
        self.new()
        home=self.session()['workspaces'][0]['id']
        ident=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        def send(method,params):
            self.rpc(op='native.send',session=ident,message={'id':1,'method':'test/event','params':{'method':method,'params':params}})
        def counts():return self.session()['workspaces'][0]['stats']
        send('turn/started',{'threadId':'t','turn':{'id':'turn'}})
        send('item/started',{'threadId':'t','turnId':'turn','item':{'id':'tool1','type':'commandExecution'}})
        usage={'total':{'inputTokens':100,'outputTokens':10},'last':{'inputTokens':100,'outputTokens':10}}
        send('thread/tokenUsage/updated',{'threadId':'t','tokenUsage':usage})
        self.until(lambda:counts()['input']==100)
        self.assertEqual(counts()['tools'],1)
        self.rpc(op='server.reload',protocol=1,executable=EXE)
        self.assertEqual((counts()['tools'],counts()['input'],counts()['output']),(1,100,10))
        send('thread/tokenUsage/updated',{'threadId':'t','tokenUsage':usage})
        time.sleep(.15)
        self.assertEqual(counts()['input'],100)
        v=Viewer(self);v.request(op='workspace',workspace=home)
        self.assertEqual(counts()['tools'],0)

    def test_workspace_context_menu_targets_background_workspace(self):
        first=self.new(title='Keep')
        ws=self.rpc(op='workspace.create',protocol=1,name='Target',cwd=self.temp.name)['workspace']
        a=Viewer(self);b=Viewer(self)
        a.focus(first);b.request(op='workspace',workspace=ws)
        a.input('\x1b[<2;5;6M\x1b[<2;5;6m')
        self.assertIn('Rename',a.state['data'])
        a.input('\r');a.input('Renamed\r')
        self.assertEqual(next(w['custom_name'] for w in self.session()['workspaces'] if w['id']==ws),'Renamed')
        a.input('\x1b[<2;5;6M\x1b[<2;5;6m')
        a.input('\x1b[B\r')
        self.assertEqual(len(self.session()['workspaces']),1)
        self.assertEqual(a.poll()['pane'],first)
        self.assertEqual(b.poll()['pane'],first)

    def test_workspace_name_uses_first_tab_in_both_viewers(self):
        one=pathlib.Path(self.temp.name,'one');one.mkdir()
        two=pathlib.Path(self.temp.name,'two');two.mkdir()
        first=self.rpc(op='new',cwd=str(one),command='exec /bin/sh')['pane']
        second=self.rpc(op='new',cwd=str(two),command='exec /bin/sh')['pane']
        a=Viewer(self);b=Viewer(self)
        a.focus(first);b.focus(second)
        self.assertEqual(legacy.screen_text(a.poll()['data'],100,30)[2][1:27].strip(),'one')
        self.assertEqual(legacy.screen_text(b.poll()['data'],100,30)[2][1:27].strip(),'one')
        self.assertNotIn('📌',a.state['data'])
        b.action('move-tab','left')
        self.assertEqual(legacy.screen_text(a.poll()['data'],100,30)[2][1:27].strip(),'two')
        self.assertEqual(legacy.screen_text(b.poll()['data'],100,30)[2][1:27].strip(),'two')
        b.input('\x02W');b.input('Custom\r')
        self.assertIn('Custom',a.poll()['data'])
        self.assertIn('Custom',b.poll()['data'])
        b.input('\x02W');b.input('\x03\r')
        self.assertEqual(self.session()['workspaces'][0]['custom_name'],'')
        self.assertEqual(legacy.screen_text(a.poll()['data'],100,30)[2][1:27].strip(),'two')
        a.action('new')
        self.assertEqual(next(p['cwd'] for p in self.session()['panes'] if p['id']==a.state['pane']),str(one.resolve()))

    def test_viewer_creation_inherits_its_own_focused_directory(self):
        one=pathlib.Path(self.temp.name,'one');one.mkdir()
        two=pathlib.Path(self.temp.name,'two');two.mkdir()
        first=self.rpc(op='new',cwd=str(one),command='exec /bin/sh')['pane']
        second=self.rpc(op='new',cwd=str(two),command='exec /bin/sh')['pane']
        a=Viewer(self);b=Viewer(self)
        a.focus(first);b.focus(second)
        b.action('split','right')
        self.assertEqual(next(p['cwd'] for p in self.session()['panes'] if p['id']==b.state['pane']),str(two.resolve()))
        target=self.rpc(op='viewer.list')['viewers'][0]['id']
        self.rpc(op='focus',pane=second,viewer=target)
        for op in ('new','split'):
            created=self.rpc(op=op,viewer=target,command='sleep 60')['pane']
            self.assertEqual(next(p['cwd'] for p in self.session()['panes'] if p['id']==created),str(two.resolve()))

    def test_selection_and_dialogs_are_viewer_specific(self):
        first=self.new(title='First');second=self.new(title='Second')
        ws=self.rpc(op='workspace.create',protocol=1,name='Other',cwd=self.temp.name)['workspace']
        a=Viewer(self);b=Viewer(self)
        a.focus(first);b.focus(second)
        before=self.session()['workspaces']
        a.request(op='workspace',workspace=ws)
        self.assertEqual(b.poll()['pane'],second)
        a.request(op='workspace',workspace=before[0]['id'])
        self.assertEqual(a.state['pane'],first)
        a.input('\x02c')
        self.assertTrue(a.state['dialog']);self.assertFalse(b.poll()['dialog'])
        b.input('\x02')
        self.assertTrue(b.state['prefix']);self.assertTrue(a.poll()['dialog'])
        self.assertEqual(self.session()['workspaces'],before)
    def test_arrangement_is_shared_and_close_reconciles_selection(self):
        first=self.new(title='First');second=self.new(title='Second')
        a=Viewer(self);b=Viewer(self);a.focus(first);b.focus(second)
        pid={p['id']:p['pid'] for p in self.session()['panes']}
        a.action('split','right');split=a.state['pane']
        b.poll();b.focus(split)
        a.action('rename','Shared');a.action('move-tab','right')
        self.assertIn('Shared',b.poll()['data']);self.assertEqual(b.state['pane'],split)
        a.action('close')
        self.assertEqual(b.poll()['pane'],first)
        self.assertEqual(next(p['pid'] for p in self.session()['panes'] if p['id']==first),pid[first])
        self.assertEqual(len(self.session()['panes']),2)
    def test_sizes_follow_visible_panes_and_expand_after_detach(self):
        first=self.new();second=self.new()
        a=Viewer(self);b=Viewer(self)
        a.request(op='size',cols=120,rows=40);a.focus(first)
        b.request(op='size',cols=60,rows=20);b.focus(second);a.poll()
        sizes=self.geometry()
        self.assertEqual(sizes[first],(92,38));self.assertEqual(sizes[second],(60,18))
        b.focus(first);a.poll();self.assertEqual(self.geometry()[first],(60,18))
        b.close();a.poll();self.assertEqual(self.geometry()[first],(92,38))
    def test_scroll_and_copy_are_private_and_preserve_live_screen(self):
        first=self.new("i=0; while [ $i -lt 80 ]; do printf 'ROW_%03d\\n' $i; i=$((i+1)); done; exec /bin/sh")
        self.until(lambda:'ROW_079' in self.rpc(op='read',pane=first)['text'])
        a=Viewer(self);b=Viewer(self);a.focus(first);b.focus(first)
        a.input('\x02[g')
        self.assertIn('ROW_000',a.state['data'])
        self.assertNotIn('ROW_000',b.poll()['data'])
        self.assertIn('ROW_079',b.state['data'])
        self.assertIn('ROW_079',self.rpc(op='read',pane=first)['text'])
        a.input('y');self.assertIn('52;c;',a.state['effects'])
        a.input('q');self.assertIn('ROW_079',a.state['data'])
    def test_targeted_cli_navigation_and_paste_keep_original_target(self):
        first=self.new('exec /bin/sh');second=self.new('exec /bin/sh')
        a=Viewer(self);b=Viewer(self);a.focus(first);b.focus(first)
        views=self.rpc(op='viewer.list')['viewers'];target=views[0]['id']
        a.input('\x1b[200~printf PASTE_')
        self.rpc(op='focus',pane=second,viewer=target)
        self.assertEqual(a.poll()['pane'],second);self.assertEqual(b.poll()['pane'],first)
        a.input('STAYS_HERE\\n\x1b[201~\r')
        # The paste stays in first; Enter after its end belongs to second.
        self.rpc(op='send',pane=first,text='\r')
        self.until(lambda:'PASTE_STAYS_HERE' in self.rpc(op='read',pane=first)['text'])
        self.assertNotIn('PASTE_STAYS_HERE',self.rpc(op='read',pane=second)['text'])
    def test_conflicting_layout_edit_is_rejected(self):
        self.new(title='Before');a=Viewer(self)
        old=self.session()['workspaces'][0]
        a.action('rename','After')
        reply=self.raw_rpc(op='layout.apply',protocol=1,workspace=old['id'],token=old['token'],tabs=old['tabs'])
        self.assertEqual(reply['err'],'StaleLayout')
        self.assertEqual(self.session()['workspaces'][0]['tabs'][0]['title'],'After')
    def test_viewer_reopen_preserves_daemon_and_pane_processes(self):
        first=self.new();a=Viewer(self);a.focus(first)
        before=self.session();a.close()
        b=Viewer(self);after=self.session()
        self.assertEqual(before['server_pid'],after['server_pid'])
        self.assertEqual([(p['id'],p['pid']) for p in before['panes']],[(p['id'],p['pid']) for p in after['panes']])
        self.assertEqual(b.state['pane'],first)
    def test_shared_break_join_and_undo(self):
        first=self.new();a=Viewer(self);b=Viewer(self)
        a.action('split','right');split=a.state['pane'];b.poll();b.focus(first)
        a.action('break');self.assertEqual(a.state['pane'],split)
        self.assertEqual(len(self.session()['workspaces'][0]['tabs']),2)
        self.assertEqual(b.poll()['pane'],first)
        a.action('join','1');self.assertEqual(a.state['pane'],split)
        a.action('close');self.assertEqual(a.state['pane'],first)
        a.action('undo-close');self.assertNotIn(a.state['pane'],[first,split])
        self.assertIn('restored output',a.state['data'])
        self.assertEqual(b.poll()['pane'],first)

    def test_search_and_selection_copy_do_not_change_other_view(self):
        first=self.new("printf 'SEARCH_MARKER_unique\\n'; i=0; while [ $i -lt 80 ]; do printf 'tail_%03d\\n' $i; i=$((i+1)); done; exec /bin/sh")
        self.until(lambda:'tail_079' in self.rpc(op='read',pane=first)['text'])
        a=Viewer(self);b=Viewer(self);a.focus(first);b.focus(first)
        a.input('\x02[/SEARCH_MARKER_unique\r')
        self.assertIn('SEARCH_MARKER_unique',a.state['data'])
        a.input('y')
        effect=json.loads(a.state['effects'].splitlines()[0])['data']
        encoded=effect.split('52;c;',1)[1].split('\x07',1)[0]
        self.assertEqual(base64.b64decode(encoded).decode(),'SEARCH_MARKER_unique')
        self.assertNotIn('SEARCH_MARKER_unique',b.poll()['data'])
    def test_closing_paste_target_does_not_crash_or_redirect_input(self):
        first=self.new('exec /bin/sh');second=self.new('exec /bin/sh')
        a=Viewer(self);a.focus(first)
        a.input('\x1b[200~NOT_A_COMMAND')
        self.rpc(op='pane.close',protocol=1,pane=first)
        a.input('_SHOULD_DISAPPEAR\x1b[201~')
        self.assertEqual(a.state['pane'],second)
        self.assertNotIn('SHOULD_DISAPPEAR',self.rpc(op='read',pane=second)['text'])
    def test_viewer_encodes_keys_and_mouse_for_child_modes(self):
        fixture=pathlib.Path(self.temp.name,'input.py')
        capture=pathlib.Path(self.temp.name,'input.bin')
        fixture.write_text("import os,tty,sys\ntty.setraw(0)\nos.write(1,b'\\x1b[>1u\\x1b[?1002h\\x1b[?1006hREADY')\nwith open(sys.argv[1],'wb',buffering=0) as f:\n while True:f.write(os.read(0,4096))\n")
        first=self.new(shlex.join([sys.executable,str(fixture),str(capture)]))
        self.until(lambda:'READY' in self.rpc(op='read',pane=first)['text'])
        a=Viewer(self);a.focus(first)
        a.input('\x1b[97;5u')
        self.until(lambda:capture.exists() and b'\x1b[97;5u' in capture.read_bytes())
        a.input('\x1b[<0;29;2M\x1b[<0;29;2m')
        self.until(lambda:b'\x1b[<0;1;1M' in capture.read_bytes())
        before=capture.read_bytes()
        a.input('\x1b[98;5u')
        self.assertTrue(a.state['prefix'])
        a.input('\x1b')
        self.assertEqual(capture.read_bytes(),before)

    def test_older_daemon_is_rejected_without_restart(self):
        path=self.temp.name+'/older.sock'
        seen=[]
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(path);listener.listen(1);listener.settimeout(5)
            def serve():
                client,_=listener.accept()
                with client,client.makefile('rb') as stream:
                    seen.append(json.loads(stream.readline())['op'])
                    client.sendall(b'{"type":"hello","protocol":1,"capabilities":["session.snapshot"]}\n')
                    extra=stream.readline()
                    if extra:seen.append(json.loads(extra)['op'])
            thread=threading.Thread(target=serve);thread.start()
            result=subprocess.run([EXE,'__viewer-test'],env={**self.env,'CORGI_SOCKET':path},capture_output=True,text=True,timeout=5)
            thread.join(timeout=5)
        self.assertEqual(result.returncode,1)
        self.assertIn('daemon needs one update',result.stderr)
        self.assertEqual(seen,['hello'])

    def test_cli_focus_then_split_uses_queued_target(self):
        first=self.new();second=self.new();a=Viewer(self);a.focus(first)
        target=self.rpc(op='viewer.list')['viewers'][0]['id']
        old=self.session();second_tab=next(p['tab'] for p in old['panes'] if p['id']==second)
        self.rpc(op='focus',pane=second,viewer=target)
        split=self.rpc(op='split',viewer=target,command='sleep 60')['pane']
        snap=self.session()
        self.assertEqual(next(p['tab'] for p in snap['panes'] if p['id']==split),second_tab)
        self.assertEqual(a.poll()['pane'],split)
        self.assertEqual(a.poll()['pane'],split) # Acknowledged controls do not repeat.
    def test_delivered_focus_remains_a_split_target_until_acknowledged(self):
        first=self.new();second=self.new()
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(self.path);client.settimeout(3)
            with client.makefile('rb') as stream:
                def call(**request):
                    client.sendall(json.dumps(dict(protocol=1,**request)).encode()+b'\n')
                    return json.loads(stream.readline())
                call(op='viewer.open',cwd=self.temp.name)
                call(op='viewer.sync',interests=[dict(pane=first,cols=80,rows=24)],focus=first)
                target=self.rpc(op='viewer.list')['viewers'][0]['id']
                self.rpc(op='focus',pane=second,viewer=target)
                delivered=call(op='viewer.sync',interests=[dict(pane=first,cols=80,rows=24)],focus=first)
                self.assertEqual(delivered['controls'][0]['id'],second)
                split=self.rpc(op='split',viewer=target,command='sleep 60')['pane']
                panes=self.session()['panes']
                self.assertEqual(next(p['tab'] for p in panes if p['id']==split),next(p['tab'] for p in panes if p['id']==second))
    def test_split_waits_for_queued_local_navigation(self):
        first=self.new();self.new();a=Viewer(self);a.focus(first)
        target=self.rpc(op='viewer.list')['viewers'][0]['id']
        self.rpc(op='action',name='next',viewer=target)
        self.assertEqual(self.raw_rpc(op='split',viewer=target)['err'],'ViewerBusy')
        self.assertEqual(len(self.session()['panes']),2)
        a.poll()
        self.assertIn('pane',self.rpc(op='split',viewer=target,command='sleep 60'))

if __name__=='__main__':unittest.main(verbosity=2)
