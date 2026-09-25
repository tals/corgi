#!/usr/bin/env python3
"""Real PTY/socket regressions. Provider doubles never make inference requests."""
from viewer_client import Viewer, pump
import fcntl
import datetime
import hashlib
import base64
import json
import os
import pathlib
import re
import select
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXE = str(ROOT / 'zig-out/bin/corgi')

from provider_sim import NATIVE_PROVIDER as FAKE, write_ordinary_agent

def screen_text(data, cols=80, rows=24):
    """Decode frame cursor moves so tests click what the user actually sees."""
    grid=[[' ']*cols for _ in range(rows)]
    x=y=0;i=0;saved=(0,0)
    while i<len(data):
        if data.startswith('\x1b7',i):saved=(x,y);i+=2;continue
        if data.startswith('\x1b8',i):x,y=saved;i+=2;continue
        if data.startswith('\x1b]',i):
            match=re.match(r'\x1b\].*?(?:\x07|\x1b\\)',data[i:],re.S)
            if not match:raise AssertionError('unterminated OSC')
            i+=len(match.group());continue
        if data[i]=='\x1b':
            match=re.match(r'\x1b\[([0-9;:?]*)([@-~])',data[i:])
            if not match:raise AssertionError('unexpected frame escape '+repr(data[i:i+50]))
            args,kind=match.groups()
            if kind in ('H','f'):
                values=[int(v or 1) for v in args.split(';')]
                y=values[0]-1;x=(values[1] if len(values)>1 else 1)-1
            elif kind=='J' and args=='2':grid=[[' ']*cols for _ in range(rows)]
            i+=len(match.group());continue
        if data[i]=='\r':x=0
        elif data[i]=='\n':y+=1
        elif data[i]>=' ':
            if 0<=x<cols and 0<=y<rows:grid[y][x]=data[i]
            x+=0 if unicodedata.combining(data[i]) else 2 if unicodedata.east_asian_width(data[i]) in ('W','F') else 1
        i+=1
    return [''.join(row) for row in grid]

def layout_tree(workspace, tab=0):
    model = workspace['model']
    def tree(index):
        node = model['nodes'][index]
        if 'pane' in node:
            return node
        branch = node['split']
        return {'split': {**branch, 'first': tree(branch['first']), 'second': tree(branch['second'])}}
    return tree(model['tabs'][tab]['root'])

class Runtime(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='corgi-test-')
        self.path = self.temp.name + '/control.sock'
        fake = pathlib.Path(self.temp.name, 'provider'); fake.write_text(FAKE); fake.chmod(0o700)
        # Provider settings must be isolated: startup now installs ordinary-CLI hooks.
        self.env = {**os.environ, 'HOME':self.temp.name, 'XDG_STATE_HOME':self.temp.name+'/.local/state', 'CODEX_HOME':self.temp.name+'/.codex', 'CLAUDE_CONFIG_DIR':self.temp.name+'/.claude', 'CORGI_SOCKET':self.path, 'CORGI_BELL':'off', 'CORGI_CODEX_BIN':str(fake), 'CORGI_CLAUDE_BIN':str(fake), 'SHELL':'/bin/sh'}
        self.env.pop('CODEX_THREAD_ID',None)
        self.client = None
        self.viewers = []
        self.proc = None
        self.run_cli('start')
    def tearDown(self):
        for viewer in self.viewers:viewer.close()
        if self.proc:
            self.proc.terminate()
            try: self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait()
            os.close(self.master)
        try: self.run_cli('shutdown')
        finally:
            time.sleep(.1)
            log=pathlib.Path(self.temp.name,'server.log').read_text()
            self.assertNotIn('panic:',log)
            self.temp.cleanup()
    def run_cli(self,*args):
        p=subprocess.run([EXE,*args],env=self.env,capture_output=True,text=True,timeout=8)
        self.assertEqual(p.returncode,0,(args,p.stderr,p.stdout))
        return p.stdout
    def rpc(self,**v):
        pump(self)
        result=json.loads(self.run_cli('rpc',json.dumps(v)))
        pump(self)
        return result
    def command(self, operation, **payload):
        return self.rpc(op='session.command', protocol=1, command={operation:payload})['result']
    def open_pane(self, **options):
        views=self.rpc(op='viewer.list')['viewers']
        workspace=views[0]['workspace'] if views else self.session()['workspaces'][0]['id']
        if views and views[0]['pane']:options.setdefault('from',views[0]['pane'])
        result=self.command('pane.create',workspace=workspace,**options)
        if not views:self.client=Viewer(self,80,24)
        if any(p['id']==result['pane'] for p in self.session()['panes']):
            self.rpc(op='focus',pane=result['pane'])
        return result
    def split_pane(self, direction='right', **options):
        view=self.rpc(op='viewer.list')['viewers'][0]
        result=self.command('pane.split',target=view['pane'],direction=direction,**options)
        self.rpc(op='focus',pane=result['pane'],viewer=view['id'])
        return result
    def raw_rpc(self,**v):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3);client.connect(self.path)
            client.sendall(json.dumps(v).encode()+b'\n')
            with client.makefile('rb') as stream:return json.loads(stream.readline())
    def session(self): return self.rpc(op='session.snapshot',protocol=1)
    def test_runtime_protocol_negotiates_and_rejects_before_mutating(self):
        hello=self.raw_rpc(op='hello',protocol=1)
        self.assertEqual(hello['type'],'hello')
        self.assertIn('pane.surface',hello['capabilities'])
        self.assertNotIn('handoff',hello['capabilities'])
        ws=self.workspaces()[0]['id']
        for protocol in (0,2,-1,'1'):
            result=self.raw_rpc(op='session.command', command={'pane.create':dict(workspace=ws)}, protocol=protocol)
            self.assertEqual(result['err'],'UnsupportedProtocol')
        self.assertEqual(self.raw_rpc(op='session.snapshot')['err'],'ProtocolRequired')
        self.assertEqual(self.session()['panes'],[])
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3);client.connect(self.path)
            with client.makefile('rb') as stream:
                client.sendall(b'{"op":"hello","protocol":1}\n')
                self.assertEqual(json.loads(stream.readline())['protocol'],1)
                client.sendall(b'{"op":"session.snapshot"}\n')
                self.assertEqual(json.loads(stream.readline())['type'],'session')
    def test_runtime_operations_target_ids_without_changing_selection(self):
        first=self.open_pane(command='sleep 30')['pane']
        second=self.open_pane(command='sleep 30')['pane']
        original=self.session()
        ws=original['workspaces'][0]['id']
        before=next(p for p in original['panes'] if p['id']==first)
        third=self.command('pane.create', workspace=ws, title='third', command='sleep 30')['pane']
        split=self.command('pane.split', command='sleep 30', target=first, direction='right')['pane']
        self.command('tab.rename', target=before['tab'], name='background')
        self.command('split.resize', direction='right', target=first)
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),second)
        snap=self.session()
        self.assertEqual({p['id'] for p in snap['panes']},{first,second,third,split})
        self.assertEqual(next(p['pid'] for p in snap['panes'] if p['id']==first),before['pid'])
        split_panes=[p for p in snap['panes'] if p['id'] in (first,split)]
        # Hidden panes keep their sizes until a real viewer displays the split.
        self.assertEqual(next(p['cols'] for p in split_panes if p['id']==first),before['cols'])
        self.client.focus(first)
        self.client.poll()
        visible=[p for p in self.session()['panes'] if p['id'] in (first,split)]
        self.assertEqual(sum(p['cols'] for p in visible)+3,before['cols'])
        self.client.focus(second)
        tab=next(t for t in snap['workspaces'][0]['model']['tabs'] if t['id']==before['tab'])
        self.assertEqual(tab['title'],'background')
        self.assertEqual(layout_tree(snap['workspaces'][0])['split'],{'axis':'horizontal','ratio':540,'first':{'pane':first},'second':{'pane':split}})
        # Versioned data describes shared organization, never a viewer's focus.
        self.assertNotIn('active',snap['workspaces'][0])
        self.assertNotIn('focus',tab)
        self.assertNotIn('focused',snap['panes'][0])
        self.command('pane.close', target=split)
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),second)
        survivor=next(p for p in self.session()['panes'] if p['id']==first)
        last=next(p for p in visible if p['id']==first)
        self.assertEqual((survivor['cols'],survivor['rows']),(last['cols'],last['rows']))
        self.client.focus(first);self.client.poll()
        survivor=next(p for p in self.session()['panes'] if p['id']==first)
        self.assertEqual((survivor['cols'],survivor['rows']),(before['cols'],before['rows']))
    def test_runtime_target_failure_does_not_change_layout_or_focus(self):
        pane=self.open_pane(command='sleep 30')['pane']
        before=self.session()
        ws=before['workspaces'][0]['id']
        invalid=[
            dict(op='session.command', command={'pane.split':dict(target=pane, direction='bad')}),
            dict(op='session.command', command={'pane.split':dict(target=999, direction='right')}),
            dict(op='session.command', command={'pane.create':dict(workspace=ws, cwd=self.temp.name+'/missing')}),
            dict(op='session.command', command={'pane.create':dict(workspace=999)}),
            dict(op='session.command', command={'pane.close':dict(target=-1)}),
            dict(op='session.command', command={'pane.input':dict(data=42, target=pane)}),
            dict(op='session.command', command={'tab.rename':dict(name='missing target')}),
        ]
        for request in invalid:
            self.assertIn('err',self.raw_rpc(protocol=1,**request))
        after=self.session()
        self.assertEqual(after['workspaces'],before['workspaces'])
        self.assertEqual([p['id'] for p in after['panes']],[pane])
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),pane)
    def test_runtime_surface_and_input_do_not_switch_to_the_target(self):
        first=self.open_pane(command="printf '\\033[31m界é\\033[0m\\n'; exec /bin/sh")['pane']
        second=self.open_pane(command='sleep 30')['pane']
        self.until(lambda:'界é' in self.command('pane.read', target=first, view='screen')['text'])
        self.command('pane.input', data="printf 'DIRECT_INPUT_OK\\n'\r", target=first)
        self.until(lambda:'DIRECT_INPUT_OK' in self.command('pane.read', target=first, view='screen')['text'])
        response=self.rpc(op='pane.surface',protocol=1,pane=first)
        surface=response['surface']
        self.assertEqual(response['type'],'surface')
        self.assertEqual(surface['pane'],first)
        self.assertEqual(len(surface['lines']),surface['rows'])
        self.assertIn('界é',''.join(surface['lines']))
        self.assertIn('DIRECT_INPUT_OK',''.join(surface['lines']))
        self.assertTrue(all(line.endswith('\x1b[0m') for line in surface['lines']))
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),second)
    def test_runtime_subscription_survives_idle_and_receives_changes(self):
        self.open_pane(command='sleep 30')
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3);client.connect(self.path)
            with client.makefile('rb') as stream:
                client.sendall(b'{"op":"session.subscribe","protocol":1}\n')
                initial=json.loads(stream.readline())
                self.assertEqual(initial['type'],'session')
                time.sleep(5.2) # Ordinary one-shot RPC connections expire after 5s.
                new=self.open_pane(command='sleep 30')['pane']
                for _ in range(20):
                    update=json.loads(stream.readline())
                    if any(p['id']==new for p in update['panes']):break
                else:self.fail('subscription did not receive created pane')
                self.assertGreater(update['revision'],initial['revision'])
                self.assertEqual(update['server_pid'],initial['server_pid'])
    def until(self,predicate,timeout=4):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            pump(self)
            value=predicate()
            if value: return value
            time.sleep(.03)
        self.fail('condition timed out')
    def panes(self):
        snapshot=self.session()
        view=self.client
        return [{**p['agent'], **p,
                 'unread':p['agent']['observation']['completed']>p['agent']['observation']['read'],
                 'completed':p['agent']['observation']['completed'], 'read':p['agent']['observation']['read'],
                 'pending_stop':p['agent']['observation']['pending_stop'], 'source':p['agent']['observation']['source'],
                 'focused':view is not None and p['id']==view.state['pane']} for p in snapshot['panes']]
    def tab_count(self):
        snapshot=self.session()
        if not self.client:return sum(len(ws['model']['tabs']) for ws in snapshot['workspaces'])
        return len(next(ws['model']['tabs'] for ws in snapshot['workspaces'] if ws['id']==self.client.state['workspace']))
    def attach(self):
        if self.client is None or self.client.closed or self.client.state['detached']:
            if self.client:self.client.close()
            self.client=Viewer(self,80,24)
        else:self.client.request(op='size',cols=80,rows=24)
    def reconnect(self):
        self.client.close();self.client=None
        self.attach();self.get_type('frame')
    def write(self,**v): self.client.request(**v)
    def message(self):
        if not self.client.events:
            time.sleep(.03)
            self.client.poll()
        return self.client.events.pop(0)
    def get_type(self,kind):
        for _ in range(300):
            m=self.message()
            if m.get('type')==kind:return m
        self.fail('missing message '+kind)
    def input(self,text): self.write(op='input',data=text)
    def workspaces(self):
        workspaces=self.session()['workspaces']
        for ws in workspaces:ws['active']=self.client is not None and ws['id']==self.client.state['workspace']
        return workspaces
    def new_workspace(self,**args):
        args.setdefault('cwd',self.temp.name)
        result=self.command('workspace.create', **args)
        if self.client:self.client.request(op='workspace',workspace=result['workspace'])
        return result
    def test_workspaces_isolate_tabs_preserve_focus_and_default_folders(self):
        one=pathlib.Path(self.temp.name,'one');one.mkdir()
        two=pathlib.Path(self.temp.name,'two');two.mkdir()
        first=self.open_pane(cwd=str(one), command='sleep 30')['pane']
        default=self.workspaces()[0]['id']
        self.attach();self.frame_with('workspaces')
        second_ws=self.new_workspace(name='Second',cwd=str(two))['workspace']
        second=next(p['id'] for p in self.panes() if p['focused'])
        self.assertNotEqual(first,second)
        self.assertEqual({p['workspace'] for p in self.panes()},{default,second_ws})
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['id']==second),str(two.resolve()))
        self.rpc(op='action',name='new')
        third=next(p['id'] for p in self.panes() if p['focused'])
        self.rpc(op='action',name='split',value='right')
        fourth=next(p['id'] for p in self.panes() if p['focused'])
        self.assertEqual(len({first,second,third,fourth}),4)
        self.assertEqual(self.tab_count(),2)
        self.rpc(op='workspace.switch',workspace=default)
        self.assertEqual(self.tab_count(),1)
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),first)
        self.rpc(op='workspace.switch',workspace=second_ws)
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),fourth)
        self.command('workspace.edit', name='Renamed', target=second_ws)
        self.open_pane(command='sleep 30')
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['focused']),str(two.resolve()))
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['id']==second),str(two.resolve()))
        self.rpc(op='focus',pane=first)
        self.assertEqual(next(w['id'] for w in self.workspaces() if w['active']),default)
    def test_new_tabs_and_splits_inherit_current_pane_directory(self):
        one=pathlib.Path(self.temp.name,'one');one.mkdir()
        two=pathlib.Path(self.temp.name,'two');two.mkdir()
        three=pathlib.Path(self.temp.name,'three');three.mkdir()
        first=self.open_pane(cwd=str(one), command='exec /bin/sh')['pane']
        second=self.open_pane(cwd=str(two), command='exec /bin/sh')['pane']
        self.command('pane.input', target=second, data=('cd '+shlex.quote(str(three))) + '\r')
        self.until(lambda:next(p['cwd'] for p in self.panes() if p['id']==second)==str(three.resolve()))
        self.rpc(op='action',name='new')
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['focused']),str(three.resolve()))
        self.rpc(op='action',name='split',value='right')
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['focused']),str(three.resolve()))
        targeted=self.command('pane.split', target=first, direction='right')['pane']
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['id']==targeted),str(one.resolve()))
        inherited=self.open_pane()['pane']
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['id']==inherited),str(three.resolve()))
        explicit=self.split_pane(cwd=str(two))['pane']
        self.assertEqual(next(p['cwd'] for p in self.panes() if p['id']==explicit),str(two.resolve()))
    def test_workspace_name_follows_first_tab_and_custom_name_can_be_cleared(self):
        one=pathlib.Path(self.temp.name,'one');one.mkdir()
        two=pathlib.Path(self.temp.name,'two');two.mkdir()
        three=pathlib.Path(self.temp.name,'three');three.mkdir()
        first=self.open_pane(cwd=str(one), command='exec /bin/sh')['pane']
        self.until(lambda:self.workspaces()[0]['name']=='one')
        second=self.open_pane(cwd=str(two), command='exec /bin/sh')['pane']
        self.assertEqual(self.workspaces()[0]['name'],'one')
        self.command('pane.input', target=first, data=('cd '+shlex.quote(str(three))) + '\r')
        self.until(lambda:self.workspaces()[0]['name']=='three')
        self.assertEqual(self.workspaces()[0]['cwd'],str(three.resolve()))
        self.rpc(op='action',name='move-tab',value='left')
        self.until(lambda:self.workspaces()[0]['name']=='two')
        ws=self.workspaces()[0]['id']
        self.command('workspace.edit', name='Custom', target=ws)
        self.command('pane.input', target=second, data=('cd '+shlex.quote(str(one))) + '\r')
        self.until(lambda:self.workspaces()[0]['cwd']==str(one.resolve()))
        self.assertEqual(self.workspaces()[0]['name'],'Custom')
        self.attach();screen=self.frame_with('Custom')
        self.assertNotIn('📌','\n'.join(screen))
        self.input('\x02W');self.frame_with('edit workspace: name')
        self.input('\x03\r');self.frame_with('one')
        self.until(lambda:self.workspaces()[0]['name']=='one')
        self.command('pane.close', target=second)
        self.until(lambda:self.workspaces()[0]['name']=='three')
        self.restart_runtime()
        self.assertEqual(self.workspaces()[0]['name'],'three')
        self.assertNotIn('pinned',self.workspaces()[0])
        self.assertEqual(json.loads(pathlib.Path(self.path+'.workspaces.json').read_text())['workspaces'][0]['name'],'')

    def test_workspace_metadata_survives_restart(self):
        folder=pathlib.Path(self.temp.name,'项目 café');folder.mkdir()
        default=self.workspaces()[0]['id']
        ws=self.new_workspace(name='Project',cwd=str(folder))['workspace']
        self.attach()
        self.command('workspace.edit', name='Renamed', target=ws)
        self.rpc(op='workspace.switch',workspace=default)
        before=self.workspaces()
        self.restart_runtime()
        self.attach()
        self.assertEqual(self.workspaces(),before)
        self.rpc(op='workspace.switch',workspace=ws)
        self.attach();self.frame_with('Renamed')
        self.assertEqual(self.panes()[0]['cwd'],str(folder.resolve()))
        self.command('workspace.close', target=default)
        self.restart_runtime()
        self.attach()
        self.assertEqual([w['id'] for w in self.workspaces()],[ws])
        self.assertTrue(self.workspaces()[0]['active'])
        newer=self.new_workspace(name='New')['workspace']
        self.assertGreater(newer,ws)

    def test_hidden_workspace_exit_and_undo_do_not_disturb_active_pane(self):
        pane=self.open_pane(cwd=self.temp.name, command='exec /bin/sh')['pane']
        default=self.workspaces()[0]['id']
        ws=self.new_workspace(name='Other',cwd=self.temp.name)['workspace']
        active=next(p['id'] for p in self.panes() if p['focused'])
        self.attach();self.frame_with('Other')
        self.command('pane.input', target=pane, data=('exit') + '\r')
        self.until(lambda:all(p['id']!=pane for p in self.panes()))
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),active)
        self.assertEqual(next(w['id'] for w in self.workspaces() if w['active']),ws)
        self.rpc(op='action',name='undo-close')
        self.assertEqual(next(w['id'] for w in self.workspaces() if w['active']),default)
        self.frame_with('restored output')
    def test_workspace_sidebar_create_edit_switch_and_agents(self):
        folder=pathlib.Path(self.temp.name,'项目 café');folder.mkdir()
        first=self.open_pane(cwd=self.temp.name, command='sleep 30')['pane']
        self.rpc(op='hook',pane=first,provider='claude',seq=1,event={'hook_event_name':'SessionStart','session_id':'first'})
        self.attach();screen=self.agent_frame('claude','○')
        self.assertTrue(screen[0].startswith(' workspaces'))
        self.assertTrue(screen[11].startswith(' agents'))
        self.click(21,1);self.frame_with('new workspace: name')
        self.input('Project\r');screen=self.frame_with('No agents yet')
        ws=next(w for w in self.workspaces() if w['active'])
        self.assertEqual((ws['name'],ws['cwd']),('Project',str(pathlib.Path(self.temp.name).resolve())))
        self.click(4,3);self.agent_frame('claude','○')
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),first)
        self.input('\x1b[<2;4;6M\x1b[<2;4;6m')
        self.click_text(self.frame_with('|Rename'),'Rename');self.frame_with('edit workspace: name')
        self.input('Edited\r');screen=self.frame_with('Edited')
        self.assertNotIn('workspace: default folder', '\n'.join(screen))
        self.assertNotIn('edit workspace: name', '\n'.join(screen))
        edited=next(w for w in self.workspaces() if w['id']==ws['id'])
        self.assertEqual((edited['name'],edited['cwd']),('Edited',str(pathlib.Path(self.temp.name).resolve())))
        self.input('\x02}');self.frame_with('No agents yet')
        self.assertEqual(next(w['id'] for w in self.workspaces() if w['active']),ws['id'])
    def test_workspace_and_agent_lists_scroll_independently(self):
        self.open_pane(cwd=self.temp.name, command='sleep 30')
        for i in range(6): self.new_workspace(name=f'Group-{i}',cwd=self.temp.name)
        for i in range(6):
            pane=self.open_pane(cwd=self.temp.name, command='sleep 30')['pane']
            self.rpc(op='hook',pane=pane,provider='claude',seq=1,event={'hook_event_name':'SessionStart','session_id':str(i)})
        self.attach();screen=self.frame_with('Group-4')
        self.assertIn('Group-5',screen[5])
        self.assertIn('<  >',screen[9])
        self.assertIn('< 1-4/6 >',screen[22])
        self.input('\x1b[<65;5;15M');screen=self.frame_with('< 2-5/6 >')
        self.assertIn('Group-4',screen[2])
        self.assertIn('Group-5',screen[5])
        self.input('\x1b[<64;5;5M');screen=self.frame_with('Group-3')
        self.assertIn('Group-4',screen[5])
        self.input('\x1b[<64;5;5M' * 2);screen=self.frame_with('Group-1')
        self.assertIn('< 2-5/6 >',screen[22])
        self.click_text([r[:27] for r in screen],'Group-1')
        self.assertEqual(next(w['name'] for w in self.workspaces() if w['active']),'Group-1')
        self.frame_with('No agents yet')
    def test_native_sessions_belong_to_their_workspace(self):
        self.open_pane(cwd=self.temp.name, command='sleep 30')
        original=self.workspaces()[0]['id']
        self.rpc(op='native.start',provider='codex',cwd=self.temp.name)
        self.attach();self.agent_frame('codex','○')
        self.new_workspace(name='Other',cwd=self.temp.name)
        self.frame_with('No agents yet')
        self.rpc(op='workspace.switch',workspace=original)
        self.agent_frame('codex','○')
    def test_workspace_invalid_folder_and_empty_close(self):
        first=self.open_pane(cwd=self.temp.name, command='sleep 30')['pane']
        before=self.workspaces()
        result=subprocess.run([EXE,'workspace','new','Bad','--cwd',self.temp.name+'/missing'],env=self.env,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.workspaces(),before)
        ws=self.new_workspace(name='Empty',cwd=self.temp.name)['workspace']
        pane=next(p['id'] for p in self.panes() if p['focused'])
        self.command('pane.close', target=pane)
        self.command('workspace.close', target=ws)
        self.assertEqual(len(self.workspaces()),1)
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),first)
    def test_synchronized_redraw_keeps_completed_frame_and_cursor(self):
        fixture=pathlib.Path(self.temp.name,'sync.py')
        begin=pathlib.Path(self.temp.name,'begin')
        middle=pathlib.Path(self.temp.name,'middle')
        finish=pathlib.Path(self.temp.name,'finish')
        fixture.write_text('''import os, pathlib, time
def emit(s): os.write(1,s.encode())
def wait(name):
    while not pathlib.Path(name).exists(): time.sleep(.005)
emit("\\x1b[2J\\x1b[5;5HREADY\\x1b[5;5H\\x1b[?25h")
wait('begin')
emit("\\x1b[?2026h\\x1b[2;20HMID_SYNC\\x1b[2;20H")
pathlib.Path('middle').touch()
wait('finish')
emit("\\x1b[2;20H        \\x1b[5;5HDONE_SYNC\\x1b[5;5H\\x1b[?2026l")
time.sleep(30)
''')
        pane=self.open_pane(cwd=self.temp.name, command=shlex.join([sys.executable,str(fixture)]))['pane']
        self.attach()
        while True:
            frame=self.get_type('frame')['data']
            if 'READY' in frame:break
        cursor=re.findall(r'\x1b\[(\d+);(\d+)H\x1b\[\?25h',frame)
        self.assertTrue(cursor)
        begin.touch();self.until(middle.exists)
        # Force unrelated frames and text captures while the child is mid-batch.
        for _ in range(3):
            self.assertNotIn('MID_SYNC',self.command('pane.read', target=pane, view='screen')['text'])
            self.write(op='size',cols=80,rows=24)
            frame=self.get_type('frame')['data']
            self.assertIn('READY',frame)
            self.assertNotIn('MID_SYNC',frame)
            self.assertEqual(cursor,re.findall(r'\x1b\[(\d+);(\d+)H\x1b\[\?25h',frame))
        finish.touch()
        while True:
            frame=self.get_type('frame')['data']
            self.assertNotIn('MID_SYNC',frame)
            if 'DONE_SYNC' in frame:break
        self.assertEqual(cursor,re.findall(r'\x1b\[(\d+);(\d+)H\x1b\[\?25h',frame))
    def click(self,x,y):self.input(f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m')
    def frame_with(self,text,cols=80,rows=24,row=None):
        for _ in range(100):
            screen=screen_text(self.get_type('frame')['data'],cols,rows)
            if any(text in line for line in (screen if row is None else screen[row:row+1])):return screen
        self.fail('missing visible text '+text)
    def tab_frame(self,text,cols=80,rows=24):
        return self.frame_with(text,cols,rows,row=0)
    def agent_frame(self,provider,icon,activity='',color=None):
        for _ in range(100):
            data=self.get_type('frame')['data'];screen=screen_text(data)
            if color and f'\x1b[38;2;{color}m{icon}' not in data:continue
            for y in range(13,21,2):
                if not screen[y][:27].startswith(' '+icon+' '):continue
                actual=screen[y+1][1:4].strip()
                if activity=='thinking':
                    if actual not in '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏':continue
                elif actual!=activity:continue
                if screen[y][4:27].strip()==provider:return screen
        self.fail('missing two-line agent entry '+provider)
    def tabs_are(self,labels):
        for _ in range(100):
            screen=screen_text(self.get_type('frame')['data'])
            if ' '.join(screen[0][28:].split())==labels+' +':return screen
        self.fail('missing tab labels '+labels)
    def click_text(self,screen,text):
        for y,row in enumerate(screen):
            if text in row:
                self.click((row.rindex(text) if text==' + ' else row.index(text))+1,y+1);return
        self.fail('missing mouse target '+text)
    def right_click_tab(self,screen,title):
        x=screen[0].index(title)+1
        self.input(f'\x1b[<2;{x};1M\x1b[<2;{x};1m')
    def test_mouse_tab_reorder_indicator_and_cancellation(self):
        first=self.open_pane(cwd=self.temp.name, title='First')['pane']
        self.open_pane(cwd=self.temp.name, title='Second')
        self.open_pane(cwd=self.temp.name, title='Third')
        self.attach();screen=self.tabs_are('First Second Third')
        def drag_frame():
            for _ in range(100):
                frame=screen_text(self.get_type('frame')['data'])
                if '│' in frame[0][28:]:return frame
            self.fail('missing tab drop indicator')
        x=screen[0].index('First')+1
        end=screen[0].rindex(' + ')+1
        self.input(f'\x1b[<0;{x};1M\x1b[<32;{end};1M')
        screen=drag_frame()
        self.assertEqual(screen[0][end-2],'│')
        self.input(f'\x1b[<0;{end};1m')
        screen=self.tabs_are('Second Third First')
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),first)
        # Dropping away from the bar cancels and clears the indicator.
        x=screen[0].index('First')+1
        left=29
        self.input(f'\x1b[<0;{x};1M\x1b[<32;{left};1M')
        drag_frame()
        self.input(f'\x1b[<32;{left};3M\x1b[<0;{left};3m')
        screen=self.tabs_are('Second Third First')
        # A release from a second viewer cannot complete this viewer's drag.
        other,reader=self.viewer();self.viewer_frame(reader,'First')
        self.input(f'\x1b[<0;{x};1M\x1b[<32;{left};1M')
        drag_frame()
        other.request(op='input',data=f'\x1b[<0;{left};1m')
        self.input(f'\x1b[<0;{left};1m')
        screen=self.tabs_are('First Second Third')
        # A click without movement only focuses, and Escape cancels a drag.
        self.click(screen[0].index('Third')+1,1)
        screen=self.tabs_are('First Second Third')
        self.input(f'\x1b[<0;{left};1M\x1b[<32;{end};1M')
        drag_frame();self.input('\x1b')
        self.tabs_are('First Second Third')
        self.input(f'\x1b[<0;{end};1m')
        self.tabs_are('First Second Third')
    def viewer(self,cols=80,rows=24):
        viewer=Viewer(self,cols,rows)
        return viewer,viewer
    def viewer_frame(self,viewer,text,cols=80,rows=24):
        for _ in range(100):
            screen=screen_text(viewer.poll()['data'],cols,rows)
            if any(text in row for row in screen):return screen
            time.sleep(.03)
        self.fail('missing viewer frame '+text)
    def test_multiple_viewers_share_input_resize_and_detach_independently(self):
        self.attach();self.get_type('frame')
        self.rpc(op='action',name='sidebar')
        pane=self.panes()[0]['id']
        checks=[]
        def check_size(cols,rows):
            result=pathlib.Path(self.temp.name,f'size-check-{len(checks)}')
            checks.append(result)
            self.command('pane.input', target=pane, data=(f'stty size > {shlex.quote(str(result))}') + '\r')
            self.until(lambda:result.exists() and result.read_text().strip()==f'{rows} {cols}')
        check_size(80,22)
        other,reader=self.viewer(60,18)
        self.viewer_frame(reader,'^B commands',60,18)
        check_size(60,16)
        self.input("printf 'FIRST_VIEWER\\n'\r")
        self.viewer_frame(reader,'FIRST_VIEWER',60,18)
        other.request(op='input',data="printf 'SECOND_VIEWER\\n'\r")
        self.frame_with('SECOND_VIEWER')
        self.write(op='size',cols=100,rows=30)
        check_size(60,16)
        other.request(op='input',data='\x02q')
        self.assertTrue(other.state['detached'])
        other.close()
        check_size(100,28)
        self.input("printf 'STILL_CONNECTED\\n'\r")
        self.frame_with('STILL_CONNECTED',100,30)
        third,third_reader=self.viewer(50,12)
        self.viewer_frame(third_reader,'^B commands',50,12)
        check_size(50,10)
        third_reader.close();third.close()
        check_size(100,28)
    def test_new_viewer_has_independent_dialog_and_paste(self):
        self.attach();self.get_type('frame')
        self.input('\x02T');self.frame_with('rename tab')
        other,_=self.viewer()
        self.assertFalse(other.state['dialog'])
        self.input('\x1b[200~Private title')
        other.input('\r')
        self.assertTrue(self.client.poll()['dialog'])
        self.input('\x1b[201~\r')
        self.tab_frame('Private title')
        self.viewer_frame(other,'Private title')
    def test_enhanced_keys_follow_pane_mode_and_preserve_corgi_controls(self):
        fixture=pathlib.Path(self.temp.name,'keys.py')
        fixture.write_text("""import os,sys,tty
from pathlib import Path
tty.setraw(0)
log=Path(sys.argv[1]);log.write_bytes(b'')
os.write(1,(sys.argv[2]+'\\x1b[?2004hKEYS_READY').encode())
while True:
    with log.open('ab') as output:output.write(os.read(0,1024))
""")
        logs=[pathlib.Path(self.temp.name,name) for name in ('legacy-keys','kitty-keys')]
        panes=[self.open_pane(cwd=self.temp.name, command=shlex.join([sys.executable,str(fixture),str(log),mode]))['pane']
               for log,mode in zip(logs,('', '\x1b[>1u'))]
        for pane in panes:self.until(lambda:'KEYS_READY' in self.command('pane.read', target=int(str(pane)), view='screen')['text'])
        self.attach();self.get_type('frame')
        # Fragment the modified Return across messages, below the escape timeout.
        self.input('\x1b[13;');self.input('9u\x1b[13;2u\x1b[106;5u')
        expected=b'\x1b[13;9u\x1b[13;2u\x1b[106;5u'
        self.until(lambda:logs[1].read_bytes()==expected)
        # Encoded Ctrl-B must still open Corgi's menu, and ESC must close it.
        self.input('\x1b[98;5u');self.frame_with('commands')
        self.input('\x1b[27u');self.frame_with('KEYS_READY')
        self.assertEqual(logs[1].read_bytes(),expected)
        # Dialog Return is owned by Corgi, not the Kitty application underneath.
        self.input('\x1b[98;5uTRenamed\x1b[13u');self.tab_frame('Renamed')
        self.assertEqual(logs[1].read_bytes(),expected)
        self.rpc(op='focus',pane=panes[0])
        self.input('\x1b[106;')
        time.sleep(.12)  # Beyond the lone-ESC timeout; still one encoded key.
        self.assertEqual(logs[0].read_bytes(),b'')
        self.input('5u\x1b[27u\x1b[13u')
        self.until(lambda:logs[0].read_bytes()==b'\n\x1b\r')
        self.input('\x1b[57352;5u')
        self.until(lambda:logs[0].read_bytes()==b'\n\x1b\r\x1b[1;5A')
        # A CSI-u-looking string inside a paste is literal data.
        self.input('\x1b[200~\x1b[106;5u\x1b[201~')
        self.until(lambda:logs[0].read_bytes()==b'\n\x1b\r\x1b[1;5A\x1b[200~\x1b[106;5u\x1b[201~')
        before=logs[0].read_bytes()
        self.input('\x1b[')
        self.until(lambda:logs[0].read_bytes()==before+b'\x1b[')
        self.input('x')
        self.until(lambda:logs[0].read_bytes()==before+b'\x1b[x')

    def test_paste_stays_in_original_pane_when_another_viewer_changes_focus(self):
        fixture=pathlib.Path(self.temp.name,'paste.py')
        fixture.write_text("""import os,sys,tty
from pathlib import Path
tty.setraw(0)
log=Path(sys.argv[1]);log.write_bytes(b'')
os.write(1,b'\\x1b[?2004hPASTE_READY')
while True:
    with log.open('ab') as output:output.write(os.read(0,1024))
""")
        logs=[pathlib.Path(self.temp.name,name) for name in ('first-input','second-input')]
        panes=[self.open_pane(cwd=self.temp.name, command=shlex.join([sys.executable,str(fixture),str(log)]))['pane'] for log in logs]
        for pane in panes:self.until(lambda:'PASTE_READY' in self.command('pane.read', target=int(str(pane)), view='screen')['text'])
        self.rpc(op='focus',pane=panes[0])
        self.attach();self.get_type('frame')
        other,reader=self.viewer();self.viewer_frame(reader,'PASTE_READY')
        self.input('\x1b[200~')
        self.until(lambda:logs[0].read_bytes()==b'\x1b[200~')
        other.request(op='input',data='\x02n')
        self.assertEqual(other.state['pane'],panes[1])
        self.assertEqual(self.client.state['pane'],panes[0])
        self.input('\x1b[')
        self.until(lambda:logs[0].read_bytes()==b'\x1b[200~\x1b[')
        self.input('PASTED_TEXT\x1b[201~')
        self.until(lambda:logs[0].read_bytes()==b'\x1b[200~\x1b[PASTED_TEXT\x1b[201~')
        self.assertEqual(logs[1].read_bytes(),b'')
    def test_paused_viewer_receives_latest_state_on_next_sync(self):
        self.attach();self.get_type('frame')
        other,_=self.viewer()
        self.rpc(op='action',name='rename',value='Latest frame')
        self.tab_frame('Latest frame')
        self.viewer_frame(other,'Latest frame')
    def test_workspace_context_menu_rename_close_and_last_workspace(self):
        first=self.workspaces()[0]['id']
        self.command('workspace.edit', name='Keep', target=first)
        pane=self.open_pane(cwd=self.temp.name)['pane']
        second=self.new_workspace(name='Target',cwd=self.temp.name)['workspace']
        self.rpc(op='workspace.switch',workspace=first)
        self.attach();self.frame_with('Target')
        self.input('\x1b[<2;5;6M\x1b[<2;5;6m')
        menu=self.frame_with('|Rename')
        self.assertTrue(any('|Close' in row for row in menu))
        self.assertFalse(any('|New tab' in row for row in menu))
        self.assertEqual(next(w['id'] for w in self.workspaces() if w['active']),first)
        self.click_text(menu,'Rename');self.frame_with('edit workspace: name')
        self.input('Renamed\r');self.frame_with('Renamed')
        self.assertEqual(next(w['name'] for w in self.workspaces() if w['id']==second),'Renamed')
        self.input('\x1b[<2;5;6M\x1b[<2;5;6m')
        self.click_text(self.frame_with('|Close'),'Close')
        self.until(lambda:len(self.workspaces())==1)
        self.assertEqual([p['id'] for p in self.panes()],[pane])
        self.input('\x1b[<2;5;3M\x1b[<2;5;3m')
        self.frame_with('|Rename');self.input('\x1b[B\r')
        self.frame_with('Cannot close the last workspace')
        self.assertEqual([p['id'] for p in self.panes()],[pane])

    def test_tab_context_menu_targets_clicked_tab_for_rename_and_new(self):
        one=pathlib.Path(self.temp.name,'one');one.mkdir()
        two=pathlib.Path(self.temp.name,'two');two.mkdir()
        first=self.open_pane(cwd=str(one), title='One')['pane']
        second=self.open_pane(cwd=str(two), title='Two')['pane']
        self.attach();screen=self.tab_frame('Two')
        self.right_click_tab(screen,'One');menu=self.frame_with('|New tab')
        self.assertTrue(any('|Rename' in row for row in menu))
        self.assertTrue(any('|Close' in row for row in menu))
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),second)
        self.input('\x1b[200~touch CONTEXT_LEAK\r\x1b[201~')
        self.click_text(menu,'Rename');self.frame_with('rename tab')
        self.input('First\r');screen=self.tab_frame('First')
        self.assertEqual(next(p['id'] for p in self.panes() if p['focused']),first)
        self.rpc(op='focus',pane=second)
        self.right_click_tab(screen,'First');menu=self.frame_with('|New tab')
        self.click_text(menu,'New tab');self.frame_with('new tab')
        self.assertEqual(self.tab_count(),2)
        self.input('\r')
        self.until(lambda:self.tab_count()==3)
        self.assertEqual(self.tab_count(),3)
        new=next(p for p in self.panes() if p['focused'])
        self.assertTrue(pathlib.Path(new['cwd']).samefile(one))
        self.assertFalse((one/'CONTEXT_LEAK').exists());self.assertFalse((two/'CONTEXT_LEAK').exists())
    def test_tab_context_close_keeps_target_through_focus_and_reorder(self):
        first=self.open_pane(cwd=self.temp.name, title='First')['pane']
        self.split_pane(cwd=self.temp.name, direction='right')
        second=self.open_pane(cwd=self.temp.name, title='Second')['pane']
        self.attach();screen=self.tab_frame('Second')
        self.right_click_tab(screen,'First');menu=self.frame_with('|New tab')
        self.rpc(op='focus',pane=second)
        self.rpc(op='action',name='move-tab',value='left')
        self.click_text(menu,'Close')
        self.until(lambda:[p['id'] for p in self.panes()]==[second])
        self.assertEqual(self.session()['closed_panes'],2)
        gone=self.open_pane(cwd=self.temp.name, title='Gone')['pane']
        self.rpc(op='focus',pane=second);screen=self.tab_frame('Gone')
        self.right_click_tab(screen,'Gone');self.frame_with('|New tab')
        self.command('pane.close', target=gone)
        # Dismiss when its target disappears, never reuse the neighboring tab.
        for _ in range(100):
            screen=screen_text(self.get_type('frame')['data'])
            if '|New tab' not in '\n'.join(screen) and 'Gone' not in screen[0]:break
        else:self.fail('stale tab menu')
        self.assertEqual([p['id'] for p in self.panes()],[second])
    def test_tab_context_keyboard_dismissal_and_minimum_size(self):
        self.attach();screen=self.frame_with(' 1 ')
        self.right_click_tab(screen,' 1 ');menu=self.frame_with('|New tab')
        self.click(79,23);screen=self.frame_with('^B commands')
        self.assertNotIn('|New tab','\n'.join(screen))
        self.right_click_tab(screen,' 1 ');self.frame_with('|New tab')
        self.input('\x1b');time.sleep(.1);self.client.poll();screen=self.frame_with('^B commands')
        self.assertNotIn('|New tab','\n'.join(screen))
        self.write(op='size',cols=10,rows=4)
        screen=self.frame_with(' 1 ',10,4)
        self.right_click_tab(screen,' 1 ');menu=self.frame_with('|New tab',10,4)
        self.assertTrue(any('|Rename' in row for row in menu))
        self.assertTrue(any('|Close' in row for row in menu))
        self.input('\x1b[');self.input('B\r')
        self.frame_with('rename t',10,4);self.input('Tiny\r')
        self.tab_frame('Tiny',10,4)
    def test_wheel_scrollback_keeps_keyboard_live(self):
        fixture=pathlib.Path(self.temp.name,'scroll-input.py')
        fixture.write_text('''import os, tty
tty.setraw(0)
os.write(1, b''.join(f'HISTORY_{i}\\r\\n'.encode() for i in range(100))+b'LIVE_PROMPT')
while True:
    with open('scroll-input', 'ab') as log: log.write(os.read(0, 1024))
''')
        self.open_pane(cwd=self.temp.name, command=f'exec {shlex.quote(sys.executable)} {shlex.quote(str(fixture))}')
        self.attach();self.frame_with('LIVE_PROMPT')
        log=pathlib.Path(self.temp.name,'scroll-input')
        expected=b''
        for keys,forwarded in (('jkqy',b'jkqy'),('\x1b[A',b'\x1b[A'),
                               ('\x1b[107;5u',b'\x0b'),
                               ('\x1b[200~paste\x1b[201~',b'paste'),('\x1b',b'\x1b')):
            self.input('\x1b[<64;40;10M')
            screen=screen_text(self.get_type('frame')['data'])
            self.assertNotIn('LIVE_PROMPT','\n'.join(screen))
            self.assertNotIn('SCROLL  j/k','\n'.join(screen))
            self.input(keys)
            expected+=forwarded
            self.until(lambda:log.exists() and log.read_bytes()==expected)
            self.frame_with('LIVE_PROMPT')
        # Explicit copy mode remains modal, including when using the wheel.
        self.input('\x02[');self.frame_with('SCROLL  j/k')
        self.input('\x1b[<64;40;10Mzqx')
        expected+=b'x'
        self.until(lambda:log.read_bytes()==expected)
        self.frame_with('LIVE_PROMPT')
    def test_wheel_and_right_drag_do_not_open_commands(self):
        self.attach();self.frame_with('^B commands')
        for modifiers in (0,4,8,16,28):
            for button in (64,65,66,67,34):
                self.input(f'\x1b[<{button | modifiers};40;10M')
                frame=self.get_type('frame')['data']
                self.assertNotIn('Commands',frame,(button,modifiers))
        # A real right-button press opens the clicked pane's context menu.
        self.input('\x1b[<2;40;10M\x1b[<2;40;10m')
        self.frame_with('Rename pane')
    def test_menu_hover_highlights_and_click_activates(self):
        self.attach();self.get_type('frame')
        self.input('\x02')
        menu=self.frame_with('Commands')
        y=next(i for i,row in enumerate(menu) if 'Split right' in row)
        x=menu[y].index('Split right')
        self.input(f'\x1b[<35;{x+1};{y+1}M')
        for _ in range(100):
            data=self.get_type('frame')['data']
            if '\x1b[38;2;24;27;32mSplit right' in data:break
        else:self.fail('hover did not highlight command')
        self.assertIn('\x1b[?1003h',data)
        self.assertNotIn('\x1b[?1002l',data)
        self.assertNotIn('\x1b[?1003l',data)
        self.assertEqual(len(self.panes()),1)
        self.click(x+1,y+1)
        self.until(lambda:len(self.panes())==2)
        for _ in range(100):
            data=self.get_type('frame')['data']
            if 'Commands' not in data and '\x1b[?1003h' in data:break
        else:self.fail('menu close did not preserve motion tracking')
        self.assertNotIn('\x1b[?1002l',data)
        self.assertNotIn('\x1b[?1003l',data)

    def test_prefix_menu_keyboard_mouse_and_no_paste_leak(self):
        self.attach();self.get_type('frame')
        self.input('\x02');menu=self.frame_with('Commands')
        self.assertTrue(any('c  New tab' in row for row in menu))
        self.assertTrue(any('r  Resize panes...' in row for row in menu))
        self.input('\x1b[200~touch MENU_LEAK\r\x1b[201~')
        self.click_text(menu,'New tab')
        self.frame_with('new tab');self.input('\r')
        self.until(lambda:self.tab_count()==2)
        self.assertFalse(pathlib.Path(self.temp.name,'MENU_LEAK').exists())
        self.input('\x02');menu=self.frame_with('Commands')
        self.click_text(menu,'Split right')
        self.until(lambda:len(self.panes())==3)
        self.input('\x02');menu=self.frame_with('Commands')
        self.click_text(menu,'Resize panes...')
        menu=self.frame_with('Resize panes')
        self.click_text(menu,'Resize left')
        self.frame_with('Resize panes')
        self.input('\x1b');self.frame_with('^B commands')
        self.input('\x02');menu=self.frame_with('Commands')
        self.click_text(menu,'Close pane')
        self.until(lambda:len(self.panes())==2)
        self.input('\x02?');self.frame_with('Commands')
        self.click(1,23);self.frame_with('^B commands')
        self.input("printf '%s%s\\n' MENU_ CLOSED\r")
        pane=next(p for p in self.panes() if p['focused'])['id']
        self.until(lambda:'MENU_CLOSED' in self.command('pane.read', target=int(str(pane)), view='screen')['text'])
    def test_plus_creates_tab_and_previews_automatic_number(self):
        self.attach();initial=self.frame_with(' + ')
        self.assertEqual(initial[0].rindex(' + ')-28,10)
        self.click_text(initial[:1],' + ')
        prompt=self.frame_with('new tab')
        self.assertEqual(self.tab_count(),1)
        title_row=next(i for i,row in enumerate(prompt) if 'new tab' in row)
        self.assertEqual(prompt[title_row+2].split('│')[1].strip(),'2')
        self.input('My work\r')
        screen=self.tab_frame('My work')
        self.assertNotIn('2:My work',screen[0])
        self.assertEqual(screen[0].rindex(' + ')-28,20)
        self.assertNotIn('new tab','\n'.join(screen))
        pane=next(p for p in self.panes() if p['focused'])
        self.assertTrue(pathlib.Path(pane['cwd']).samefile(self.temp.name))
        self.click_text(screen[:1],' + ');self.frame_with('new tab')
        self.input('\x1b');time.sleep(.1);self.client.poll();screen=self.frame_with('^B commands')
        self.assertEqual(self.tab_count(),2)
        self.click_text(screen[:1],' + ');self.frame_with('new tab')
        self.input('\r');screen=self.frame_with(' 3 ')
        self.assertEqual(self.tab_count(),3)
    def test_unnamed_tabs_recompute_numbers_after_reorder_close_and_restore(self):
        self.attach();self.frame_with(' 1 ')
        first=self.panes()[0]['id']
        self.input('\x02c');self.frame_with('new tab')
        self.rpc(op='action',name='new')
        screen=self.frame_with('│3')  # A draft does not freeze the next position.
        self.input('\r');screen=self.tabs_are('1 2 3')
        third=next(p['id'] for p in self.panes() if p['focused'])
        self.rpc(op='hook',pane=third,provider='codex',seq=1,event={'hook_event_name':'SessionStart','session_id':'numbering'})
        self.agent_frame('codex','○')
        self.rpc(op='action',name='move-tab',value='left');screen=self.tabs_are('1 2 3')
        self.assertEqual(' '.join(screen[0][28:].split()),'1 2 3 +')
        self.command('pane.close', target=first);screen=self.tabs_are('1 2')
        self.assertEqual(' '.join(screen[0][28:].split()),'1 2 +');self.assertNotIn(' 3 ',screen[0])
        self.input('\x02T');self.frame_with('rename tab')
        self.rpc(op='action',name='move-tab',value='right');self.frame_with('│2')
        self.input('\r');screen=self.tabs_are('1 2')
        self.assertEqual(' '.join(screen[0][28:].split()),'1 2 +')  # Saving the preview keeps the name unset.
        self.input('\x02TPinned\r');self.tab_frame('Pinned')
        self.input('\x02T\x03');self.frame_with('│2')
        self.input('\r');screen=self.tabs_are('1 2')
        self.assertEqual(' '.join(screen[0][28:].split()),'1 2 +')
        self.input('\x02T2\r');self.tabs_are('1 2')
        self.rpc(op='action',name='move-tab',value='left');self.tabs_are('2 2')
        self.rpc(op='action',name='undo-close');screen=self.frame_with(' 3 ')
        self.assertEqual(' '.join(screen[0][28:].split()),'2 2 3 +')
        second=next(p['id'] for p in self.panes() if p['id']!=third and not p['focused'])
        self.command('pane.close', target=second);screen=self.tabs_are('2 2')
        self.assertNotIn(' 3 ',screen[0])
        self.split_pane(cwd=self.temp.name, direction='right')
        self.rpc(op='action',name='break');screen=self.tabs_are('2 2 3')
        self.open_pane(command='sleep 30');screen=self.tabs_are('2 2 3 4')
        self.assertNotIn('shell',screen[0])
    def test_menu_paging_and_plus_remain_usable_in_narrow_terminal(self):
        self.attach();self.get_type('frame')
        self.write(op='size',cols=30,rows=8)
        self.input('\x02');menu=self.frame_with('Commands',30,8)
        self.assertTrue(any('Next >' in row for row in menu))
        self.click_text(menu,'Next >');menu=self.frame_with('Split right',30,8)
        self.click_text(menu,'Split right');self.until(lambda:len(self.panes())==2)
        for i in range(4):self.open_pane(cwd=self.temp.name, title='Long tab name '+str(i))
        screen=self.tab_frame('Long tab name 3',30,8)
        self.click_text(screen[:1],' + ')
        self.frame_with('new tab',30,8);self.input('\r')
        self.until(lambda:self.tab_count()==6)
    def test_name_dialog_mouse_buttons_and_cursor_editing(self):
        self.attach();self.get_type('frame')
        self.input('\x02T');dialog=self.frame_with('rename tab')
        self.assertTrue(any('┌' in row and '┐' in row for row in dialog))
        self.click_text(dialog,'^C clear')
        self.input('ac\x1b[Db');dialog=self.frame_with('│abc')
        self.click_text(dialog,'↵ save');screen=self.tab_frame('abc')
        self.input('\x02T');dialog=self.frame_with('rename tab')
        self.input('discarded');self.frame_with('│discarded')
        self.click_text(dialog,'esc cancel');screen=self.tab_frame('abc')
        self.assertNotIn('discarded',screen[0])
        self.input('\x02T');self.frame_with('rename tab')
        self.input('\x03\x1b[200~new\rname\x1b[201~')
        dialog=self.frame_with('│newname')
        self.click_text(dialog,'↵ save');self.tab_frame('newname')
        self.input('\x02c');dialog=self.frame_with('new tab')
        self.click_text(dialog,'esc cancel');self.tab_frame('newname')
        self.assertEqual(self.tab_count(),1)
        self.assertEqual(self.session()['closed_panes'],0)
    def test_name_dialog_retains_target_and_failed_creation_is_cancelable(self):
        self.attach();self.get_type('frame')
        self.input('\x02T');self.frame_with('rename tab')
        self.open_pane(cwd=self.temp.name, title='Other')
        self.input('Original\r');self.tab_frame('Original')
        self.assertEqual(self.tab_count(),2)
        folder=pathlib.Path(self.temp.name,'removed');folder.mkdir()
        self.open_pane(cwd=str(folder), title='Removed')
        self.rpc(op='action',name='move-tab',value='left')
        self.rpc(op='action',name='move-tab',value='left')
        self.input('\x02c');self.frame_with('new tab');folder.rmdir()
        self.input('\r');dialog=self.frame_with('Could not save.')
        self.assertEqual(self.tab_count(),3)
        self.click_text(dialog,'esc cancel');self.tab_frame('Removed')
        self.assertTrue(self.rpc(op='ping')['ok'])
    def test_tab_pane_identity_and_process_survival(self):
        first=self.open_pane(cwd=self.temp.name, command="printf 'PERSIST\\n'; exec /bin/sh")['pane']
        second=self.split_pane(cwd=self.temp.name, direction='right', command="printf 'SECOND\\n'; exec /bin/sh")['pane']
        self.until(lambda:'PERSIST' in self.command('pane.read', target=int(str(first)), view='screen')['text'])
        self.rpc(op='action',name='break');self.assertEqual(self.tab_count(),2)
        self.rpc(op='action',name='join',value='1');self.assertEqual(self.tab_count(),1)
        self.assertEqual([p['id'] for p in self.panes()],[first,second])
        self.command('pane.close', target=second);self.assertIn('PERSIST',self.command('pane.read', target=int(str(first)), view='screen')['text'])
    def test_shell_exit_removes_split_and_hidden_tab(self):
        first=self.open_pane(cwd=self.temp.name)['pane']
        second=self.split_pane(cwd=self.temp.name, direction='right')['pane']
        self.command('pane.input', target=second, data=('exit') + '\r')
        self.until(lambda:[p['id'] for p in self.panes()]==[first])
        self.assertTrue(self.panes()[0]['focused']);self.assertEqual(self.tab_count(),1)
        third=self.open_pane(cwd=self.temp.name)['pane']
        self.command('pane.input', target=first, data=('exit') + '\r')
        self.until(lambda:[p['id'] for p in self.panes()]==[third])
        self.assertTrue(self.panes()[0]['focused']);self.assertEqual(self.tab_count(),1)
    def test_last_shell_exit_detaches_and_keyboard_undo_preserves_output_and_cwd(self):
        self.attach();self.get_type('frame')
        sub=pathlib.Path(self.temp.name,'nested');sub.mkdir()
        self.input('cd nested; printf "SAVED_OUTPUT\\n"\r')
        self.until(lambda:'SAVED_OUTPUT' in self.command('pane.read', target=int('1'), view='screen')['text'])
        self.until(lambda:pathlib.Path(self.panes()[0]['cwd']).samefile(sub))
        self.input('exit\r');self.until(lambda:self.tab_count()==0)
        self.get_type('detach')
        self.assertEqual(self.session()['closed_panes'],1)
        self.reconnect()
        self.input('\x02u')
        self.until(lambda:len(self.panes())==2)
        pane=next(p for p in self.panes() if p['focused']);self.assertNotEqual(pane['id'],1)
        self.assertFalse(pane['exited']);self.assertEqual(pane['provider'],'other')
        self.assertTrue(pathlib.Path(pane['cwd']).samefile(sub))
        self.assertIn('SAVED_OUTPUT',self.command('pane.read', target=int(str(pane['id'])), view='screen')['text'])
        self.assertEqual(self.session()['closed_panes'],0)
        self.input("printf '%s%s\\n' FRESH_ SHELL\r")
        self.until(lambda:'FRESH_SHELL' in self.command('pane.read', target=int(str(pane['id'])), view='screen')['text'])
    def test_closed_history_is_bounded_and_does_not_rerun_commands(self):
        for i in range(10):
            self.open_pane(cwd=self.temp.name, title=f'saved-{i}', command=f'printf "FINAL_{i}\\n"; echo ran >> runs; exit 7')
            self.until(lambda:self.tab_count()==0)
            self.assertEqual(self.session()['closed_panes'],min(i+1,8))
        self.attach();self.get_type('frame')
        for i in range(9,1,-1):
            self.rpc(op='action',name='undo-close')
            pane=next(p for p in self.panes() if p['focused'])
            self.assertIn(f'FINAL_{i}',self.command('pane.read', target=int(str(pane['id'])), view='screen')['text'])
        self.assertEqual(self.session()['closed_panes'],0)
        self.assertEqual(len(pathlib.Path(self.temp.name,'runs').read_text().splitlines()),10)
        self.rpc(op='action',name='undo-close')
        self.assertEqual(len(self.panes()),9)  # The attach shell plus eight restores.
    def test_manual_close_retains_scrollback_and_cancels_stale_modes(self):
        self.attach();self.get_type('frame')
        self.input("printf 'SCROLLBACK_SENTINEL\\n'; i=0; while [ $i -lt 50 ]; do echo line-$i; i=$((i+1)); done\r")
        self.until(lambda:'line-49' in self.command('pane.read', target=int('1'), view='screen')['text'])
        self.input('\x02TStored name\r\x02[/missing')
        self.command('pane.close', target=1)
        self.get_type('detach');self.reconnect()
        self.input('\x02u')
        self.until(lambda:len(self.panes())==2)
        pane=next(p['id'] for p in self.panes() if p['focused'])
        self.input('\x02[g')
        self.frame_with('SCROLLBACK_SENTINEL')
        while 'Stored name' not in self.get_type('frame')['data']:pass
        self.input('q')
        self.input("printf '%s%s\\n' LIVE_AFTER_ UNDO\r")
        self.until(lambda:'LIVE_AFTER_UNDO' in self.command('pane.read', target=int(str(pane)), view='screen')['text'])
    def test_panes_use_full_height_and_translate_first_row_input(self):
        fixture=pathlib.Path(self.temp.name,'screen.py')
        fixture.write_text('''import os, signal, tty
tty.setraw(0)
def draw(*_):
    cols, rows = os.get_terminal_size(0)
    os.write(1, f'\\x1b[2J\\x1b[HTOP_{rows}x{cols}\\x1b[{rows};1HBOTTOM_{rows}\\x1b[1;2H\\x1b[?1000h\\x1b[?1006h'.encode())
signal.signal(signal.SIGWINCH, draw)
draw()
while True:
    with open('mouse-input', 'ab') as log: log.write(os.read(0, 1024))
''')
        command=f'exec {shlex.quote(sys.executable)} {shlex.quote(str(fixture))}'
        first=self.open_pane(cwd=self.temp.name, command=command)['pane']
        self.attach()
        screen=self.frame_with('BOTTOM_22')
        self.assertTrue(screen[1][28:].startswith('TOP_22x52'))
        self.assertTrue(screen[22][28:].startswith('BOTTOM_22'))
        self.rpc(op='hook',pane=first,provider='codex',seq=1,event={'hook_event_name':'SessionStart','session_id':'geometry'})
        frame=self.get_type('frame')['data']
        while 'codex idle' not in frame: frame=self.get_type('frame')['data']
        self.assertIn('\x1b[2;30H\x1b[?25h',frame)
        self.assertIn('codex idle',screen_text(frame)[23])
        self.click(31,2);self.click(31,23)
        log=pathlib.Path(self.temp.name,'mouse-input')
        expected=b'\x1b[<0;3;1M\x1b[<0;3;1m\x1b[<0;3;22M\x1b[<0;3;22m'
        self.until(lambda:log.exists() and log.read_bytes()==expected)
        # Forward all four wheel directions without converting sideways to vertical.
        for button in (64,65,66,67,72,73,74,75):
            self.input(f'\x1b[<{button};31;2M')
            expected+=f'\x1b[<{button};3;1M'.encode()
        self.until(lambda:log.read_bytes()==expected)
        # Shift-drag the first terminal row while the app has mouse reporting enabled.
        self.input('\x1b[<4;29;2M\x1b[<36;31;2M\x1b[<4;31;2m')
        frame=self.get_type('frame')['data']
        while not frame.startswith('\x1b]52;c;'): frame=self.get_type('frame')['data']
        self.assertEqual(base64.b64decode(frame[7:-1]),b'TOP')
        self.split_pane(cwd=self.temp.name, direction='down', command=command)
        screen=self.frame_with('TOP_10x50')
        self.assertTrue(screen[2][29:].startswith('TOP_9x50'))
        self.assertTrue(screen[10][29:].startswith('BOTTOM_9'))
        self.assertTrue(screen[12][29:].startswith('TOP_10x50'))
        self.assertTrue(screen[21][29:].startswith('BOTTOM_10'))
        self.rpc(op='action',name='zoom')
        screen=self.frame_with('TOP_22x52')
        self.assertTrue(screen[1][28:].startswith('TOP_22x52'))
        self.assertTrue(screen[22][28:].startswith('BOTTOM_22'))
        self.input('\x02b')
        screen=self.frame_with('TOP_22x80')
        self.assertTrue(screen[1].startswith('TOP_22x80'))
        self.assertTrue(screen[22].startswith('BOTTOM_22'))
        self.write(op='size',cols=10,rows=4)
        screen=self.frame_with('TOP_2x10',10,4)
        self.assertTrue(screen[1].startswith('TOP_2x10'))
        self.assertTrue(screen[2].startswith('BOTTOM_2'))
    def test_keyboard_fragmented_paste_mouse_resize_and_reattach(self):
        self.attach();self.get_type('frame')
        self.input('\x02v');self.until(lambda:len(self.panes())==2)
        self.input('\x02-');self.until(lambda:len(self.panes())==3)
        self.input('\x02h');self.until(lambda:self.panes()[0]['focused'])
        pasted=pathlib.Path(self.temp.name,'pasted')
        self.input('\x1b[20');self.input('0~printf PASTED > pasted');self.input('\x1b[201~');self.input('\r')
        self.until(lambda:pasted.exists() and pasted.read_text()=='PASTED')
        self.input('\x1b[<0;54;10M\x1b[<32;60;10M\x1b[<0;60;10m')
        self.input('\x02c');self.frame_with('new tab');self.input('\r')
        self.until(lambda:self.tab_count()==2)
        self.input('\x02TRenamed\r')
        self.input('\x02q');self.get_type('detach')
        self.client.close();self.client=None
        self.attach();frame=self.get_type('frame');self.assertIn('Renamed',frame['data'])
        self.input('\x021');self.until(lambda:self.panes()[0]['focused'])
        self.assertEqual(pasted.read_text(),'PASTED')
    def test_sidebar_hook_lifecycle_focus_and_removal(self):
        one=self.open_pane(cwd=self.temp.name, title='Alpha', command='sleep 30')['pane']
        self.open_pane(cwd=self.temp.name, title='Beta', command='sleep 30')
        self.attach();screen=self.frame_with('No agents yet')
        self.assertTrue(screen[0].startswith(' workspaces'))
        transcript=pathlib.Path(self.temp.name,'sidebar.jsonl')
        transcript.write_text(json.dumps({'type':'session_meta','payload':{'id':'sidebar'}})+'\n')
        turn=0
        def hook(event,**extra):
            nonlocal turn
            if event=='UserPromptSubmit':turn+=1
            extra.update(transcript_path=str(transcript),turn_id=str(turn))
            p=subprocess.run([EXE,'hook','codex'],env={**self.env,'CORGI_PANE':str(one)},input=json.dumps({'hook_event_name':event,'session_id':'sidebar',**extra}),text=True,capture_output=True,timeout=3)
            self.assertEqual((p.returncode,p.stdout,p.stderr),(0,'',''))
            if event=='Stop':
                with transcript.open('a') as f:f.write(json.dumps({'type':'event_msg','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'payload':{'type':'task_complete','turn_id':str(turn)}})+'\n')
        hook('SessionStart');screen=self.agent_frame('codex','○',color='166;227;161')
        self.assertNotIn('SessionStart','\n'.join(screen))
        self.assertNotIn('Alpha','\n'.join(row[:27] for row in screen))
        hook('UserPromptSubmit');self.agent_frame('codex','●',activity='thinking',color='249;226;175')
        hook('PreToolUse',tool_name='Bash');screen=self.agent_frame('codex','●',activity='🔧')
        self.assertIn('Bash','\n'.join(row[:27] for row in screen))
        hook('PreToolUse',tool_name='request_user_input');screen=self.agent_frame('codex','●',activity='🔧',color='243;139;168')
        self.assertEqual(self.panes()[0]['attention'],'needs_input')
        self.click_text([row[:27] for row in screen],'codex')
        self.until(lambda:self.panes()[0]['focused'] and self.panes()[0]['attention']=='none')
        self.assertEqual(self.panes()[0]['state'],'blocked')
        self.rpc(op='action',name='rename',value='Renamed')
        screen=self.tab_frame('Renamed')
        self.assertNotIn('Renamed','\n'.join(row[:27] for row in screen))
        hook('PostToolUse',tool_name='Bash');self.agent_frame('codex','●',activity='thinking')
        hook('UserPromptSubmit');self.agent_frame('codex','●',activity='thinking',color='249;226;175')
        hook('Stop');self.agent_frame('codex','○',color='166;227;161')
        hook('SessionEnd');self.agent_frame('codex','○',color='108;112;134')
        self.command('pane.close', target=one)
        screen=self.frame_with('No agents yet')
        self.assertNotIn('Renamed','\n'.join(row[:27] for row in screen))
        self.click(25,1);screen=self.frame_with(' > ')
        self.assertTrue(screen[0].startswith(' > '))
        self.click(2,1);self.frame_with('No agents yet')
    def test_sidebar_scrolling_and_clicks_keep_stable_pane_targets(self):
        panes=[]
        for index in range(12):
            directory=pathlib.Path(self.temp.name,f'Agent-{index}');directory.mkdir()
            pane=self.open_pane(cwd=str(directory), title=f'Tab-{index}', command='sleep 30')['pane'];panes.append(pane)
            self.command('pane.rename', name=f'Agent-{index}', target=pane)
            self.rpc(op='hook',pane=pane,provider='claude',seq=1,event={'hook_event_name':'SessionStart','session_id':str(index)})
        self.attach();screen=self.frame_with('< 1-4/12 >')
        self.assertNotIn('Agent-11','\n'.join(row[:27] for row in screen[12:23]))
        self.input('\x1b[<65;5;15M');screen=self.frame_with('< 2-5/12 >')
        self.click(20,23);screen=self.frame_with('< 6-9/12 >')
        self.click_text(['' if i < 12 else row[:27] for i,row in enumerate(screen)],'Agent-8')
        self.until(lambda:next(p['id'] for p in self.panes() if p['focused'])==panes[8])
        self.rpc(op='action',name='move-tab',value='left')
        self.command('pane.close', target=panes[11]);screen=self.frame_with('< 6-9/11 >')
        self.click_text(['' if i < 12 else row[:27] for i,row in enumerate(screen)],'Agent-8')
        self.until(lambda:next(p['id'] for p in self.panes() if p['focused'])==panes[8])
        self.write(op='size',cols=30,rows=8)
        screen=self.frame_with(' + ',30,8)
        self.assertNotIn('agents',screen[0])
        self.write(op='size',cols=80,rows=24);self.frame_with('< 6-9/11 >')
    def test_sidebar_keeps_provider_and_activity_separate_from_directory_and_tab_title(self):
        project=pathlib.Path(self.temp.name,'frontend');project.mkdir()
        pane=self.open_pane(cwd=self.temp.name, title='Unrelated tab name')['pane']
        self.rpc(op='hook',pane=pane,provider='claude',seq=1,event={'hook_event_name':'SessionStart','session_id':'directory'})
        self.attach();self.agent_frame('claude','○')
        self.command('pane.input', target=pane, data=('cd '+shlex.quote(str(project))) + '\r')
        self.until(lambda:pathlib.Path(self.panes()[0]['cwd']).samefile(project))
        screen=self.agent_frame('claude','○')
        self.assertNotIn('Unrelated','\n'.join(row[:27] for row in screen))
        self.rpc(op='hook',pane=pane,provider='claude',seq=2,event={'hook_event_name':'PreToolUse','session_id':'directory','cwd':'/a/very/long/working/directory/backend','tool_name':'Read'})
        screen=self.agent_frame('claude','●',activity='🔧')
        self.assertEqual(self.session()['panes'][0]['agent']['cwd'],'/a/very/long/working/directory/backend')
        self.assertIn('Read',screen[14])
        self.rpc(op='hook',pane=pane,provider='claude',seq=3,event={'hook_event_name':'PostToolUse','session_id':'directory','tool_name':'Read'})
        self.agent_frame('claude','●',activity='thinking')
    def test_sidebar_native_updates_and_selection_keep_approvals_pending(self):
        self.open_pane(cwd=self.temp.name, command='sleep 30')
        self.attach();self.get_type('frame')
        ident=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        self.agent_frame('codex','○',color='166;227;161')
        self.rpc(op='native.send',session=ident,message={'id':1,'method':'test/approval'})
        screen=self.agent_frame('codex','●',activity='🔧',color='243;139;168')
        self.click_text([row[:27] for row in screen],'codex')
        self.frame_with(f'corgi native events {ident}')
        session=self.rpc(op='native.list')['sessions'][0]
        self.assertEqual((session['pending_requests'],session['attention']),(1,'needs_input'))
        self.rpc(op='native.send',session=ident,message={'id':900,'result':{'decision':'decline'}})
        self.agent_frame('codex','●',color='148;226;213')
        self.rpc(op='native.send',session=ident,message={'id':2,'method':'test/exit'})
        self.agent_frame('codex','○',color='108;112;134')
        self.until(lambda:self.rpc(op='native.list')['sessions'][0]['exited'])
        self.rpc(op='native.stop',session=ident);self.frame_with('No agents yet')
    def test_native_tool_activity_tracks_overlapping_calls_and_clears_on_turn_end(self):
        self.attach();self.get_type('frame')
        for provider in ('codex','claude'):
            ident=self.rpc(op='native.start',provider=provider,cwd=self.temp.name)['session']
            self.agent_frame(provider,'○')
            def send(method,tool='a'):
                self.rpc(op='native.send',session=ident,message={'method':'test/'+method,'params':{'id':tool}})
            def count(n):
                self.until(lambda:next(s for s in self.rpc(op='native.list')['sessions'] if s['id']==ident)['active_tools']==n)
            send('tool-start');count(1);self.agent_frame(provider,'●',activity='🔧')
            send('tool-start','b');count(2)
            send('tool-stop');count(1)
            self.write(op='size',cols=80,rows=24);self.agent_frame(provider,'●',activity='🔧')
            send('tool-stop','b');count(0);self.agent_frame(provider,'●',activity='thinking')
            send('tool-start','c');count(1);self.agent_frame(provider,'●',activity='🔧')
            send('turn-end');count(0);self.agent_frame(provider,'●',color='148;226;213')
            send('tool-start','d');count(1)
            send('exit');count(0)
            self.agent_frame(provider,'○',color='108;112;134')
            self.rpc(op='native.stop',session=ident);self.frame_with('No agents yet')
    def test_real_client_plays_embedded_request_and_completion_sounds(self):
        players=pathlib.Path(self.temp.name,'players');players.mkdir()
        played=pathlib.Path(self.temp.name,'played.jsonl')
        player=f"""#!{sys.executable}
import hashlib,json,pathlib,sys
sound=pathlib.Path(sys.argv[-1])
with open({str(played)!r},'a') as log:
    log.write(json.dumps({{'hash':hashlib.sha256(sound.read_bytes()).hexdigest(),'path':str(sound)}})+'\\n')
"""
        for name in ('afplay','paplay','pw-play','ffplay','mpg123','mpv'):
            path=players/name;path.write_text(player);path.chmod(0o700)
        env={**self.env,'PATH':str(players)+os.pathsep+self.env.get('PATH',''),'TMPDIR':self.temp.name}
        for name in ('CORGI_BELL','SSH_CONNECTION','SSH_TTY'):env.pop(name,None)
        self.master,slave=os.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
        self.proc=subprocess.Popen([EXE],env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)
        self.until(lambda:self.panes())
        pane=self.panes()[0]['id']
        transcript=pathlib.Path(self.temp.name,'sounds.jsonl')
        transcript.write_text(json.dumps({'type':'session_meta','payload':{'id':'sounds'}})+'\n')
        turn = 'initial'
        def hook(event,seq):
            nonlocal turn
            if event == 'UserPromptSubmit': turn = str(seq)
            self.rpc(op='hook',pane=pane,provider='codex',seq=seq,event={'hook_event_name':event,'session_id':'sounds','turn_id':turn,'transcript_path':str(transcript),'tool_name':'request_user_input'})
            if event=='Stop':
                with transcript.open('a') as f:f.write(json.dumps({'type':'event_msg','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'payload':{'type':'task_complete','turn_id':turn}})+'\n')
        def records():
            while select.select([self.master],[],[],0)[0]:os.read(self.master,65536)
            return [json.loads(line) for line in played.read_text().splitlines()] if played.exists() else []
        hook('SessionStart',1);hook('UserPromptSubmit',2)
        hook('PermissionRequest',3)
        time.sleep(.7);self.assertEqual(records(),[])
        hook('PreToolUse',4)
        self.until(lambda:len(records())==1)
        self.assertEqual(records()[0]['hash'],hashlib.sha256((ROOT/'src/sounds/request.mp3').read_bytes()).hexdigest())
        # Repeated hooks and completing the currently watched pane stay quiet.
        hook('PreToolUse',5);hook('UserPromptSubmit',6);hook('Stop',7)
        time.sleep(1.6);self.assertEqual(len(records()),1)
        # A background completion uses the distinct embedded completion sound.
        background=self.open_pane(cwd=self.temp.name)['pane']
        def switched():
            records() # Drain the PTY while the queued viewer control is applied.
            return any(v['pane']==background for v in self.rpc(op='viewer.list')['viewers'])
        self.until(switched)
        hook('UserPromptSubmit',8);hook('Stop',9)
        self.until(lambda:len(records())==2)
        self.assertEqual(records()[1]['hash'],hashlib.sha256((ROOT/'src/sounds/done.mp3').read_bytes()).hexdigest())
        self.until(lambda:all(not pathlib.Path(record['path']).exists() for record in records()))
        self.rpc(op='action',name='mute')
        hook('UserPromptSubmit',10);hook('PreToolUse',11)
        time.sleep(1.6);self.assertEqual(len(records()),2)
    def test_attention_is_deduplicated_and_explicitly_acknowledged(self):
        self.attach();self.get_type('frame');self.input('\x02v');self.until(lambda:len(self.panes())==2)
        def hook(event,seq,session='test',**extra):
            return self.rpc(op='hook',pane=1,provider='claude',seq=seq,event={'hook_event_name':event,'session_id':session,**extra})
        hook('SessionStart',1);hook('UserPromptSubmit',2);hook('PermissionRequest',3)
        self.assertEqual(self.get_type('bell')['kind'],'needs_input')
        hook('PermissionRequest',4);hook('Stop',5,session='child');hook('Stop',6,agent_id='child')
        self.assertEqual(self.panes()[0]['state'],'blocked');self.assertEqual(self.panes()[0]['attention'],'needs_input')
        self.input('\x02a');self.until(lambda:self.panes()[0]['focused'])
        self.assertEqual(self.panes()[0]['attention'],'none');self.assertEqual(self.panes()[0]['state'],'blocked')
        hook('UserPromptSubmit',7);hook('Stop',8)
        self.assertEqual(self.panes()[0]['attention'],'none')
    def test_slow_and_malformed_clients_do_not_block_runtime(self):
        bad=socket.socket(socket.AF_UNIX);bad.connect(self.path);bad.sendall(b'{incomplete')
        self.assertTrue(self.rpc(op='ping')['ok']);bad.close()
        p=self.open_pane(cwd=self.temp.name, command='printf OUT; exec /bin/sh')['pane']
        self.until(lambda:'OUT' in self.command('pane.read', target=int(str(p)), view='screen')['text'])
        s=socket.socket(socket.AF_UNIX);s.connect(self.path);s.sendall(b'[]\n');self.assertIn(b'UnknownOperation',s.recv(1024));s.close()
        self.assertTrue(self.rpc(op='ping')['ok'])
    def test_hook_binary_silent_and_configuration_valid(self):
        pane=self.open_pane(cwd=self.temp.name)['pane']
        payload=json.dumps({'hook_event_name':'UserPromptSubmit','session_id':'session'})
        p=subprocess.run([EXE,'hook','claude'],env={**self.env,'CORGI_PANE':str(pane)},input=payload,text=True,capture_output=True,timeout=3)
        self.assertEqual((p.returncode,p.stdout,p.stderr),(0,'',''))
        self.until(lambda:self.panes()[0]['state']=='working')
        for provider in ('claude','codex'):
            config=json.loads(self.run_cli('hooks',provider));self.assertIn('PermissionRequest',config['hooks'])
    def restart_runtime(self):
        if self.client:self.client.close();self.client=None
        self.run_cli('shutdown')
        self.until(lambda:not pathlib.Path(self.path).exists())
        self.run_cli('start')
    def test_automatic_hook_install_preserves_settings_and_is_idempotent(self):
        original={'theme':'dark','hooks':{'Stop':[{'hooks':[{'type':'command','command':'echo existing'}]}]}}
        paths=[pathlib.Path(self.env['CODEX_HOME'],'hooks.json'),pathlib.Path(self.env['CLAUDE_CONFIG_DIR'],'settings.json')]
        for path in paths:
            path.parent.mkdir();path.write_text(json.dumps(original))
        self.restart_runtime()
        contents=[]
        for path in paths:
            self.until(lambda:'CORGI_BIN' in path.read_text())
            saved=json.loads(path.read_text());self.assertEqual(saved['theme'],'dark')
            self.assertEqual(saved['hooks']['Stop'][0],original['hooks']['Stop'][0])
            self.assertEqual(json.loads(path.with_name(path.name+'.corgi-backup').read_text()),original)
            contents.append((path.read_bytes(),path.stat().st_mtime_ns))
            command=saved['hooks']['Stop'][-1]['hooks'][0]['command']
            outside={k:v for k,v in self.env.items() if not k.startswith('CORGI_')}
            result=subprocess.run(['/bin/sh','-c',command],env=outside,input='{}',text=True,capture_output=True,timeout=3)
            self.assertEqual((result.returncode,result.stdout,result.stderr),(0,'',''))
        self.restart_runtime()
        # A new pane request waits behind startup installation.
        self.open_pane(cwd=self.temp.name)
        for path,expected in zip(paths,contents):self.assertEqual((path.read_bytes(),path.stat().st_mtime_ns),expected)
    def test_invalid_or_symlink_settings_are_left_intact(self):
        codex=pathlib.Path(self.env['CODEX_HOME']);codex.mkdir()
        claude=pathlib.Path(self.env['CLAUDE_CONFIG_DIR']);claude.mkdir()
        bad=codex/'hooks.json';bad.write_text('{broken')
        target=pathlib.Path(self.temp.name,'external.json');target.write_text('{}')
        (claude/'settings.json').symlink_to(target)
        self.restart_runtime();self.open_pane(cwd=self.temp.name)
        self.assertEqual(bad.read_text(),'{broken');self.assertEqual(target.read_text(),'{}')
        self.assertTrue((claude/'settings.json').is_symlink())
    def ordinary_agent(self,provider,hooks=False,initializing=False):
        write_ordinary_agent(pathlib.Path(self.temp.name,provider))
        if hooks:
            pathlib.Path(self.env['CODEX_HOME' if provider=='codex' else 'CLAUDE_CONFIG_DIR']).mkdir(exist_ok=True)
            self.restart_runtime()
        pane=self.open_pane(cwd=self.temp.name)['pane']
        self.command('pane.input', target=pane, data=('PATH='+shlex.quote(self.temp.name)+':$PATH '+provider+(' --loading' if initializing else '')) + '\r')
        self.until(lambda:any(p['id']==pane and p['provider']==provider for p in self.panes()))
        return pane
    def test_plain_commands_gain_hooks_without_wrappers(self):
        for provider in ('codex','claude'):
            pane=self.ordinary_agent(provider,hooks=True)
            self.until(lambda:next(p for p in self.panes() if p['id']==pane)['session']=='ordinary-'+provider)
            for command,state in [('work','working'),('block','blocked'),('stop','idle')]:
                self.command('pane.input', target=pane, data=(command) + '\r')
                self.until(lambda:next(p for p in self.panes() if p['id']==pane)['state']==state)
            self.command('pane.input', target=pane, data=('exit') + '\r')
            self.until(lambda:next(p for p in self.panes() if p['id']==pane)['provider']=='other')
            self.assertEqual(next(p for p in self.panes() if p['id']==pane)['session'],'')
    def test_plain_agent_detection_and_terminal_attention_without_hooks(self):
        pane=self.ordinary_agent('codex')
        self.until(lambda:self.panes()[0]['state']=='idle')
        self.assertEqual(self.panes()[0]['session'],'')
        for command,state in [('work','working'),('block','blocked'),('stop','idle')]:
            self.command('pane.input', target=pane, data=(command) + '\r')
            self.until(lambda:self.panes()[0]['state']==state)
        self.command('pane.input', target=pane, data=('exit') + '\r')
        self.until(lambda:self.panes()[0]['provider']=='other')
    def test_codex_fallback_tool_icon_without_hooks(self):
        pane=self.ordinary_agent('codex')
        self.until(lambda:self.panes()[0]['state']=='idle')
        self.attach()
        for command,icon in [('work','thinking'),('tool','🔧'),('work','thinking'),('tool','🔧')]:
            self.command('pane.input', target=pane, data=(command) + '\r')
            self.agent_frame('codex','●',activity=icon)
        self.command('pane.input', target=pane, data=('stop') + '\r')
        self.agent_frame('codex','○',activity='')
    def test_agent_startup_has_its_own_indicator_and_never_thinks(self):
        pane=self.ordinary_agent('codex',initializing=True)
        self.attach()
        screen=self.agent_frame('codex','●',color='160;146;184')
        self.assertIn('Starting session',screen[14])
        # Longer than the fallback's debounce: loading must remain distinct.
        time.sleep(.8)
        self.assertEqual(self.panes()[0]['state'],'initializing')
        self.command('pane.input', target=pane, data=('ready') + '\r')
        self.agent_frame('codex','○',color='166;227;161')
        self.command('pane.input', target=pane, data=('work') + '\r')
        self.agent_frame('codex','●',activity='thinking',color='249;226;175')
    @unittest.skipUnless(shutil.which('bun'),'Bun is not installed')
    def test_bun_agent_detection(self):
        script=pathlib.Path(self.temp.name,'node_modules/@anthropic-ai/claude-code/cli.js')
        script.parent.mkdir(parents=True)
        script.write_text('console.log("\\x1b]2;✳ Bun agent\\x07");setInterval(()=>{},1000);')
        pane=self.open_pane(cwd=self.temp.name, command=shlex.quote(shutil.which('bun'))+' '+shlex.quote(str(script)))['pane']
        self.until(lambda:self.panes()[0]['provider']=='claude')
        self.until(lambda:self.panes()[0]['state']=='idle')
        self.command('pane.close', target=pane)
    def test_native_handshake_retained_approvals_and_event_rotation(self):
        for provider in ('codex','claude'):
            ident=self.rpc(op='native.start',provider=provider,cwd=self.temp.name)['session']
            self.until(lambda:any(s['id']==ident and s['ready'] for s in self.rpc(op='native.list')['sessions']))
            self.rpc(op='native.send',session=ident,message={'id':1,'method':'test/approval'})
            self.until(lambda:any(s['id']==ident and s['pending_requests']==1 for s in self.rpc(op='native.list')['sessions']))
            self.rpc(op='native.send',session=ident,message={'id':2,'method':'test/flood'})
            self.until(lambda:any(s['id']==ident and s['next_seq']>150 for s in self.rpc(op='native.list')['sessions']))
            events=self.rpc(op='native.events',session=ident)
            self.assertLessEqual(len(events['events']),128);self.assertEqual(len(events['pending_requests']),1);self.assertGreater(events['first_seq'],1)
            response={'id':900,'result':{'decision':'decline'}} if provider=='codex' else {'type':'control_response','response':{'subtype':'success','request_id':'permission-1','response':{'behavior':'deny','message':'test'}}}
            self.rpc(op='native.send',session=ident,message=response)
            self.until(lambda:any(s['id']==ident and s['state']=='idle' and s['pending_requests']==0 for s in self.rpc(op='native.list')['sessions']))
            self.rpc(op='native.stop',session=ident)
    def test_native_acknowledgement_refreshes_attached_frame(self):
        self.open_pane(cwd=self.temp.name, command='sleep 30')
        self.attach();self.get_type('frame')
        ident=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        self.rpc(op='native.send',session=ident,message={'id':1,'method':'test/approval'})
        self.frame_with('! 1 needs you')
        self.rpc(op='native.events',session=ident)
        frame=self.get_type('frame')
        self.assertIn('! 0 needs you',frame['data'])
        self.assertEqual(self.rpc(op='native.list')['sessions'][0]['pending_requests'],1)
    def test_native_codex_discovers_path_without_override(self):
        self.run_cli('shutdown')
        self.until(lambda:not os.path.exists(self.path))
        bin_dir=pathlib.Path(self.temp.name,'auto-bin');bin_dir.mkdir()
        binary=bin_dir/'codex'
        binary.write_text(FAKE.replace('#!/usr/bin/env python3',f'#!{sys.executable}',1));binary.chmod(0o700)
        self.env.pop('CORGI_CODEX_BIN')
        self.env['PATH']=str(bin_dir)+os.pathsep+self.env.get('PATH','')
        ident=json.loads(self.run_cli('native','start','codex'))['session']
        self.until(lambda:any(s['id']==ident and s['ready'] for s in self.rpc(op='native.list')['sessions']))
        events=self.rpc(op='native.events',session=ident)['events']
        self.assertTrue(any(json.loads(e['line']).get('result',{}).get('version')=='fixture' for e in events))
    def test_real_client_restores_terminal_on_detach(self):
        self.env.pop('CORGI_CURSOR_BLINK',None)
        self.check_real_client_exit(b'\x02q',1)
    def test_real_client_can_keep_host_cursor_blink(self):
        self.env['CORGI_CURSOR_BLINK']='1'
        self.check_real_client_exit(b'\x02q',1)
    def test_real_client_steady_cursor_still_honors_hidden_cursor(self):
        self.env.pop('CORGI_CURSOR_BLINK',None)
        pane=self.open_pane(command="printf '\\033[?25lCURSOR_HIDDEN'; sleep 30")['pane']
        self.until(lambda:'CURSOR_HIDDEN' in self.command('pane.read', target=int(str(pane)), view='screen')['text'])
        output=self.check_real_client_exit(b'\x02q',1)
        frames=re.findall(rb'\x1b\[\?2026h(.*?)\x1b\[\?2026l',output,re.S)
        self.assertTrue(frames)
        self.assertTrue(all(b'\x1b[?25h' not in frame for frame in frames))
    def test_real_client_inherits_host_theme_and_answers_child_color_queries(self):
        self.master,slave=os.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
        self.proc=subprocess.Popen([EXE],env=self.env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)
        collected=bytearray()
        def output_until(marker):
            end=time.monotonic()+4
            while marker not in collected and time.monotonic()<end:
                if select.select([self.master],[],[],.05)[0]:collected.extend(os.read(self.master,65536))
            self.assertIn(marker,collected)
        output_until(b'\x1b]11;?')
        # Fragment responses, mix BEL/ST terminators, and include early typing.
        os.write(self.master,b'printf EARLY_INPUT_OK\r\x1b]10;rgb:dddd/')
        os.write(self.master,b'dddd/dddd\x1b\\\x1b]11;rgb:1e/1e/1e\x07')
        for i in range(16):os.write(self.master,f'\x1b]4;{i};rgb:11/cc/33\x1b\\'.encode())
        output_until(b'EARLY_INPUT_OK');output_until(b'48;2;30;30;30m')
        self.assertNotIn(b'rgb:',self.command('pane.read', target=int('1'), view='screen')['text'].encode())
        probe=pathlib.Path(self.temp.name,'color_probe.py')
        result=pathlib.Path(self.temp.name,'colors.json')
        probe.write_text('''import os,select,time,tty,json,sys
tty.setraw(0)
os.write(1,b'\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x1b\\\\\\x1b]4;2;?\\x1b\\\\')
data=b'';end=time.monotonic()+2
while time.monotonic()<end and data.count(b'\\x1b\\\\')<3:
    if select.select([0],[],[],.05)[0]:data+=os.read(0,1024)
open(sys.argv[1],'w').write(json.dumps(data.decode()))
os.write(1,b'\\x1b[48;2;57;57;57m COMPOSER \\x1b[0m')
while True:time.sleep(1)
''')
        ident=self.open_pane(cwd=self.temp.name, command=shlex.join([sys.executable,str(probe),str(result)]))['pane']
        self.until(result.exists)
        replies=json.loads(result.read_text())
        self.assertIn('\x1b]10;rgb:dddd/dddd/dddd\x1b\\',replies)
        self.assertIn('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\',replies)
        self.assertIn('\x1b]4;2;rgb:1111/cccc/3333\x1b\\',replies)
        output_until(b'48;2;57;57;57m COMPOSER ')
        # A late reply updates existing panes and is not forwarded as input.
        os.write(self.master,b'\x1b]11;rgb:22/22/22\x07')
        output_until(b'48;2;34;34;34m')
        self.command('pane.close', target=ident)
        os.write(self.master,b'\x02q')
        end=time.monotonic()+3
        while self.proc.poll() is None and time.monotonic()<end:
            if select.select([self.master],[],[],.05)[0]:
                try:os.read(self.master,65536)
                except OSError:break
        self.proc.wait(timeout=1)
        self.assertEqual(self.proc.returncode,0)
    def test_real_client_returns_to_terminal_on_last_shell_exit(self):
        self.check_real_client_exit(b'exit\r',0)
        self.assertEqual(self.session()['closed_panes'],1)
    def test_real_client_returns_to_terminal_on_last_tab_close(self):
        self.open_pane(cwd=self.temp.name)
        self.split_pane(cwd=self.temp.name, direction='right')
        ident=self.rpc(op='native.start',provider='codex',cwd=self.temp.name)['session']
        # Input following close must not recreate tabs after detaching.
        self.check_real_client_exit(b'\x02X\x02c\r',0)
        self.assertEqual(self.session()['closed_panes'],2)
        self.assertEqual(self.rpc(op='native.list')['sessions'][0]['id'],ident)
    def check_real_client_exit(self,keys,remaining_panes):
        self.master,slave=os.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
        before=termios.tcgetattr(slave)
        self.proc=subprocess.Popen([EXE],env=self.env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        collected=bytearray();end=time.monotonic()+4
        while time.monotonic()<end:
            ready,_,_=select.select([self.master],[],[],.1)
            if ready:collected.extend(os.read(self.master,65536))
            if b'corgi' in collected:break
        self.assertIn(b'corgi',collected)
        os.write(self.master,keys)
        end=time.monotonic()+4
        while self.proc.poll() is None and time.monotonic()<end:
            ready,_,_=select.select([self.master],[],[],.1)
            if ready: collected.extend(os.read(self.master,65536))
        self.proc.wait(timeout=1)
        self.assertEqual(self.proc.returncode,0)
        while select.select([self.master],[],[],0)[0]:collected.extend(os.read(self.master,65536))
        self.assertIn(b'\x1b[>1u',collected)
        self.assertIn(b'\x1b[<u',collected)
        self.assertLess(collected.index(b'\x1b[<u'),collected.index(b'\x1b[?1049l'))
        self.assertIn(b'\x1b[?1049l',collected)
        if self.env.get('CORGI_CURSOR_BLINK')=='1':
            for mode in (b'\x1b[?12s',b'\x1b[?12l',b'\x1b[?12r'):
                self.assertNotIn(mode,collected)
        else:
            self.assertEqual(collected.count(b'\x1b[?12s\x1b[?12l'),1)
            self.assertLess(collected.index(b'\x1b[?12l'),collected.index(b'\x1b[?2026h'))
            self.assertEqual(collected.count(b'\x1b[?12r'),1)
            self.assertLess(collected.index(b'\x1b[?1049l'),collected.index(b'\x1b[?12r'))
        self.assertEqual(termios.tcgetattr(slave),before)
        os.close(slave)
        self.assertEqual(len(self.panes()),remaining_panes)
        return collected

class Discovery(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='corgi-discovery-')
        self.root=pathlib.Path(self.temp.name)
        self.env={**os.environ,'HOME':str(self.root),'PATH':''}
        self.env.pop('CORGI_CODEX_BIN',None)
    def tearDown(self):self.temp.cleanup()
    def script(self,relative,body):
        path=self.root/relative;path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text('#!/bin/sh\n'+body+'\n');path.chmod(0o700)
        return path
    def which(self):
        p=subprocess.run([EXE,'which','codex'],env=self.env,text=True,capture_output=True,timeout=5,cwd=self.root)
        self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(p.stderr,'')
        return p.stdout.strip()
    def test_skip_broken_and_false_positive_path_entries(self):
        broken=self.script('broken/codex','echo "missing native package" >&2; exit 1')
        unrelated=self.script('unrelated/codex','echo "another tool 1.0"')
        valid=self.script('valid/codex','echo "codex-cli 1.2.3"')
        self.env['PATH']=os.pathsep.join(str(p.parent) for p in (broken,unrelated,valid))
        self.assertEqual(self.which(),str(valid))
        # The interactive launcher must select the same binary, not the broken PATH entry.
        p=subprocess.run([EXE,'agent','codex','--version'],env={**self.env,'CORGI_PANE':'1'},text=True,capture_output=True,timeout=5)
        self.assertEqual((p.returncode,p.stdout.strip()),(0,'codex-cli 1.2.3'))
    def test_skip_hanging_candidate(self):
        hung=self.script('hung/codex','/bin/sleep 30')
        valid=self.script('valid/codex','echo "codex-cli 1.2.3"')
        self.env['PATH']=os.pathsep.join(str(p.parent) for p in (hung,valid))
        self.assertEqual(self.which(),str(valid))
    def test_preserve_symlink_shim_invocation(self):
        shim=self.script('shared/shim','case "$0" in */codex) echo "codex-cli 1.2.3";; *) exit 1;; esac')
        link=self.root/'bin/codex';link.parent.mkdir();link.symlink_to(shim)
        self.env['PATH']=str(link.parent)
        self.assertEqual(self.which(),str(link))
    def test_relative_path_resolves_to_absolute_executable(self):
        valid=self.script('relative/codex','echo "codex-cli 1.2.3"')
        self.env['PATH']='relative'
        found=pathlib.Path(self.which())
        self.assertTrue(found.is_absolute());self.assertTrue(found.samefile(valid))
    def test_user_install_fallback(self):
        valid=self.script('.local/bin/codex','echo "codex-cli 1.2.3"')
        self.assertEqual(self.which(),str(valid))
    @unittest.skipUnless(sys.platform=='darwin','macOS app bundles')
    def test_renamed_user_app_bundle_fallback(self):
        valid=self.script('Applications/Codex Beta.app/Contents/Resources/codex','echo "codex-cli 1.2.3"')
        self.assertEqual(self.which(),str(valid))
    def test_explicit_override_is_preserved(self):
        self.env['CORGI_CODEX_BIN']='/custom/provider'
        self.assertEqual(self.which(),'/custom/provider')

if __name__=='__main__': unittest.main(verbosity=2)
