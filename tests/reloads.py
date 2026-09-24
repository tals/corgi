#!/usr/bin/env python3
"""Isolated real-process handoff and cold-recovery tests; never use the host runtime."""
import json, os, pathlib, shlex, shutil, signal, socket, subprocess, sys, time, unittest
import smoke
from viewers import Viewer

class Reloads(smoke.Runtime):
    # Inherit fixture helpers, not the unrelated smoke tests below.
    def setUp(self):
        self.viewers=[]
        super().setUp()
    def tearDown(self):
        for viewer in self.viewers: viewer.close()
        super().tearDown()
    def new(self, command='exec /bin/sh', title=''):
        return self.command('pane.create', workspace=self.session()['workspaces'][0]['id'], cwd=self.temp.name, command=command, title=title)['pane']
    def reload(self, exe=smoke.EXE):
        return self.rpc(op='server.reload',protocol=1,executable=exe)
    def test_workspace_automatic_and_custom_names_survive_handoff(self):
        first=self.new()
        folder=pathlib.Path(self.temp.name,'project');folder.mkdir()
        ws=self.session()['workspaces'][0]['id']
        self.reload()
        self.command('pane.input', target=first, data=('cd '+shlex.quote(str(folder))) + '\r')
        self.until(lambda:self.session()['workspaces'][0]['name']=='project')
        self.assertEqual(self.session()['workspaces'][0]['custom_name'],'')
        self.command('workspace.edit', name='Override', target=ws)
        self.reload()
        self.command('pane.input', target=first, data=('cd /') + '\r')
        self.until(lambda:self.session()['panes'][0]['cwd']=='/')
        self.assertEqual(self.session()['workspaces'][0]['name'],'Override')
        self.command('workspace.edit', name='', target=ws)
        self.until(lambda:self.session()['workspaces'][0]['name']=='/')

    def test_handoff_preserves_processes_viewers_and_queued_controls(self):
        first=self.new();second=self.new();a=Viewer(self);b=Viewer(self)
        a.focus(first);b.focus(second);a.input('\x02')
        before=self.session()
        self.rpc(op='action',name='rename',value='After handoff',viewer=self.rpc(op='viewer.list')['viewers'][1]['id'])
        for _ in range(3):
            result=self.reload()
            self.assertNotEqual(result['server_pid'],before['server_pid'])
            after=self.session()
            self.assertEqual([(p['id'],p['pid']) for p in before['panes']],[(p['id'],p['pid']) for p in after['panes']])
            before=after
        self.assertTrue(a.poll()['prefix']);self.assertEqual(a.state['pane'],first)
        self.assertEqual(b.poll()['pane'],second)
        self.assertIn('After handoff',b.state['data'])
        a.input('\x1b');a.input("printf 'AFTER_%s\\n' RELOAD\r")
        self.until(lambda:'AFTER_RELOAD' in self.command('pane.read', target=first, view='screen')['text'])
        self.command('pane.input', target=first, data=('exit') + '\r')
        self.until(lambda:first not in [p['id'] for p in self.session()['panes']])
    def test_failed_candidate_rolls_back_and_can_retry(self):
        first=self.new();a=Viewer(self);before=self.session()
        for executable in ['/does/not/exist','/usr/bin/false']:
            response=self.raw_rpc(op='server.reload',protocol=1,executable=executable)
            self.assertEqual(response['err'],'ReloadCandidateFailed')
            self.assertEqual(before['server_pid'],self.session()['server_pid'])
            self.assertEqual(before['panes'][0]['pid'],self.session()['panes'][0]['pid'])
            self.assertEqual(a.poll()['pane'],first)
        self.reload()
        a.input("printf 'STILL_%s\\n' HERE\r")
        self.until(lambda:'STILL_HERE' in self.command('pane.read', target=first, view='screen')['text'])
    def test_fragmented_rpc_and_paste_survive(self):
        first=self.new();a=Viewer(self);a.input('\x1b[200~printf PASTE_')
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(self.path);client.settimeout(5)
            client.sendall(b'{"op":"session.snap')
            time.sleep(.05)
            self.reload()
            client.sendall(b'shot","protocol":1}\n')
            with client.makefile('rb') as stream:self.assertEqual(json.loads(stream.readline())['type'],'session')
        a.input('SURVIVED\\n\x1b[201~\r')
        self.until(lambda:'PASTE_SURVIVED' in self.command('pane.read', target=first, view='screen')['text'])
    def test_native_session_retains_pid_approvals_and_transport(self):
        session=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['ready'])
        self.rpc(op='native.send',session=session,message={'method':'test/approval'})
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['pending_requests']==1)
        before=self.rpc(op='native.events',session=session)
        pid=self.rpc(op='native.list')['sessions'][0]['pid']
        self.reload()
        self.assertEqual(self.rpc(op='native.events',session=session)['pending_requests'],before['pending_requests'])
        self.assertEqual(self.rpc(op='native.list')['sessions'][0]['pid'],pid)
        self.rpc(op='native.send',session=session,message={'id':900,'result':{}})
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['pending_requests']==0)
        self.rpc(op='native.send',session=session,message={'method':'test/exit'})
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['exited'])
    def test_cold_recovery_preserves_layout_cwd_history_and_resume_hint(self):
        project=pathlib.Path(self.temp.name,'project');project.mkdir();project=project.resolve()
        first=self.new("printf 'BEFORE_%s\\n' CRASH; exec /bin/sh",title='Kept title')
        self.command('pane.input', target=first, data=('cd '+shlex.quote(str(project))) + '\r')
        self.until(lambda:self.session()['panes'][0]['cwd']==str(project))
        self.rpc(op='hook',provider='codex',pane=first,event={'hook_event_name':'SessionStart','session_id':'session-123','cwd':str(project)})
        self.until(lambda:self.session()['panes'][0]['agent']['session']=='session-123')
        before=self.session();saved=self.rpc(op='recovery.save',protocol=1)['path']
        self.assertFalse(saved.startswith('/tmp/'))
        self.assertEqual(pathlib.Path(saved).stat().st_mode & 0o777,0o600)
        os.kill(before['server_pid'],signal.SIGKILL)
        self.until(lambda:subprocess.run([smoke.EXE,'ping'],env=self.env,capture_output=True,timeout=3).returncode!=0)
        self.run_cli('start');after=self.session()
        self.assertEqual([(w['id'],w['model']['tabs']) for w in before['workspaces']],[(w['id'],w['model']['tabs']) for w in after['workspaces']])
        self.assertEqual(after['panes'][0]['id'],first)
        self.assertNotEqual(after['panes'][0]['pid'],before['panes'][0]['pid'])
        self.until(lambda: "codex resume 'session-123'" in self.command('pane.read', target=first, view='screen')['text'])
        text=self.command('pane.read', target=first, view='screen')['text']
        self.assertIn('BEFORE_CRASH',text)
        self.assertIn("codex resume 'session-123'",text)
        self.assertEqual(after['panes'][0]['cwd'],str(project))
        # Cold recovery retains conversation identity without claiming the agent
        # is running in the replacement shell.
        restored=after['panes'][0]['agent']
        self.assertEqual(restored['provider'],'codex')
        self.assertEqual(restored['session'],'session-123')
        self.assertEqual(restored['state'],'unknown')
        self.assertEqual(restored['conversation'],before['panes'][0]['agent']['conversation'])
        actor=next(actor for actor in after['conversations'] if actor['id']==restored['conversation'])
        self.assertEqual(actor['observed_at'],0)
        self.command('pane.input', target=first, data=("\x15printf 'NEW_%s\\n' SHELL") + '\r')
        self.until(lambda:'NEW_SHELL' in self.command('pane.read', target=first, view='screen')['text'])

    def test_recovery_prefills_editable_command_until_enter(self):
        for shell in ['/bin/sh', '/bin/zsh', shutil.which('fish')]:
            if not shell: continue
            with self.subTest(shell=shell):
                self.env['SHELL']=shell
                self.restart_runtime()
                first=self.new()
                marker=pathlib.Path(self.temp.name,'resumed')
                marker.unlink(missing_ok=True)
                # An alias/function verifies that normal interactive shell setup
                # still applies to the prefilled command.
                body="printf '%s' \"$*\" > "+shlex.quote(str(marker))
                if shell.endswith('fish'):
                    config=pathlib.Path(self.temp.name,'.config/fish/config.fish')
                    config.parent.mkdir(parents=True,exist_ok=True)
                    config.write_text("set -g fish_greeting; function fish_prompt; printf '❯ '; end; function codex; printf '%s ' $argv > "+shlex.quote(str(marker))+"; end\n")
                else:
                    config=pathlib.Path(self.temp.name,'.zshrc' if shell.endswith('zsh') else '.profile')
                    config.write_text('codex() { '+body+'; }\n')
                self.rpc(op='hook',provider='codex',pane=first,event={'hook_event_name':'SessionStart','session_id':'session-ready'})
                self.until(lambda: any(p['id']==first and p['agent']['session']=='session-ready' for p in self.session()['panes']))
                self.rpc(op='recovery.save',protocol=1)
                self.restart_runtime()
                self.until(lambda: "codex resume 'session-ready'" in self.command('pane.read', target=first, view='screen')['text'])
                self.assertFalse(marker.exists())
                self.command('pane.input', data='\r', target=first)
                self.until(lambda:marker.exists() and marker.read_text().strip()=='resume session-ready')
                self.assertEqual(marker.read_text().strip(),'resume session-ready')
                self.command('pane.input', target=first, data=('exit') + '\r')
                self.until(lambda: first not in [p['id'] for p in self.session()['panes']])

    def test_candidate_rejects_incompatible_or_partly_restored_state_without_killing_panes(self):
        first=self.new();self.new();before=self.session()
        candidate=pathlib.Path(self.temp.name,'candidate')
        for mutation in ["m['version']=999", "m['runtime']['panes'][1]['screen']['data']='invalid base64!'"]:
            candidate.write_text('#!'+sys.executable+'\nimport json,os,sys\nfd=int(sys.argv[2])\nwith os.fdopen(os.dup(fd)) as f:m=json.load(f)\n'+mutation+"\nos.lseek(fd,0,0);os.ftruncate(fd,0);os.write(fd,json.dumps(m).encode());os.lseek(fd,0,0)\nos.execv("+repr(smoke.EXE)+",["+repr(smoke.EXE)+"]+sys.argv[1:])\n")
            candidate.chmod(0o700)
            response=self.raw_rpc(op='server.reload',protocol=1,executable=str(candidate))
            self.assertEqual(response['err'],'ReloadCandidateFailed')
            self.assertEqual(before['server_pid'],self.session()['server_pid'])
            self.assertEqual([(p['id'],p['pid']) for p in before['panes']],[(p['id'],p['pid']) for p in self.session()['panes']])
        self.command('pane.input', target=first, data=("printf 'ROLLBACK_%s\\n' OK") + '\r')
        self.until(lambda:'ROLLBACK_OK' in self.command('pane.read', target=first, view='screen')['text'])


    def test_backpressure_rejects_reload_without_dropping_accepted_input(self):
        program=pathlib.Path(self.temp.name,'blocked.py');gate=pathlib.Path(self.temp.name,'gate');received=pathlib.Path(self.temp.name,'received')
        program.write_text("import os,tty,time,pathlib,sys\ntty.setraw(0)\nprint('READY',flush=True)\nwhile not pathlib.Path(sys.argv[1]).exists():time.sleep(.01)\nwith open(sys.argv[2],'wb',buffering=0) as f:\n while True:f.write(os.read(0,65536))\n")
        first=self.new(shlex.join([sys.executable,str(program),str(gate),str(received)]))
        self.until(lambda:'READY' in self.command('pane.read', target=first, view='screen')['text'])
        before=self.session()
        for _ in range(8):self.command('pane.input', data='a'*65536, target=first)
        response=self.raw_rpc(op='server.reload',protocol=1,executable=smoke.EXE)
        self.assertEqual(response['err'],'ReloadInputBackpressure')
        self.assertEqual(self.session()['server_pid'],before['server_pid'])
        gate.touch();self.until(lambda:received.exists() and received.stat().st_size==8*65536)
        self.reload();self.command('pane.input', data='END', target=first)
        self.until(lambda:received.read_bytes()==b'a'*(8*65536)+b'END')

    def test_native_cold_recovery_displays_resume_without_starting_agent(self):
        ident=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['ready'])
        self.rpc(op='native.send',session=ident,message={'method':'test/approval'})
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['session_id']=='t')
        self.rpc(op='recovery.save',protocol=1)
        self.restart_runtime()
        sessions=self.rpc(op='native.list')['sessions']
        self.assertTrue(sessions[0]['exited']);self.assertEqual(sessions[0]['pid'],-1)
        self.assertEqual(len(self.session()['panes']),1)
        pane=self.session()['panes'][0]['id']
        self.until(lambda: "codex resume 't'" in self.command('pane.read', target=pane, view='screen')['text'])
        text=self.command('pane.read', target=pane, view='screen')['text']
        self.assertIn("codex resume 't'",text)
        self.assertIn('requestApproval',text)

    def test_missing_directory_and_removed_socket_directory_do_not_lose_recovery(self):
        folder=pathlib.Path(self.temp.name,'gone');folder.mkdir();first=self.new()
        self.command('pane.input', target=first, data=('cd '+shlex.quote(str(folder))) + '\r')
        self.until(lambda:self.session()['panes'][0]['cwd']==str(folder.resolve()))
        self.rpc(op='recovery.save',protocol=1)
        self.run_cli('shutdown');self.until(lambda:not pathlib.Path(self.path).exists())
        folder.rmdir()
        # Recovery lives under HOME, independent of the transient socket files.
        workspace_state=pathlib.Path(self.path+'.workspaces.json')
        if workspace_state.exists():workspace_state.unlink()
        self.run_cli('start')
        self.assertEqual(self.session()['panes'][0]['id'],first)
        text=self.command('pane.read', target=first, view='screen')['text']
        self.assertIn('# Recovered saved output; new shell.',text)
        self.assertEqual(self.session()['panes'][0]['cwd'],str(pathlib.Path(self.temp.name).resolve()))

    def test_pipelined_requests_remain_ordered_across_handoff(self):
        self.new()
        before=self.session()['server_pid']
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(self.path);client.settimeout(5)
            client.sendall((json.dumps(dict(op='server.reload',protocol=1,executable=smoke.EXE))+'\n'+json.dumps(dict(op='session.snapshot',protocol=1))+'\n').encode())
            with client.makefile('rb') as stream:
                first=json.loads(stream.readline());second=json.loads(stream.readline())
                self.assertTrue(first['ok']);self.assertNotEqual(first['server_pid'],before)
                self.assertEqual(second['type'],'session');self.assertEqual(first['server_pid'],second['server_pid'])

    def test_native_partial_initialization_and_deferred_request_survive(self):
        gate=pathlib.Path(self.temp.name,'native-gate');provider=pathlib.Path(self.temp.name,'provider')
        provider.write_text('#!'+sys.executable+'\n'+"""
import os,sys,json,pathlib,time
if '--version' in sys.argv:print('codex-fixture');sys.exit()
for line in sys.stdin:
 v=json.loads(line)
 if v.get('method')=='initialize':
  print(json.dumps({'id':'__corgi_init','result':{}})[:-3],end='',flush=True)
  while not pathlib.Path(GATE).exists():time.sleep(.01)
  print('{}}',flush=True)
 elif 'id' in v:print(json.dumps({'id':v['id'],'result':'deferred-survived'}),flush=True)
""".replace('GATE',repr(str(gate))))
        ident=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        self.rpc(op='native.send',session=ident,message={'id':42,'method':'ping'})
        time.sleep(.1);pid=self.rpc(op='native.list')['sessions'][0]['pid']
        self.reload();gate.touch()
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['ready'])
        self.assertEqual(pid,self.rpc(op='native.list')['sessions'][0]['pid'])
        self.until(lambda:any(json.loads(e['line']).get('id')==42 for e in self.rpc(op='native.events',session=ident)['events']))

    def test_removed_attachment_cannot_create_a_shell_or_block_reload(self):
        before=self.session()
        for op in ('attach','input','size'):
            reply=self.raw_rpc(op=op,cols=80,rows=24,data='echo unsafe\r')
            self.assertEqual(reply['err'],'UnknownOperation')
        self.assertEqual(self.session()['panes'],before['panes'])
        pane=self.new();a=Viewer(self)
        self.reload()
        self.assertEqual(a.poll()['pane'],pane)
        self.assertNotEqual(before['server_pid'],self.session()['server_pid'])

# Exclude inherited smoke cases while reusing its fixture and assertions.
for name in dir(smoke.Runtime):
    if name.startswith('test_') and name not in Reloads.__dict__:setattr(Reloads,name,None)
if __name__=='__main__':unittest.main(verbosity=2)
