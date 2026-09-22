#!/usr/bin/env python3
"""Named-link transport and a real attached client's local URL opener."""
import fcntl, json, os, pathlib, select, shlex, struct, subprocess, sys, termios, time, unittest
import smoke, viewers
from viewers import Viewer

class Links(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    raw_rpc = smoke.Runtime.raw_rpc
    session = smoke.Runtime.session
    until = smoke.Runtime.until
    new = viewers.Viewers.new
    def setUp(self):
        self.viewers=[]
        smoke.Runtime.setUp(self)
        for key in ('SSH_CONNECTION','SSH_CLIENT','SSH_TTY','CORGI_PANE'):
            self.env.pop(key, None)
    def tearDown(self):
        for viewer in self.viewers: viewer.close()
        smoke.Runtime.tearDown(self)
    def test_named_link_survives_real_server_and_viewer(self):
        url = 'https://example.com/corgi-link-test'
        output = f'\x1b]8;id=docs;{url}\x1b\\\x1b[4mNamed docs\x1b]8;;\x1b\\\x1b[0m ordinary'
        pane = self.new('printf %s '+shlex.quote(output)+'; exec /bin/sh')
        self.until(lambda:'Named docs' in self.rpc(op='read',pane=pane)['text'])
        surface = self.rpc(op='pane.surface',protocol=1,pane=pane)['surface']
        self.assertIn(';'+url+'\x1b\\', ''.join(surface['lines']))
        viewer = Viewer(self)
        self.assertIn(';'+url+'\x1b\\', viewer.poll()['data'])
    def test_plain_terminal_link_click_and_drag(self):
        root=pathlib.Path(self.temp.name)
        opened=root/'opened'
        bindir=root/'bin'; bindir.mkdir()
        executable=bindir/('open' if sys.platform=='darwin' else 'xdg-open')
        executable.write_text('#!/bin/sh\nprintf "%s" "$1" > '+shlex.quote(str(opened))+'\n')
        executable.chmod(0o700)
        self.env['PATH']=str(bindir)+os.pathsep+self.env['PATH']
        url='https://example.com/plain'
        pane=self.new('printf %s '+shlex.quote(url+'\r\n')+'; exec /bin/sh')
        self.until(lambda:url in self.rpc(op='read',pane=pane)['text'])
        viewer=Viewer(self)
        other=Viewer(self)
        frame=viewer.poll()['data']
        self.assertIn(';'+url+'\x1b\\', frame)
        # Locate the actual rendered URL after removing OSC metadata.
        import re
        frame=re.sub(r'\x1b\]8;[^\x1b]*\x1b\\', '', frame)
        rows=smoke.screen_text(frame,120,40)
        y=next(i for i,row in enumerate(rows) if url in row)
        x=rows[y].index(url)
        def mouse(code,dx=0,release=False):
            viewer.input(f'\x1b[<{code};{x+dx+1};{y+1}'+('m' if release else 'M'))
        self.assertIn('\x1b[?1003h',viewer.state['data'])
        mouse(35)
        self.assertIn('\x1b[4m',viewer.state['data'])
        self.assertNotIn('\x1b[4m',other.poll()['data'])
        mouse(51)
        self.assertIn('\x1b[4m',viewer.state['data'])
        mouse(35,len(url)+2)
        self.assertNotIn('\x1b[4m',viewer.state['data'])
        mouse(0);mouse(0,release=True)
        self.assertNotIn('open_url',viewer.state['effects'])
        mouse(0);mouse(32,5)
        # First motion must survive the viewer's following snapshot refresh.
        self.assertIn('38;2;0;0;0;48;2;255;255;255m',viewer.state['data'])
        mouse(0,5,True)
        self.assertNotIn('open_url', viewer.state['effects'])
        mouse(16);mouse(16,release=True)
        effects=[json.loads(line) for line in viewer.state['effects'].splitlines()]
        self.assertIn({'type':'open_url','url':url},effects)
        viewer.close()
        other.close()
        self.master,slave=os.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
        self.proc=subprocess.Popen([smoke.EXE,'attach'],env=self.env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)
        received=b''
        def frame_ready():
            nonlocal received
            if select.select([self.master],[],[],.05)[0]: received += os.read(self.master,65536)
            return (';'+url+'\x1b\\').encode() in received
        self.until(frame_ready)
        os.write(self.master,b'\x1b[<16;30;2M\x1b[<16;30;2m')
        def opened_and_drain():
            if select.select([self.master],[],[],.05)[0]: os.read(self.master,65536)
            return opened.exists()
        self.until(opened_and_drain)
        self.assertEqual(opened.read_text(),url)

    def test_plain_port_click_invokes_system_opener_in_attached_client(self):
        root=pathlib.Path(self.temp.name)
        ready=root/'port'; opened=root/'opened'
        fixture=root/'serve_fixture.py'
        fixture.write_text("import http.server, pathlib, sys\ns=http.server.HTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler)\npathlib.Path(sys.argv[1]).write_text(str(s.server_port))\ns.serve_forever()\n")
        self.new('exec '+shlex.join([sys.executable,str(fixture),str(ready)]))
        self.until(ready.exists)
        port=int(ready.read_text())
        self.until(lambda:any(e['port']==port and e['scheme']=='http' for w in self.session()['ports']['workspaces'] for e in w['endpoints']),timeout=20)
        # Stub only the OS opener. Exercise the real attach loop and mouse parser.
        bindir=root/'bin'; bindir.mkdir()
        executable=bindir/('open' if sys.platform=='darwin' else 'xdg-open')
        executable.write_text('#!/bin/sh\nprintf "%s" "$1" > '+shlex.quote(str(opened))+'\n')
        executable.chmod(0o700)
        self.env['PATH']=str(bindir)+os.pathsep+self.env['PATH']
        self.master,slave=os.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
        self.proc=subprocess.Popen([smoke.EXE,'attach'],env=self.env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)
        received=b''
        def frame():
            nonlocal received
            if select.select([self.master],[],[],.05)[0]: received += os.read(self.master,65536)
            return f';http://localhost:{port}\x1b\\'.encode() in received
        self.until(frame,timeout=8)
        os.write(self.master,b'\x1b[<0;7;5M\x1b[<0;7;5m')
        self.until(opened.exists)
        self.assertEqual(opened.read_text(),f'http://localhost:{port}')

if __name__=='__main__': unittest.main()
