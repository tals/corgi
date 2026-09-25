#!/usr/bin/env python3
"""Exercise real viewer controllers against isolated daemons.
Build first: ./scripts/zig build -Doptimize=ReleaseSafe -Dviewer-test-driver=true
"""
import base64, datetime, json, os, pathlib, select, shlex, socket, subprocess, sys, threading, time, unittest
import smoke as legacy
from smoke import layout_tree
from smoke import EXE

from viewer_client import Viewer

class Viewers(unittest.TestCase):
    run_cli=legacy.Runtime.run_cli
    rpc=legacy.Runtime.rpc
    command=legacy.Runtime.command
    open_pane=legacy.Runtime.open_pane
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
        return self.command('pane.create', workspace=ws, cwd=self.temp.name, command=command, title=title)['pane']
    def geometry(self):return {p['id']:(p['cols'],p['rows']) for p in self.session()['panes']}
    def mark_agent(self,pane,name):
        self.command('pane.rename',target=pane,name=name)
        self.rpc(op='hook',pane=pane,provider='claude',seq=1,event={'hook_event_name':'SessionStart','session_id':str(pane)})

    @unittest.skipUnless(sys.platform == 'darwin', 'Ghostty integration is macOS-only')
    def test_ghostty_setup_toggle_preserves_config_and_routes_tabs(self):
        self.env.pop('SSH_CONNECTION',None)
        self.env.pop('SSH_TTY',None)
        self.env['XDG_CONFIG_HOME']=self.temp.name+'/.config'
        config=pathlib.Path(self.temp.name,'Library/Application Support/com.mitchellh.ghostty/config.ghostty')
        config.parent.mkdir(parents=True)
        original='font-size = 14\nkeybind = cmd+1=goto_tab:1\n'
        config.write_text(original)
        config.chmod(0o640)
        panes=[self.new() for _ in range(9)]
        viewer=Viewer(self)
        state=viewer.input('\x02i')
        self.assertIn('Enable Ghostty integration',state['data'])
        viewer.input('jjjj\r')
        enabled=config.read_text()
        self.assertEqual(config.stat().st_mode & 0o777,0o640)
        self.assertTrue(enabled.startswith(original))
        for i,pane in enumerate(panes,1):
            self.assertIn(f'keybind = cmd+digit_{i}=text:\\x02{i}',enabled)
            self.assertEqual(viewer.input(f'\x02{i}')['pane'],pane)
        self.assertEqual(viewer.input('\x02n')['pane'],panes[0])
        self.assertEqual(viewer.input('\x02p')['pane'],panes[-1])
        state=viewer.input('\x02i')
        self.assertIn('Disable Ghostty integration',state['data'])
        # Click the same toggle row, including its text rather than the border.
        viewer.input('\x1b[<0;5;13M')
        viewer.input('\x1b[<0;5;13m')
        self.assertEqual(config.read_text(),original)
        self.assertEqual(config.stat().st_mode & 0o777,0o640)

    def test_agent_hotkeys_follow_complete_workspace_sidebar(self):
        shell=self.new()
        home=self.session()['workspaces'][0]['id']
        agents=[self.new() for _ in range(5)]
        agents.append(self.command('pane.split',cwd=self.temp.name,command='sleep 60',target=agents[-1],direction='right')['pane'])
        for i,pane in enumerate(agents):self.mark_agent(pane,f'Agent-{i}')
        other=self.command('workspace.create',name='Elsewhere',cwd=self.temp.name)['workspace']
        outsider=self.command('pane.create',workspace=other,cwd=self.temp.name,command='sleep 60')['pane']
        self.mark_agent(outsider,'Outside-agent')
        a,b=Viewer(self,rows=16),Viewer(self)
        a.focus(shell);b.focus(outsider)
        for pane in agents:
            self.assertEqual(a.input('\x02]')['pane'],pane)
            self.assertEqual(a.state['workspace'],home)
        screen=legacy.screen_text(a.state['data'],100,16)
        self.assertTrue(any('Agent-5' in row[:27] for row in screen),screen)
        self.assertEqual(a.input('\x02]')['pane'],agents[0])
        self.assertEqual(a.input('\x02[')['pane'],agents[-1])
        self.assertEqual(b.poll()['pane'],outsider)
        a.input('\x02b') # Collapsing the sidebar does not change its agent set.
        self.assertEqual(a.input('\x02]')['pane'],agents[0])
        a.focus(shell)
        self.assertEqual(a.input('\x02\t')['pane'],agents[0])

    def test_agent_sidebar_search_input_mouse_and_stale_targets(self):
        first,second=self.new(),self.new()
        self.mark_agent(first,'Alpha');self.mark_agent(second,'Beta')
        other=self.command('workspace.create',name='Other',cwd=self.temp.name)['workspace']
        outsider=self.command('pane.create',workspace=other,cwd=self.temp.name,command='sleep 60')['pane']
        self.mark_agent(outsider,'Outside-agent')
        a=Viewer(self);a.focus(first)
        a.input('\x02gOutside-agent')
        self.assertIn('No matching agents',a.state['data'])
        self.assertEqual(a.input('\r')['pane'],first)
        # Pasted control bytes cannot accept the search or reach a pane.
        a.input('\x15\x1b[200~Beta\r\x02\x1b[201~')
        self.assertIn('↑↓  ↵ jump  Esc back',a.state['data'])
        self.assertEqual(a.input('\r')['pane'],second)
        # CSI-u prefix, Tab, and arrows are owned by navigation too.
        self.assertEqual(a.input('\x1b[98;5u\x1b[9u')['pane'],first)
        a.input('\x02g\x1b[B')
        self.assertEqual(a.input('\r')['pane'],second)
        a.input('\x02gAlpha')
        screen=legacy.screen_text(a.state['data'],100,30)
        row=next(i for i,line in enumerate(screen) if 'Alpha' in line[:27] and i >= 16)
        col=screen[row].index('Alpha')
        self.assertEqual(a.input(f'\x1b[<0;{col+1};{row+1}M\x1b[<0;{col+1};{row+1}m')['pane'],first)
        a.input('\x02gBeta')
        self.command('pane.close',target=second)
        a.poll()
        self.assertIn('No matching agents',a.state['data'])
        self.assertEqual(a.input('\r')['pane'],first)
        a.input('\x1b');time.sleep(.06);a.poll()
        self.assertNotIn('type to search',a.state['data'])
        self.assertEqual(a.input('\x02\t')['pane'],first)

    def test_agent_search_reuses_sidebar_and_restores_it_on_escape(self):
        first=self.new(command="printf 'PANE_CONTENT_VISIBLE'; sleep 60")
        self.mark_agent(first,'Alpha')
        rest=[self.new() for _ in range(5)]
        for i,pane in enumerate(rest):self.mark_agent(pane,f'Agent-{i}')
        a=Viewer(self,cols=100,rows=24);a.focus(first)
        self.until(lambda:'PANE_CONTENT_VISIBLE' in a.poll()['data'])
        before=legacy.screen_text(a.state['data'],100,24)
        a.input('\x02gAgent-4')
        after=legacy.screen_text(a.state['data'],100,24)
        self.assertEqual([row[28:] for row in before[:-1]],[row[28:] for row in after[:-1]])
        self.assertEqual(before[:11],after[:11])
        self.assertIn('/ Agent-4',after[12])
        self.assertIn('Agent-4',after[13][:27])
        self.assertNotIn('Alpha','\n'.join(row[:27] for row in after[13:-1]))
        self.assertEqual(a.state['pane'],first)
        a.input('\x1b');time.sleep(.06);a.poll()
        restored=legacy.screen_text(a.state['data'],100,24)
        self.assertIn('Alpha',restored[13][:27])
        self.assertNotIn('/ Agent-4','\n'.join(restored))
        self.assertEqual(a.state['pane'],first)
        a.input('\x02b\x02g') # Search reveals a collapsed sidebar.
        for _ in rest:a.input('\x1b[B')
        self.assertEqual(a.state['pane'],first)
        screen=legacy.screen_text(a.state['data'],100,24)
        self.assertTrue(any('Agent-4' in row[:27] for row in screen[13:-1]))
        self.assertEqual(a.input('\r')['pane'],rest[-1])
        # Compact terminals use the same sidebar, and resizing must not
        # silently send search input into the terminal.
        a.request(op='size',cols=40,rows=18)
        a.input('\x02gAlpha')
        self.assertIn('/ ',a.state['data'])
        a.request(op='size',cols=20,rows=5)
        a.input('does-not-match\r')
        self.assertEqual(a.state['pane'],rest[-1])
        a.request(op='size',cols=40,rows=18)
        a.input('\x15Alpha')
        self.assertEqual(a.input('\r')['pane'],first)

    def test_last_agent_history_is_per_workspace_and_per_viewer(self):
        first,second=self.new(),self.new()
        home=self.session()['workspaces'][0]['id']
        self.mark_agent(first,'Home-A');self.mark_agent(second,'Home-B')
        other=self.command('workspace.create',name='Other',cwd=self.temp.name)['workspace']
        foreign=[self.command('pane.create',workspace=other,cwd=self.temp.name,command='sleep 60')['pane'] for _ in range(2)]
        for i,pane in enumerate(foreign):self.mark_agent(pane,f'Other-{i}')
        a,b=Viewer(self),Viewer(self)
        a.focus(first);a.focus(second)
        b.focus(first)
        a.focus(foreign[0]);a.focus(foreign[1])
        self.assertEqual(a.input('\x02\t')['pane'],foreign[0])
        a.request(op='workspace',workspace=home)
        self.assertEqual(a.input('\x02\t')['pane'],first)
        self.assertEqual(a.input('\x02\t')['pane'],second)
        self.assertEqual(b.input('\x02\t')['pane'],first)
        a.input('\x02g')
        a.request(op='workspace',workspace=other)
        self.assertNotIn('type to search',a.state['data'])
        self.assertEqual(a.input('\x02\t')['pane'],foreign[1])

    def test_agent_navigation_includes_native_sessions_and_handles_empty_lists(self):
        first=self.new();self.mark_agent(first,'Terminal-agent')
        native=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        a=Viewer(self);a.focus(first)
        a.input('\x02]')
        self.assertIn(f'native session {native}',a.state['data'])
        a.input('\x02\t')
        self.assertNotIn(f'native session {native}',a.state['data'])
        a.input('\x02\t')
        self.assertIn(f'native session {native}',a.state['data'])
        self.assertEqual(a.input('\x02]')['pane'],first)
        empty=self.command('workspace.create',name='Empty',cwd=self.temp.name)['workspace']
        a.poll()
        a.request(op='workspace',workspace=empty)
        a.input('\x02]\x02[\x02\t')
        self.assertIn('No agents in this workspace',a.state['data'])
        a.input('\x02g')
        self.assertIn('No matching agents',a.state['data'])
        a.request(op='size',cols=20,rows=5)
        a.input('\x1b[A\x1b[B\r')
        self.assertEqual(a.state['workspace'],empty)

    def test_pane_menu_names_target_without_stealing_focus(self):
        left=self.new()
        right=self.command('pane.split', cwd=self.temp.name, command='sleep 60', target=left, direction='right')['pane']
        a,b=Viewer(self),Viewer(self)
        a.focus(left);b.focus(right)
        a.input('\x1b[<2;85;5M\x1b[<2;85;5m')
        self.assertEqual(a.state['pane'],left)
        self.assertIn('Rename pane',a.state['data'])
        self.assertIn('Swap with focused pane',a.state['data'])
        a.input('T')
        a.input('Logs\r')
        self.assertEqual(a.state['pane'],left)
        self.assertEqual(next(p for p in self.session()['panes'] if p['id']==right)['name'],'Logs')
        self.assertIn('Logs',b.poll()['data'])
        a.input('\x1b[<2;85;5M\x1b[<2;85;5m')
        a.input('s')
        self.assertEqual(a.state['pane'],left)
        tree=layout_tree(self.session()['workspaces'][0])['split']
        self.assertEqual(tree['first']['pane'],right)
        self.assertEqual(tree['second']['pane'],left)
        a.input('\x1b[<2;35;5M\x1b[<2;35;5m')
        a.input('C')
        self.assertEqual(next(p for p in self.session()['panes'] if p['id']==right)['name'],'')

    def test_pane_name_survives_reload_and_reopen(self):
        pane=self.new()
        a=Viewer(self)
        self.command('pane.rename', name='Build', target=pane)
        self.run_cli('reload',EXE)
        self.assertEqual(next(p for p in self.session()['panes'] if p['id']==pane)['name'],'Build')
        extra=self.new()
        a.focus(pane)
        a.input('\x1b[<2;35;5M\x1b[<2;35;5m')
        a.input('x')
        self.assertNotIn(pane,[p['id'] for p in self.session()['panes']])
        a.action('undo-close')
        self.assertEqual(next(p for p in self.session()['panes'] if p['id']==a.state['pane'])['name'],'Build')

    def test_workspace_drag_order_marker_and_cancellation(self):
        self.new()
        first=self.session()['workspaces'][0]['id']
        second=self.command('workspace.create', name='Second', cwd=self.temp.name)['workspace']
        third=self.command('workspace.create', name='Third', cwd=self.temp.name)['workspace']
        a,b=Viewer(self),Viewer(self)
        b.request(op='workspace',workspace=second)
        a.input('\x1b[<0;5;3M')
        a.input('\x1b[<32;5;11M')
        self.assertIn('─'*27,a.state['data'])
        a.input('\x1b[<0;5;11m')
        self.assertEqual([w['id'] for w in self.session()['workspaces']],[second,third,first])
        self.assertEqual(a.state['workspace'],first)
        self.assertEqual(b.poll()['workspace'],second)
        a.input('\x1b[<0;5;3M\x1b[<32;5;11M\x1b[<0;50;11m')
        self.assertEqual([w['id'] for w in self.session()['workspaces']],[second,third,first])
        a.input('\x1b[<0;5;3M\x1b[<32;5;11M')
        a.input('\x1b')
        time.sleep(.1);a.poll()
        a.input('\x1b[<0;5;11m')
        self.assertEqual([w['id'] for w in self.session()['workspaces']],[second,third,first])
        self.run_cli('reload',EXE)
        self.assertEqual([w['id'] for w in self.session()['workspaces']],[second,third,first])

    def test_sidebar_width_is_local_and_clamped(self):
        pane=self.new()
        a,b=Viewer(self),Viewer(self)
        a.input('\x1b[<0;28;8M\x1b[<32;40;8M\x1b[<0;40;8m')
        a.poll();b.poll()
        self.assertEqual(self.geometry()[pane][0],60)
        self.assertIn('\x1b[1;41H',a.state['data'])
        self.assertIn('\x1b[1;29H',b.state['data'])
        a.input('\x1b[<0;40;8M\x1b[<32;99;8M\x1b[<0;99;8m')
        self.assertEqual(self.geometry()[pane][0],20)
        a.request(op='size',cols=70,rows=30)
        self.assertIn('\x1b[1;51H',a.state['data'])

    def test_workspace_away_usage_resets_on_visit_and_respects_other_viewers(self):
        pane=self.new()
        home=self.session()['workspaces'][0]['id']
        other=self.command('workspace.create', name='Other', cwd=self.temp.name)['workspace']
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
        self.rpc(op='hook',pane=pane,provider='codex',seq=2,event={'hook_event_name':'PreToolUse','tool_name':'request_user_input','session_id':'usage'})
        self.assertIn('\x1b[1;38;2;243;139;168m1●',a.poll()['data'])
        self.assertNotIn('↓50↑10',a.state['data'])
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
        ws=self.command('workspace.create', name='Target', cwd=self.temp.name)['workspace']
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
        first=self.open_pane(cwd=str(one), command='exec /bin/sh')['pane']
        second=self.open_pane(cwd=str(two), command='exec /bin/sh')['pane']
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
        first=self.open_pane(cwd=str(one), command='exec /bin/sh')['pane']
        second=self.open_pane(cwd=str(two), command='exec /bin/sh')['pane']
        a=Viewer(self);b=Viewer(self)
        a.focus(first);b.focus(second)
        b.action('split','right')
        self.assertEqual(next(p['cwd'] for p in self.session()['panes'] if p['id']==b.state['pane']),str(two.resolve()))
        target=self.rpc(op='viewer.list')['viewers'][0]['id']
        self.rpc(op='focus',pane=second,viewer=target)
        for op in ('new','split'):
            self.rpc(op='action',name=op,value='right' if op=='split' else '',viewer=target)
            created=self.client.poll()['pane']
            self.assertEqual(next(p['cwd'] for p in self.session()['panes'] if p['id']==created),str(two.resolve()))

    def test_selection_and_dialogs_are_viewer_specific(self):
        first=self.new(title='First');second=self.new(title='Second')
        ws=self.command('workspace.create', name='Other', cwd=self.temp.name)['workspace']
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
        self.until(lambda:'ROW_079' in self.command('pane.read', target=first, view='screen')['text'])
        a=Viewer(self);b=Viewer(self);a.focus(first);b.focus(first)
        a.input('\x02sg')
        self.assertIn('ROW_000',a.state['data'])
        self.assertNotIn('ROW_000',b.poll()['data'])
        self.assertIn('ROW_079',b.state['data'])
        self.assertIn('ROW_079',self.command('pane.read', target=first, view='screen')['text'])
        a.input('yy')
        self.assertEqual(len(a.state['effects']),2)
        self.assertEqual(a.state['effects'][0],a.state['effects'][1])
        self.assertIn('52;c;',a.state['effects'][0]['write_terminal'])
        self.assertEqual(a.poll()['effects'],[])
        self.assertEqual(b.poll()['effects'],[])
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
        self.command('pane.input', target=first, data='\r')
        self.until(lambda:'PASTE_STAYS_HERE' in self.command('pane.read', target=first, view='screen')['text'])
        self.assertNotIn('PASTE_STAYS_HERE',self.command('pane.read', target=second, view='screen')['text'])
    def test_independent_edits_from_stale_viewers_compose(self):
        first=self.new(title='First');second=self.new(title='Second')
        a,b=Viewer(self),Viewer(self)
        a.focus(first);b.focus(second)
        a.action('rename','Changed first')
        # b has not received a's snapshot: its operation still names only its tab.
        b.action('rename','Changed second')
        tabs=self.session()['workspaces'][0]['model']['tabs']
        self.assertEqual([t['title'] for t in tabs],['Changed first','Changed second'])
        self.assertEqual(a.poll()['pane'],first)
        self.assertEqual(b.poll()['pane'],second)

    def test_session_edits_reject_invalid_targets_and_stale_dividers_atomically(self):
        first=self.new();viewer=Viewer(self)
        viewer.action('split','right');second=viewer.state['pane']
        old=self.session()['workspaces'][0]
        viewer.action('rename','New title')
        before=self.session()['workspaces']
        invalid=[
            ({'pane.move':dict(target=first)}, 'MissingField'),
            ({'pane.swap':dict(target=first,other=99999)}, 'NoPane'),
            ({'split.ratio':dict(target=first,other=second,ratio=650)}, 'MissingField'),
            ({'split.ratio':dict(target=first,other=second,ratio=650,expected=old['model']['revision'])}, 'StaleLayout'),
            ({'tab.move':dict(target=old['model']['tabs'][0]['id'],destination={'beside':second})}, 'UnknownField'),
        ]
        for command,error in invalid:
            self.assertEqual(self.raw_rpc(op='session.command',protocol=1,command=command)['err'],error)
            self.assertEqual(self.session()['workspaces'],before)

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
        self.assertEqual(len(self.session()['workspaces'][0]['model']['tabs']),2)
        self.assertEqual(b.poll()['pane'],first)
        a.action('join','1');self.assertEqual(a.state['pane'],split)
        a.action('close');self.assertEqual(a.state['pane'],first)
        a.action('undo-close');self.assertNotIn(a.state['pane'],[first,split])
        self.assertIn('restored output',a.state['data'])
        self.assertEqual(b.poll()['pane'],first)

    def test_search_and_selection_copy_do_not_change_other_view(self):
        first=self.new("printf 'SEARCH_MARKER_unique\\n'; i=0; while [ $i -lt 80 ]; do printf 'tail_%03d\\n' $i; i=$((i+1)); done; exec /bin/sh")
        self.until(lambda:'tail_079' in self.command('pane.read', target=first, view='screen')['text'])
        a=Viewer(self);b=Viewer(self);a.focus(first);b.focus(first)
        a.input('\x02s/SEARCH_MARKER_unique\r')
        self.assertIn('SEARCH_MARKER_unique',a.state['data'])
        a.input('y')
        effect=a.state['effects'][0]['write_terminal']
        encoded=effect.split('52;c;',1)[1].split('\x07',1)[0]
        self.assertEqual(base64.b64decode(encoded).decode(),'SEARCH_MARKER_unique')
        self.assertNotIn('SEARCH_MARKER_unique',b.poll()['data'])
    def test_closing_paste_target_does_not_crash_or_redirect_input(self):
        first=self.new('exec /bin/sh');second=self.new('exec /bin/sh')
        a=Viewer(self);a.focus(first)
        a.input('\x1b[200~NOT_A_COMMAND')
        self.command('pane.close', target=first)
        a.input('_SHOULD_DISAPPEAR\x1b[201~')
        self.assertEqual(a.state['pane'],second)
        self.assertNotIn('SHOULD_DISAPPEAR',self.command('pane.read', target=second, view='screen')['text'])
    def test_viewer_encodes_keys_and_mouse_for_child_modes(self):
        fixture=pathlib.Path(self.temp.name,'input.py')
        capture=pathlib.Path(self.temp.name,'input.bin')
        fixture.write_text("import os,tty,sys\ntty.setraw(0)\nos.write(1,b'\\x1b[>1u\\x1b[?1002h\\x1b[?1006hREADY')\nwith open(sys.argv[1],'wb',buffering=0) as f:\n while True:f.write(os.read(0,4096))\n")
        first=self.new(shlex.join([sys.executable,str(fixture),str(capture)]))
        self.until(lambda:'READY' in self.command('pane.read', target=first, view='screen')['text'])
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

    def test_arrows_follow_focused_pane_cursor_mode(self):
        fixture=pathlib.Path(self.temp.name,'arrows.py')
        fixture.write_text("""import os, sys, tty
tty.setraw(0)
def mode(application):
    os.write(1, b'\\x1b[?1h\\rAPPLICATION' if application else b'\\x1b[?1l\\rNORMAL     ')
with open(sys.argv[1], 'wb', buffering=0) as capture:
    mode(sys.argv[2] == 'application')
    while True:
        byte = os.read(0, 1)
        if not byte: break
        if byte == b'n': mode(False)
        elif byte == b'a': mode(True)
        else: capture.write(byte)
""")
        captures=[pathlib.Path(self.temp.name,f'arrows-{i}.bin') for i in range(2)]
        panes=[self.new(shlex.join([sys.executable,str(fixture),str(path),mode]))
               for path,mode in zip(captures,('application','normal'))]
        viewer=Viewer(self)
        expected=[b'',b'']
        def sync_mode(index,label):
            viewer.focus(panes[index])
            # Wait for the actual viewer to consume the mode-changing output,
            # not just for the daemon's screen to contain the readiness marker.
            self.until(lambda:label in viewer.poll()['data'])
        def arrows(index,prefix):
            for incoming in ('[','O'):
                viewer.input(''.join('\x1b'+incoming+key for key in 'ABCD'))
                expected[index]+=b''.join(b'\x1b'+prefix+bytes([key]) for key in b'ABCD')
                self.until(lambda:captures[index].exists() and len(captures[index].read_bytes())>=len(expected[index]))
                self.assertEqual(captures[index].read_bytes(),expected[index])
        sync_mode(0,'APPLICATION')
        arrows(0,b'O')
        sync_mode(1,'NORMAL')
        arrows(1,b'[')
        sync_mode(0,'APPLICATION')
        viewer.input('n')
        sync_mode(0,'NORMAL')
        arrows(0,b'[')
        viewer.input('a')
        sync_mode(0,'APPLICATION')
        arrows(0,b'O')
        self.assertEqual(captures[1].read_bytes(),expected[1])


    def test_queued_focus_and_split_execute_in_the_viewer(self):
        first=self.new();second=self.new();a=Viewer(self);a.focus(first)
        target=self.rpc(op='viewer.list')['viewers'][0]['id']
        second_tab=next(p['tab'] for p in self.session()['panes'] if p['id']==second)
        self.rpc(op='focus',pane=second,viewer=target)
        self.rpc(op='action',name='split',value='right',viewer=target)
        split=a.poll()['pane']
        self.assertEqual(next(p['tab'] for p in self.session()['panes'] if p['id']==split),second_tab)
        self.assertEqual(a.poll()['pane'],split)
        self.assertEqual(len(self.session()['panes']),3)
    def test_delivered_controls_remain_pending_until_acknowledged(self):
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
                delivered=call(op='viewer.sync',interests=[],focus=first)['controls']
                self.assertEqual(delivered[0]['id'],second)
                self.assertEqual(call(op='viewer.sync',interests=[],focus=first)['controls'],delivered)
                self.assertEqual(call(op='viewer.sync',interests=[],focus=second,ack=delivered[0]['seq'])['controls'],[])

    def test_agent_exit_freezes_row_then_fades_without_stale_clicks(self):
        self.new() # Keep a shell pane after the last agent closes.
        first,second=self.new(),self.new()
        self.mark_agent(first,'Departing-agent');self.mark_agent(second,'Surviving-agent')
        self.rpc(op='hook',pane=first,provider='claude',seq=2,event={'hook_event_name':'UserPromptSubmit','session_id':str(first)})
        viewer=Viewer(self);viewer.focus(second)
        before=legacy.screen_text(viewer.poll()['data'],100,30)
        self.assertIn('Departing-agent',before[16][:27])
        self.rpc(op='hook',pane=first,provider='claude',seq=3,event={'hook_event_name':'SessionEnd','session_id':str(first)})
        closing=legacy.screen_text(viewer.poll()['data'],100,30)
        self.assertEqual(before[16][:27],closing[16][:27])
        self.assertNotIn('Session ended','\n'.join(row[:27] for row in closing[16:28]))
        self.assertEqual(viewer.input('\x1b[<0;6;17M\x1b[<0;6;17m')['pane'],second)
        self.command('pane.close',target=first)
        time.sleep(0.3)
        closed=legacy.screen_text(viewer.poll()['data'],100,30)
        self.assertIn('Surviving-agent',closed[16][:27])
        self.assertNotIn('Departing-agent','\n'.join(row[:27] for row in closed[16:28]))
        # Pane closure without a SessionEnd hook uses the same exit path.
        self.command('pane.close',target=second)
        immediate=legacy.screen_text(viewer.poll()['data'],100,30)
        self.assertIn('Surviving-agent',immediate[16][:27])
        time.sleep(0.3)
        completed=legacy.screen_text(viewer.poll()['data'],100,30)
        self.assertNotIn('Surviving-agent','\n'.join(row[:27] for row in completed[16:28]))

if __name__=='__main__':unittest.main(verbosity=2)
