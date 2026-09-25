#!/usr/bin/env python3
"""Real viewer launch controls and read-only model previews."""
import json, pathlib, unittest, time, shlex, sys
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
        self.click(view,22,19)
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
        x=rows[y].index('[ ]')
        self.click(view,x+2,y+1)
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
            self.assertTrue(any(('› '+provider) in row for row in rows), '\n'.join(rows))
        view.input('\x1b[B');selected('Claude Code')
        view.input('\x1b[B');selected('Claude Code')
        view.input('\x1b[A');selected('Codex')
        view.input('\x1b[A');selected('Codex')
        view.input('\x1b[Z');selected('Claude Code')
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
            view.input('\x1b[B')
            self.assertIn('a: launch  y: YOLO', view.poll()['data'])
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
