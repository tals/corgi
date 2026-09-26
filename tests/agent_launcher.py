#!/usr/bin/env python3
"""Real viewer launch controls and read-only model previews."""
import json, pathlib, re, unittest, time, shlex, sys, shutil, socket
import smoke
from viewer_client import Viewer

class Launcher(unittest.TestCase):
    def run_cli(self,*args):
        if args==('start',) and not hasattr(self,'usage_fixture_ready'):
            self.usage_fixture_ready=True
            root=pathlib.Path(self.temp.name)
            curl=root/'curl'
            curl.write_text("""#!/usr/bin/env python3
import json,sys
assert 'fixture-token' not in ' '.join(sys.argv)
assert 'Authorization: Bearer fixture-token' in sys.stdin.read()
sys.stdout.write('HTTP/2 200\\r\\n\\r\\n')
print(json.dumps({'account':{'email':'claude@example.com'}} if sys.argv[-1].endswith('/profile') else {'five_hour':{'utilization':12},'seven_day':{'utilization':48}}))
""")
            curl.chmod(0o700)
            self.env['PATH']=str(root)+':'+self.env.get('PATH','')
            settings=pathlib.Path(self.env['CLAUDE_CONFIG_DIR']);settings.mkdir(parents=True,exist_ok=True)
            (settings/'.credentials.json').write_text(json.dumps({'claudeAiOauth':{'accessToken':'fixture-token','subscriptionType':'max','expiresAt':int(time.time()*1000)+60000}}))
        return smoke.Runtime.run_cli(self,*args)
    rpc=smoke.Runtime.rpc
    command=smoke.Runtime.command
    raw_rpc=smoke.Runtime.raw_rpc
    session=smoke.Runtime.session
    until=smoke.Runtime.until
    def setUp(self):
        smoke.Runtime.setUp(self)
        pathlib.Path(self.path + ".viewer.json").write_text(json.dumps({"onboarding_complete":True}))
        self.launches=pathlib.Path(self.temp.name)/'launches.jsonl'
        fixture=pathlib.Path(__file__).with_name('inference_harness.py').resolve()
        pathlib.Path(self.env['CORGI_CODEX_BIN']).write_text(f'''#!/usr/bin/env python3
import json,os,sys,time
if 'app-server' in sys.argv:os.execv(sys.executable,[sys.executable,{str(fixture)!r},*sys.argv[1:]])
if '--version' in sys.argv:print('codex fixture');sys.exit(0)
if sys.argv[1:3]==['auth','status']:
    raise AssertionError('background preview must not invoke auth status')
with open({str(self.launches)!r},'a') as f:f.write(json.dumps({{'cwd':os.getcwd(),'args':sys.argv[1:]}})+'\\n')
print('LAUNCH FIXTURE READY',flush=True)
time.sleep(120)
''')
        settings=pathlib.Path(self.env['CLAUDE_CONFIG_DIR'])/'settings.json'
        settings.parent.mkdir(parents=True,exist_ok=True)
        data=json.loads(settings.read_text()) if settings.exists() else {}
        data['model']='opus';settings.write_text(json.dumps(data))
        self.ws=self.session()['workspaces'][0]['id']
        self.launch_dir=str((pathlib.Path(self.temp.name)/'work').resolve())
        pathlib.Path(self.launch_dir).mkdir()
        self.command('workspace.edit',target=self.ws,cwd=self.launch_dir)
        self.command('pane.create',workspace=self.ws,cwd=self.launch_dir,command='sleep 120')
    def tearDown(self):smoke.Runtime.tearDown(self)
    def click(self,viewer,x,y):return viewer.input(f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m')
    def click_text(self, view, label, cols=120):
        rows=smoke.screen_text(view.poll()['data'],cols,30)
        y,row=next((y,row) for y,row in enumerate(rows) if label in row)
        return self.click(view,row.index(label)+1,y+1)
    def assert_selected(self, view, label, cols=120):
        rows=smoke.screen_text(view.poll()['data'],cols,30)
        self.assertTrue(any(re.search(r'› +([0-9t→] +)?'+re.escape(label),row) for row in rows), '\n'.join(rows))

    def manager_action(self, view, name, action):
        rows=smoke.screen_text(view.poll()['data'],120,30)
        y,row=next((y,row) for y,row in reversed(list(enumerate(rows))) if name in row and '[Edit]' in row)
        return self.click(view,row.index(action)+1,y+1)

    def wait_saved(self, index, source):
        def saved():
            if self.viewers:self.viewers[-1].poll()
            entry=self.session()['agent_commands'][index]
            return entry['bytes'][:entry['len']]==source
        self.until(saved)

    def test_manage_hide_add_edit_and_reload(self):
        view=Viewer(self,120,30)
        view.input('\x02a')
        self.click_text(view,'Manage agents')
        self.click_text(view,'Codex')
        self.assertEqual(self.session()['agent_hidden'],[True,False])
        self.click_text(view,'Paste a command')
        source="FOO=123 claude code --whatever 'two words' --prompt '"+"x"*100+"'\n"
        view.input('\x1b[200~'+source+'\x1b[201~')
        self.assertIn('Claude Code',view.poll()['data'])
        view.input('\r')
        self.wait_saved(0,source.strip())
        self.assertFalse(self.launches.exists())
        entry=self.session()['agent_commands'][0]
        self.assertEqual(entry['bytes'][:entry['len']],source.strip())
        self.manager_action(view,'Claude Code','[✓]')
        self.assertTrue(self.session()['agent_commands'][0]['hidden'])
        self.click_text(view,'[Done]')
        rows=smoke.screen_text(view.poll()['data'],120,30)
        self.assertFalse(any('Codex' in row for row in rows))
        self.assertEqual(sum('Claude Code' in row for row in rows),1)
        self.click_text(view,'Manage agents')
        self.manager_action(view,'Claude Code','[ ]')
        self.manager_action(view,'Claude Code','[Edit]')
        changed='FOO=456 claude --model sonnet'
        view.input('\x1b[200~'+changed+'\x1b[201~')
        view.input('\r')
        self.wait_saved(0,changed)
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.assertEqual(self.session()['agent_hidden'],[True,False])
        entry=self.session()['agent_commands'][0]
        self.assertEqual(entry['bytes'][:entry['len']],changed)
        self.assertFalse(entry['hidden'])
        self.manager_action(view,'Claude Code','[✓]')
        self.manager_action(view,'Claude Code','[Edit]')
        view.input('\x03\r')
        self.assertEqual(self.session()['agent_commands'][0]['len'],0)
        self.assertFalse(self.session()['agent_commands'][0]['hidden'])
        self.click_text(view,'Paste a command')
        view.input('replacement-agent\r')
        self.wait_saved(0,'replacement-agent')
        self.assertFalse(self.session()['agent_commands'][0]['hidden'])
        self.click_text(view,'[Done]')
        self.assertIn('Custom agent',view.poll()['data'])

    def test_manager_focus_inline_add_and_builtin_edit(self):
        view=Viewer(self,120,30)
        view.input('\x02a');self.click_text(view,'Manage agents')
        view.input('FOO=123 claude --model sonnet')
        self.assertIn('FOO=123 claude --model sonnet',view.poll()['data'])
        self.click_text(view,'[Add]')
        self.wait_saved(0,'FOO=123 claude --model sonnet')
        self.assertEqual(self.session()['agent_commands'][0]['len'],len('FOO=123 claude --model sonnet'))
        self.assertFalse(self.launches.exists())
        self.manager_action(view,'Codex','[Edit]')
        view.input('codex --model example')
        self.click_text(view,'[Save]')
        self.wait_saved(1,'codex --model example')
        self.assertTrue(self.session()['agent_hidden'][0])
        entry=self.session()['agent_commands'][1]
        self.assertEqual(entry['bytes'][:entry['len']],'codex --model example')
        self.assertIn('Paste a command',view.poll()['data'])
        view.input('abc');view.input('\x1b[D');view.input('X')
        self.assertIn('abXc',view.poll()['data'])
        view.input('\x1b')
        self.until(lambda:'New agent' in view.poll()['data'])

    def test_command_name_and_semantic_account_preview(self):
        view=Viewer(self,120,30)
        view.input('\x02a');self.click_text(view,'Manage agents')
        source='ANTHROPIC_API_KEY=fixture-secret claude --model sonnet --dangerously-skip-permissions'
        view.input(source)
        self.until(lambda:'API key - identity unavailable' in view.poll()['data'])
        self.assertIn('Skips permission checks',view.poll()['data'])
        self.assertIn('Claude Code - sonnet',view.poll()['data'])
        view.input('\tTeam assistant')
        self.click_text(view,'[Add]')
        self.wait_saved(0,source)
        entry=self.session()['agent_commands'][0]
        self.assertEqual(entry['name']['bytes'][:entry['name']['len']],'Team assistant')
        self.assertIn('Team assistant',view.poll()['data'])
        self.manager_action(view,'Team assistant','[✓]')
        self.assertEqual(self.session()['agent_commands'][0]['name'],entry['name'])
        self.manager_action(view,'Team assistant','[Edit]')
        view.input('\tRenamed assistant\r')
        self.until(lambda:view.poll() and self.session()['agent_commands'][0]['name']['bytes'].startswith('Renamed assistant'))
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.assertTrue(self.session()['agent_commands'][0]['name']['bytes'].startswith('Renamed assistant'))

    def test_custom_agent_account_in_picker(self):
        config=pathlib.Path(self.temp.name)/'work-profile'
        config.mkdir()
        (config/'.claude.json').write_text(json.dumps({'oauthAccount':{'emailAddress':'work@example.com'}}))
        self.command('agent.command',index=0,command='CLAUDE_CONFIG_DIR='+shlex.quote(str(config))+' claude --dangerously-skip-permissions',name='Work')
        view=Viewer(self,160,30)
        view.input('\x02a')
        rows=smoke.screen_text(view.poll()['data'],160,30)
        row=next(row for row in rows if 'Work' in row and 'work@example.com' in row)
        self.assertIn('✓',row)
        self.assertIn('(cached)',row)

    def test_signed_out_claude_is_hidden_but_manageable(self):
        self.run_cli('shutdown')
        self.until(lambda:not pathlib.Path(self.path).exists())
        (pathlib.Path(self.env['CLAUDE_CONFIG_DIR'])/'.credentials.json').unlink()
        for key in ('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'):
            self.env.pop(key,None)
        self.run_cli('start')
        ws=self.session()['workspaces'][0]['id']
        def preview():return self.rpc(op='agent.preview',protocol=1,workspace=ws,cwd=self.launch_dir)['preview']
        self.until(lambda:not preview()['pending'],timeout=12)
        self.assertFalse(preview()['options'][1]['signed_in'])
        view=Viewer(self,120,30)
        view.input('\x02a')
        self.until(lambda:'Claude Code' not in view.poll()['data'])
        view.input('\x1b');view.input('\x02a')
        self.assertNotIn('Claude Code',view.poll()['data'])
        self.click_text(view,'Manage agents')
        self.assertIn('Not signed in',view.poll()['data'])

    def shell_alias_case(self, name):
        shell=shutil.which(name)
        if not shell:self.skipTest(name+' is not installed')
        self.run_cli('shutdown')
        self.until(lambda:not pathlib.Path(self.path).exists())
        root=pathlib.Path(self.temp.name)
        result=root/'shell-result.json'
        script=root/'record-agent'
        script.write_text('#!'+sys.executable+'\nimport os,sys,json,pathlib\npathlib.Path('+repr(str(result))+').write_text(json.dumps({"foo":os.environ.get("FOO"),"args":sys.argv[1:]}))\n')
        script.chmod(0o700)
        self.env['SHELL']=shell
        self.env['ZDOTDIR']=str(root)
        self.env['XDG_CONFIG_HOME']=str(root/'.config')
        if name=='fish':
            config=root/'.config/fish/config.fish';config.parent.mkdir(parents=True)
            config.write_text('function launchit\n '+shlex.quote(str(script))+' --preset $argv\nend\nalias myagent launchit\n')
        else:
            (root/('.bashrc' if name=='bash' else '.zshrc')).write_text('launchit() { '+shlex.quote(str(script))+' --preset "$@"; }\nalias myagent=\'launchit --fixed\'\n')
        self.run_cli('start')
        ws=self.session()['workspaces'][0]['id']
        source="FOO='123 with spaces' myagent --whatever 'two words'"
        self.command('agent.command',index=0,command=source)
        self.assertFalse(result.exists())
        saved=self.session()['agent_commands'][0]
        saved=saved['bytes'][:saved['len']]
        self.assertNotIn('myagent',saved)
        self.assertNotIn('launchit',saved)
        if name=='fish':config.write_text('function myagent\n echo WRONG\nend\n')
        else:(root/('.bashrc' if name=='bash' else '.zshrc')).write_text('alias myagent=false\n')
        self.command('agent.command.create',workspace=ws,cwd=self.launch_dir,index=0)
        self.until(result.exists)
        self.assertEqual(json.loads(result.read_text()),{'foo':'123 with spaces','args':['--preset',*(['--fixed'] if name!='fish' else []),'--whatever','two words']})

    def test_fish_cc_resolves_body_and_persists_claude_label(self):
        self.run_cli('shutdown')
        self.until(lambda:not pathlib.Path(self.path).exists())
        root=pathlib.Path(self.temp.name)
        self.env['SHELL']=shutil.which('fish') or '/opt/homebrew/bin/fish'
        self.env['XDG_CONFIG_HOME']=str(root/'.config')
        config=root/'.config/fish/config.fish';config.parent.mkdir(parents=True)
        config.write_text("function cc --wraps=/stale/yesplz --wraps='claude --dangerously-skip-permissions'\n claude --allow-dangerously-skip-permissions --dangerously-skip-permissions $argv\nend\n")
        self.run_cli('start')
        view=Viewer(self,120,30)
        view.input('\x02a');self.click_text(view,'Manage agents')
        view.input('cc\r')
        self.wait_saved(0,'command claude --allow-dangerously-skip-permissions --dangerously-skip-permissions')
        entry=self.session()['agent_commands'][0]
        self.assertEqual(entry['bytes'][:entry['len']],'command claude --allow-dangerously-skip-permissions --dangerously-skip-permissions')
        self.assertIn('Claude Code',view.poll()['data'])
        config.write_text('function cc\n false\nend\n')
        self.manager_action(view,'Claude Code','[✓]')
        self.manager_action(view,'Claude Code','[ ]')
        self.assertEqual(self.session()['agent_commands'][0]['bytes'],entry['bytes'])
        self.assertFalse(self.launches.exists())

    def test_debounced_preview_is_frozen_on_add_and_delete_is_inline(self):
        self.run_cli('shutdown')
        self.until(lambda:not pathlib.Path(self.path).exists())
        root=pathlib.Path(self.temp.name)
        self.env['SHELL']=shutil.which('fish') or '/opt/homebrew/bin/fish'
        self.env['XDG_CONFIG_HOME']=str(root/'.config')
        config=root/'.config/fish/config.fish';config.parent.mkdir(parents=True)
        log=root/'shell-starts'
        prefix='echo lookup >> '+shlex.quote(str(log))+'\n'
        config.write_text(prefix+"alias cc 'claude --model original'\n")
        self.run_cli('start')
        view=Viewer(self,120,30)
        view.input('\x02a');self.click_text(view,'Manage agents')
        baseline=log.read_text() if log.exists() else ''
        view.input('c');time.sleep(.1);view.input('c')
        self.assertEqual(log.read_text() if log.exists() else '',baseline)
        self.until(lambda:'[Show command]' in view.poll()['data'])
        self.click_text(view,'[Show command]')
        self.assertIn('command claude --model original',view.poll()['data'])
        self.assertEqual(self.session()['agent_commands'][0]['len'],0)
        before=log.read_text()
        config.write_text(prefix+"alias cc 'claude --model changed'\n")
        time.sleep(.4);view.poll()
        self.assertEqual(log.read_text(),before)
        self.click_text(view,'[Add]')
        self.wait_saved(0,'command claude --model original')
        self.assertEqual(log.read_text(),before)
        self.manager_action(view,'Claude Code','[Edit]')
        rows=smoke.screen_text(view.poll()['data'],120,30)
        self.assertTrue(any('│ cc ' in row for row in rows))
        self.assertNotIn('Runs:',view.poll()['data'])
        self.click_text(view,'[Show command]')
        self.assertIn('command claude --model original',view.poll()['data'])
        self.click_text(view,'[Cancel]')
        self.assertIn('Paste a command',view.poll()['data'])
        self.manager_action(view,'Claude Code','[Edit]')
        view.input('\tFrozen assistant')
        self.click_text(view,'[Save]')
        self.wait_saved(0,'command claude --model original')
        self.assertEqual(log.read_text(),before)
        self.manager_action(view,'Frozen assistant','[Delete]')
        self.assertEqual(self.session()['agent_commands'][0]['len'],0)
        self.assertNotIn('[Delete]',view.poll()['data'])
        self.assertFalse(self.launches.exists())
        config.write_text(prefix+"sleep .3\nalias cc 'claude --model stale'\n")
        previous=log.read_text()
        view.input('cc')
        self.until(lambda:view.poll() and log.read_text()!=previous)
        view.input('\x15codex --model latest\r')
        self.wait_saved(0,'codex --model latest')
        self.assertNotIn('stale',self.session()['agent_commands'][0]['bytes'])

    def test_bash_alias_and_inline_environment(self):self.shell_alias_case('bash')
    def test_zsh_alias_and_inline_environment(self):self.shell_alias_case('zsh')
    def test_fish_alias_and_inline_environment(self):self.shell_alias_case('fish')

    def test_preview_launch_last_choice_and_reload(self):
        view=Viewer(self,100,30)
        self.assertIn('New',smoke.screen_text(view.poll()['data'],100,30)[14])
        self.click(view,26,15)
        self.until(lambda:'fixture-codex' in view.poll()['data'],timeout=12)
        text='\n'.join(smoke.screen_text(view.poll()['data'],100,30))
        self.assertIn('Claude Code',text);self.assertIn('opus',text);self.assertNotIn('User settings',text)
        self.assertIn('codex@example.com',text);self.assertIn('claude@example.com',text)
        rows=smoke.screen_text(view.poll()['data'],100,30)
        self.assertTrue(any('Codex' in row and 'fixture-codex' in row and 'codex@example.com' in row for row in rows))
        self.assertTrue(any('Claude Code' in row and 'opus' in row and 'claude@example.com' in row for row in rows))
        self.assertTrue(any('Codex' in row and 'pro' in row and '5h 23% / 7d 61%' in row for row in rows))
        self.assertTrue(any('Claude Code' in row and 'max' in row and '5h 12% / 7d 48%' in row for row in rows))
        self.assertFalse(self.launches.exists());self.assertEqual(len(self.session()['panes']),1)
        y=next(i for i,row in enumerate(rows) if 'Claude Code' in row and 'opus' in row)
        self.click(view,rows[y].index('Claude Code')+1,y+1)
        self.until(lambda:self.launches.exists())
        self.assertEqual(self.session()['last_agent'],'claude')
        self.assertEqual(len(self.session()['panes']),2)
        self.assertEqual(json.loads(self.launches.read_text().splitlines()[0])['cwd'],self.launch_dir)
        other=Viewer(self,100,30)
        self.click(other,20,15)
        self.until(lambda:len(self.launches.read_text().splitlines())==2)
        self.assertEqual(self.session()['last_agent'],'claude')
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.assertEqual(self.session()['last_agent'],'claude')
        self.click(other,26,15);other.input('k\r')
        self.until(lambda:len(self.launches.read_text().splitlines())==3)
        self.assertEqual(self.session()['last_agent'],'codex')
    def test_yolo_per_provider_toggle_launch_and_reload(self):
        view=Viewer(self,120,30)
        self.click(view,26,15)
        rows=smoke.screen_text(view.poll()['data'],120,30)
        y=next(i for i,row in enumerate(rows) if 'Codex' in row)
        x=rows[y].index('·')
        self.click(view,x+1,y+1)
        self.assertEqual(self.session()['agent_yolo'],[True,False])
        self.assertEqual(len(self.session()['panes']),1)
        self.assertIn('New agent',view.poll()['data'])
        view.input('j');view.input('y')
        self.assertEqual(self.session()['agent_yolo'],[True,True])
        view.input('y')
        self.assertEqual(self.session()['agent_yolo'],[True,False])
        view.input('k');view.input('a')
        self.until(self.launches.exists)
        self.assertIn('--dangerously-bypass-approvals-and-sandbox',json.loads(self.launches.read_text().splitlines()[0])['args'])
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.assertEqual(self.session()['agent_yolo'],[True,False])
        self.command('agent.yolo',provider='claude',enabled=True)
        self.command('agent.create',workspace=self.ws,provider='claude')
        self.until(lambda:len(self.launches.read_text().splitlines())==2)
        self.assertIn('--dangerously-skip-permissions',json.loads(self.launches.read_text().splitlines()[1])['args'])
        self.command('agent.yolo',provider='codex',enabled=False)
        self.command('agent.create',workspace=self.ws,provider='codex')
        self.until(lambda:len(self.launches.read_text().splitlines())==3)
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox',json.loads(self.launches.read_text().splitlines()[2])['args'])
    def test_hover_and_dismiss_do_not_launch(self):
        view=Viewer(self,80,24)
        shown=view.input('\x1b[<35;21;12M')
        self.assertIn('New agent',shown['data'])
        self.assertEqual(len(self.session()['panes']),1)
        view.input('\x1b[<35;75;2M')
        self.until(lambda:'New agent' not in view.poll()['data'])
        self.click(view,26,12);self.assertIn('New agent',view.poll()['data'])
        self.click(view,75,2);self.assertNotIn('New agent',view.poll()['data'])
        self.assertFalse(self.launches.exists())

    def test_subscription_pushes_updates_and_survives_idle_reload(self):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(12);client.connect(self.path)
            with client.makefile('rb') as stream:
                client.sendall((json.dumps(dict(op='agent.subscribe',protocol=1,workspace=self.ws,cwd=self.launch_dir))+'\n').encode())
                initial=json.loads(stream.readline())
                self.assertEqual(initial['type'],'agent.preview')
                while initial['preview']['pending']:initial=json.loads(stream.readline())
                self.assertEqual(initial['cwd'],self.launch_dir)
                self.assertEqual(initial['preview']['options'][1]['model']['bytes'][:4],'opus')
                time.sleep(5.2) # Preview subscriptions must outlive ordinary RPC clients.
                settings=pathlib.Path(self.launch_dir)/'.claude/settings.json'
                settings.parent.mkdir();settings.write_text(json.dumps({'model':'sonnet'}))
                self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
                # No new preview request: the existing subscription publishes
                # the background read and retains values while it is pending.
                update=json.loads(stream.readline())
                while update['preview']['pending']:
                    self.assertEqual(update['preview']['options'][1]['model']['bytes'][:4],'opus')
                    update=json.loads(stream.readline())
                self.assertEqual(update['preview']['options'][1]['model']['bytes'][:6],'sonnet')
                # Changing subscription context must select the new directory.
                other=pathlib.Path(self.temp.name)/'other';other.mkdir()
                client.sendall((json.dumps(dict(op='agent.subscribe',protocol=1,workspace=self.ws,cwd=str(other)))+'\n').encode())
                update=json.loads(stream.readline())
                while update['preview']['pending']:update=json.loads(stream.readline())
                self.assertEqual(update['cwd'],str(other))
                self.assertEqual(update['preview']['options'][1]['model']['bytes'][:4],'opus')

    def test_reopening_uses_pushed_preview_on_first_frame(self):
        view=Viewer(self,160,30)
        view.input('\x02a')
        self.until(lambda:'claude@example.com' in view.poll()['data'],timeout=12)
        self.click(view,158,2)
        for _ in range(3):
            shown=view.input('\x1b[<35;21;15M')
            self.assertIn('New agent',shown['data'])
            self.assertNotIn('Reading','\n'.join(smoke.screen_text(shown['data'],160,30)))
            self.assertIn('fixture-codex',shown['data'])
            self.assertIn('claude@example.com',shown['data'])
            self.assertIn('12%',shown['data'])
            self.assertNotIn('New agent',view.input('\x1b[<35;158;2M')['data'])
        shown=view.input('\x02a')
        self.assertNotIn('Reading',shown['data'])
        self.assertIn('fixture-codex',shown['data'])
        self.assertFalse(self.launches.exists())
    def test_popup_arrows_tabs_escape_and_enter_own_keyboard(self):
        root=pathlib.Path(self.temp.name);keys=root/'keys';ready=root/'ready'
        script="import os,tty,pathlib;tty.setraw(0);pathlib.Path("+repr(str(ready))+").touch();f=open("+repr(str(keys))+",'wb',buffering=0)\nwhile True:f.write(os.read(0,1024))"
        pane=self.command('pane.create',workspace=self.ws,cwd=self.launch_dir,command=shlex.join([sys.executable,'-u','-c',script]))['pane']
        self.until(ready.exists)
        view=Viewer(self,100,30);view.focus(pane)
        view.input('\x1b[<35;21;15M')
        self.until(lambda:'New agent' in view.poll()['data'])
        def selected(provider):
            rows=smoke.screen_text(view.poll()['data'],100,30)
            self.assertTrue(any(re.search(r'› +([0-9t→] +)?'+re.escape(provider),row) for row in rows), '\n'.join(rows))
        view.input('\x1b[B');selected('Claude Code')
        view.input('\x1b[B');selected('New terminal')
        view.input('\x1b[B');selected('Manage agents')
        view.input('\x1b[A');selected('New terminal')
        view.input('\x1b[A');selected('Claude Code')
        view.input('\x1b[A');selected('Codex')
        view.input('\x1b[A');selected('Codex')
        view.input('\x1b[F');selected('New terminal')
        view.input('\x1b[H');selected('Codex')
        view.input('\x1b[Z');selected('Manage agents')
        view.input('\t');selected('Codex')
        view.input('\x1b')
        self.until(lambda:'New agent' not in view.poll()['data'])
        time.sleep(.6)
        self.assertNotIn('New agent',view.poll()['data'])
        self.assertEqual(keys.read_bytes(),b'')
        view.input('\x1b[<35;98;2M')
        view.input('\x1b[<35;21;15M')
        self.until(lambda:'New agent' in view.poll()['data'])
        self.click(view,26,15)
        view.input('\x1bOB');selected('Claude Code')
        view.input('\r')
        self.until(lambda:self.launches.exists())
        self.assertEqual(self.session()['last_agent'],'claude')
        self.assertEqual(keys.read_bytes(),b'')

    def test_new_agent_shortcut_preview_then_launch(self):
        view=Viewer(self,100,30)
        for shortcut, launch in (('\x02a','a'), ('\x02A','A'), ('\x02\x01','\x01'), ('\x1b[98;5u\x1b[97;5u','\x1b[97;5u')):
            before=len(self.session()['panes'])
            self.assertIn('New agent',view.input(shortcut)['data'])
            self.assertEqual(len(self.session()['panes']),before)
            view.input('\x1b[H');view.input('\x1b[B')
            self.assertRegex(view.poll()['data'], r' a \S* launch  \S* y \S* YOLO')
            view.input(launch)
            self.until(lambda:len(self.session()['panes'])==before+1)
            self.assertEqual(self.session()['last_agent'],'claude')
        view.input('\x1b[<35;21;15M')
        self.assertIn('New agent',view.poll()['data'])
        before=len(self.session()['panes'])
        view.input('\x02A')
        self.assertEqual(len(self.session()['panes']),before)
        view.input('A')
        self.until(lambda:len(self.session()['panes'])==before+1)

    def test_numbered_agent_shortcuts_follow_visible_rows(self):
        view=Viewer(self,120,30)
        view.input('\x02a')
        rows=smoke.screen_text(view.poll()['data'],120,30)
        self.assertTrue(any(re.search(r'0 +Codex',row) for row in rows))
        self.assertTrue(any(re.search(r'1 +Claude Code',row) for row in rows))
        self.assertTrue(any(re.search(r't +New terminal',row) for row in rows))
        before=len(self.session()['panes'])
        view.input('1')
        self.until(lambda:len(self.session()['panes'])==before+1)
        self.assertEqual(self.session()['last_agent'],'claude')
        self.command('agent.visibility',hidden=[True,False])
        self.command('agent.command',index=0,command='sleep 120',name='Custom sleeper',resolve=False)
        view.input('\x02a')
        rows=smoke.screen_text(view.poll()['data'],120,30)
        self.assertTrue(any(re.search(r'0 +Claude Code',row) for row in rows))
        self.assertTrue(any(re.search(r'1 +Custom sleeper',row) for row in rows))
        before=len(self.session()['panes'])
        view.input('9')
        self.assertEqual(len(self.session()['panes']),before)
        view.input('1')
        self.until(lambda:len(self.session()['panes'])==before+1)
        self.assertNotIn('New agent',view.poll()['data'])

    def test_selection_survives_dismiss_and_other_viewer_launch(self):
        view=Viewer(self,120,30)
        view.input('\x02a');view.input('\x1b[F')
        view.input('\x1b');view.input('\x02a')
        self.assert_selected(view,'New terminal')
        self.click_text(view,'Manage agents')
        view.input('\x1b')
        self.until(lambda:'New agent' in view.poll()['data'])
        self.assert_selected(view,'New terminal')
        view.input('\x1b')
        other=Viewer(self,120,30)
        other.input('\x02a');other.input('1')
        self.until(lambda:self.session()['last_agent']=='claude')
        view.input('\x02a')
        self.assert_selected(view,'New terminal')
        view.input('\x1b')
        view.input('\x1b[<35;118;2M')
        view.input('\x1b[<35;21;15M')
        rows=smoke.screen_text(view.poll()['data'],120,30)
        y,row=next((y,row) for y,row in enumerate(rows) if 'Codex' in row)
        view.input(f'\x1b[<35;{row.index("Codex")+1};{y+1}M')
        view.input('\x1b[<35;118;2M')
        self.assertNotIn('New agent',view.poll()['data'])
        view.input('\x02a')
        self.assert_selected(view,'Codex')

    def test_custom_selection_survives_launch_and_hidden_row_falls_back(self):
        self.command('agent.command',index=0,command='sleep 120',name='Custom sleeper',resolve=False)
        view=Viewer(self,120,30)
        view.input('\x02a');view.input('2')
        self.assertEqual(len(self.session()['panes']),2)
        view.input('\x02a')
        self.assert_selected(view,'Custom sleeper')
        self.click(view,118,2)
        view.input('\x02a')
        self.assert_selected(view,'Custom sleeper')
        view.input('\x1b')
        self.command('agent.command',index=0,command='sleep 120',name='Custom sleeper',hidden=True,resolve=False)
        view.input('\x02a')
        self.assert_selected(view,'Codex')
        self.assertNotIn('Custom sleeper',view.poll()['data'])

    def test_new_terminal_row_opens_a_plain_tab(self):
        view=Viewer(self,100,30)
        self.assertIn('New terminal',view.input('\x02a')['data'])
        before=len(self.session()['panes'])
        view.input('t')
        self.until(lambda:len(self.session()['panes'])==before+1)
        self.assertNotIn('New agent',view.poll()['data'])
        view.input('\x02a')
        self.assert_selected(view,'New terminal',100)
        self.assertRegex(view.poll()['data'], r' a \S* open')
        view.input('\r')
        self.until(lambda:len(self.session()['panes'])==before+2)
        view.input('\x02a');view.input('\x02a')
        self.assertEqual(len(self.session()['panes']),before+2)
        self.assertIn('New agent',view.poll()['data'])
        view.input('t')
        self.until(lambda:len(self.session()['panes'])==before+3)
        self.assertNotIn('New agent',view.poll()['data'])
        self.assertFalse(self.launches.exists())

    def test_hover_accepts_launch_keys(self):
        view=Viewer(self,100,30)
        for launch in ('a', 'A', '\x01', '\x1b[97;5u'):
            view.input('\x1b[<35;98;2M')
            self.assertIn('New agent',view.input('\x1b[<35;21;15M')['data'])
            before=len(self.session()['panes'])
            view.input(launch)
            self.until(lambda:len(self.session()['panes'])==before+1)
            self.assertNotIn('New agent',view.poll()['data'])

    def test_claude_subscription_usage_and_private_auth_header(self):
        self.run_cli('shutdown')
        self.until(lambda:not pathlib.Path(self.path).exists())
        root=pathlib.Path(self.temp.name)
        curl=root/'curl'
        curl.write_text("""#!/usr/bin/env python3
import json,sys
assert 'fixture-token' not in ' '.join(sys.argv)
assert sys.argv[-1] in ('https://api.anthropic.com/api/oauth/usage','https://api.anthropic.com/api/oauth/profile')
assert 'Authorization: Bearer fixture-token' in sys.stdin.read()
sys.stdout.write('HTTP/2 200\\r\\n\\r\\n')
print(json.dumps({'account':{'email':'claude@example.com'}} if sys.argv[-1].endswith('/profile') else {'five_hour':{'utilization':12,'resets_at':'2099-01-01T12:00:00.000000+00:00'},'seven_day':{'utilization':48,'resets_at':'2099-01-04T12:00:00Z'}}))
""")
        curl.chmod(0o700)
        self.env['PATH']=str(root)+':'+self.env.get('PATH','')
        (pathlib.Path(self.env['CLAUDE_CONFIG_DIR'])/'.credentials.json').write_text(json.dumps({'claudeAiOauth':{'accessToken':'fixture-token','subscriptionType':'max','expiresAt':int(time.time()*1000)+60000}}))
        self.run_cli('start')
        ws=self.session()['workspaces'][0]['id']
        def preview():return self.rpc(op='agent.preview',protocol=1,workspace=ws,cwd=self.launch_dir)['preview']
        self.until(lambda:not preview()['pending'],timeout=12)
        option=preview()['options'][1]
        self.assertEqual(option['plan']['bytes'][:option['plan']['len']],'max')
        self.assertEqual(option['usage']['bytes'][:option['usage']['len']],'5h 12% / 7d 48%')
        self.assertNotIn('fixture-token',json.dumps(preview()))
        self.assertTrue(all(stamp is not None for stamp in option['resets']['at']))
        view=Viewer(self,160,30)
        view.input('\x02a')
        self.until(lambda:'Resets in' in view.poll()['data'])
        rows=smoke.screen_text(view.poll()['data'],160,30)
        row=next(row for row in rows if 'Claude Code' in row)
        self.assertIn('5h 12% / 7d 48%',row)
        self.assertRegex(row,r'5h \d+d')

    def account_cache_fixture(self):
        root=pathlib.Path(self.temp.name)
        log=root/'account-requests.jsonl'
        mode=root/'usage-mode'
        mode.write_text('ok')
        (root/'curl').write_text(f"""#!/usr/bin/env python3
import json,sys,pathlib
headers=sys.stdin.read()
assert 'fixture-token' not in ' '.join(sys.argv)
endpoint=sys.argv[-1].rsplit('/',1)[-1]
with open({str(log)!r},'a') as f:f.write(json.dumps(endpoint)+'\\n')
limited=endpoint=='usage' and pathlib.Path({str(mode)!r}).read_text()=='limited'
sys.stdout.write('HTTP/2 429\\r\\nRetry-After: 120\\r\\n\\r\\n' if limited else 'HTTP/2 200\\r\\n\\r\\n')
print(json.dumps({{'error':{{'type':'rate_limit_error'}}}} if limited else {{'account':{{'email':'claude@example.com'}}}} if endpoint=='profile' else {{'five_hour':{{'utilization':12}},'seven_day':{{'utilization':48}}}}))
""")
        return log,mode

    def directory_preview(self, name):
        directory=pathlib.Path(self.temp.name)/name
        directory.mkdir(exist_ok=True)
        def preview():return self.rpc(op='agent.preview',protocol=1,workspace=self.ws,cwd=str(directory))['preview']
        self.until(lambda:not preview()['pending'],timeout=12)
        return preview()['options'][1]

    def test_account_requests_shared_across_directories_reload_and_credentials(self):
        log,_=self.account_cache_fixture()
        for i in range(10):self.directory_preview('dir'+str(i))
        self.assertEqual(log.read_text().splitlines().count('"usage"'),1)
        self.assertEqual(log.read_text().splitlines().count('"profile"'),1)
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.directory_preview('after-reload')
        self.assertEqual(log.read_text().splitlines().count('"usage"'),1)
        credentials=pathlib.Path(self.env['CLAUDE_CONFIG_DIR'])/'.credentials.json'
        data=json.loads(credentials.read_text());data['claudeAiOauth']['accessToken']='fixture-token-other'
        credentials.write_text(json.dumps(data))
        self.directory_preview('other-account')
        self.assertEqual(log.read_text().splitlines().count('"usage"'),2)
        cache=pathlib.Path(self.env['XDG_STATE_HOME'])/'corgi/account-previews'
        self.assertNotIn('fixture-token',''.join(p.name+p.read_text() for p in cache.glob('*.json')))

    def test_rate_limit_keeps_identity_and_cached_usage_and_honors_cooldown(self):
        log,mode=self.account_cache_fixture()
        self.directory_preview('initial')
        cache=next((pathlib.Path(self.env['XDG_STATE_HOME'])/'corgi/account-previews').glob('claude-*.json'))
        state=json.loads(cache.read_text());state['next_usage']=0;state['next_profile']=0
        cache.write_text(json.dumps(state));mode.write_text('limited')
        option=self.directory_preview('limited')
        text=lambda field:option[field]['bytes'][:option[field]['len']]
        self.assertEqual(text('account'),'claude@example.com')
        self.assertIn('cached',text('usage'))
        self.assertIn('12%',text('usage'))
        self.assertGreaterEqual(json.loads(cache.read_text())['next_usage'],time.time()+115)
        self.rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.directory_preview('still-limited')
        self.assertEqual(log.read_text().splitlines().count('"usage"'),2)

    def test_first_usage_429_still_fetches_profile(self):
        log,mode=self.account_cache_fixture();mode.write_text('limited')
        option=self.directory_preview('limited-first')
        self.assertEqual(option['account']['bytes'][:option['account']['len']],'claude@example.com')
        self.assertEqual(option['usage']['bytes'][:option['usage']['len']],'Rate limited')
        self.directory_preview('another-directory')
        self.assertEqual(log.read_text().splitlines().count('"usage"'),1)

    def consent_fixture(self, allowed=False, deny=False):
        self.run_cli('shutdown')
        self.until(lambda:not pathlib.Path(self.path).exists())
        root=pathlib.Path(self.temp.name)
        credentials=json.dumps({'claudeAiOauth':{'accessToken':'fixture-token','subscriptionType':'max','expiresAt':int(time.time()*1000)+60000}})
        fixture=root/'credentials-fixture.json'
        fixture.write_text(json.dumps({
            'silent':{'credentials':credentials} if allowed else {'needs_consent':True},
            'interactive':{'needs_consent':True,'delay_ms':250} if deny else {'credentials':credentials,'delay_ms':250},
        }))
        self.consent_log=root/'credential-access.log'
        self.env['CORGI_TEST_CLAUDE_CREDENTIALS']=str(fixture)
        self.env['CORGI_TEST_CLAUDE_CREDENTIAL_LOG']=str(self.consent_log)
        curl=root/'curl'
        curl.write_text("""#!/usr/bin/env python3
import json,sys
assert 'fixture-token' not in ' '.join(sys.argv)
assert 'Authorization: Bearer fixture-token' in sys.stdin.read()
sys.stdout.write('HTTP/2 200\\r\\n\\r\\n')
print(json.dumps({'account':{'email':'claude@example.com'}} if sys.argv[-1].endswith('/profile') else {'five_hour':{'utilization':12},'seven_day':{'utilization':48}}))
""")
        curl.chmod(0o700)
        self.env['PATH']=str(root)+':'+self.env.get('PATH','')
        self.run_cli('start')
        self.ws=self.session()['workspaces'][0]['id']
        self.command('pane.create',workspace=self.ws,cwd=self.launch_dir,command='sleep 120')
        return Viewer(self,100,30)

    def usage_rows(self, view):
        return smoke.screen_text(view.poll()['data'],100,30)

    def test_track_usage_is_explicit_and_does_not_launch_an_agent(self):
        view=self.consent_fixture()
        self.until(self.consent_log.exists)
        self.assertEqual(self.consent_log.read_text().splitlines(),['silent'])
        self.click(view,26,15)
        self.until(lambda:any('Claude Code' in row and 'Track usage' in row for row in self.usage_rows(view)))
        self.assertEqual(self.consent_log.read_text().splitlines(),['silent'])
        # Reopening the menu and hover/polling never authorize a prompt.
        view.input('\x1b');self.click(view,26,15)
        rows=self.usage_rows(view)
        y,row=next((y,row) for y,row in enumerate(rows) if 'Claude Code' in row)
        x=row.index('Track usage')
        count=len(self.session()['panes'])
        self.click(view,x+1,y+1)
        self.click(view,x+1,y+1) # A second click while pending must not launch.
        self.until(lambda:any('Claude Code' in row and '5h 12% / 7d 48%' in row for row in self.usage_rows(view)))
        self.assertEqual(self.consent_log.read_text().splitlines(),['silent','interactive'])
        self.assertEqual(len(self.session()['panes']),count)
        self.assertFalse(self.launches.exists())
        self.assertIn('New agent',view.poll()['data'])

    def test_denied_tracking_is_not_retried_interactively(self):
        view=self.consent_fixture(deny=True)
        self.click(view,26,15)
        self.until(lambda:'Track usage' in view.poll()['data'])
        view.input('\x1b[B');view.input('u')
        self.until(lambda:self.consent_log.read_text().splitlines().count('interactive')==1)
        self.until(lambda:'Track usage' in view.poll()['data'])
        another=pathlib.Path(self.temp.name)/'another';another.mkdir()
        def preview():return self.rpc(op='agent.preview',protocol=1,workspace=self.ws,cwd=str(another))['preview']
        self.until(lambda:not preview()['pending'])
        self.assertEqual(self.consent_log.read_text().splitlines(),['silent','interactive','silent'])
        self.assertTrue(preview()['options'][1]['usage_needs_consent'])
        self.assertFalse(self.launches.exists())

    def test_already_authorized_usage_loads_silently(self):
        view=self.consent_fixture(allowed=True)
        self.click(view,26,15)
        self.until(lambda:any('5h 12% / 7d 48%' in row for row in self.usage_rows(view)))
        self.assertNotIn('Track usage',view.poll()['data'])
        self.assertEqual(self.consent_log.read_text().splitlines(),['silent'])

    def test_corgi_setup_changes_inference_provider(self):
        view=Viewer(self,100,30)
        def text():return '\n'.join(smoke.screen_text(view.poll()['data'],100,30))
        view.input('\x02i')
        self.until(lambda:'Corgi setup' in text())
        self.assertIn('Who writes activity summaries',text())
        self.assertIn('● Auto',text())
        self.assertEqual(self.session()['inference']['choice'],'auto')
        view.input('\x1b[B\x1b[B\r')
        self.until(lambda:self.session()['inference']['choice']=='claude')
        self.until(lambda:'Summaries and link names: Claude Code' in text())
        self.assertNotIn('Corgi setup',text())
        view.input('\x02i')
        self.until(lambda:'● Claude' in text())
        self.click(view,5,9) # The Off row.
        self.until(lambda:self.session()['inference']['choice']=='off')
        self.assertIsNone(self.session()['inference']['provider'])
        view.input('\x02i')
        self.until(lambda:'Corgi setup' in text())
        view.input('\x1b')
        self.until(lambda:'Corgi setup' not in text())
        self.assertEqual(self.session()['inference']['choice'],'off')
    def test_preview_project_model(self):
        project=pathlib.Path(self.temp.name)/'project';(project/'.claude').mkdir(parents=True)
        (project/'.claude'/'settings.json').write_text(json.dumps({'model':'haiku'}))
        (project/'.claude'/'settings.local.json').write_text(json.dumps({'model':'sonnet'}))
        def preview():return self.rpc(op='agent.preview',protocol=1,workspace=self.ws,cwd=str(project))['preview']
        self.until(lambda:not preview()['pending'],timeout=12)
        result=preview()['options'][1]
        self.assertEqual(result['model']['bytes'][:result['model']['len']],'sonnet')
        self.assertIn('Local settings',result['source']['bytes'][:result['source']['len']])

if __name__=='__main__':unittest.main()
