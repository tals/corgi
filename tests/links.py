#!/usr/bin/env python3
"""Named-link transport and a real attached client's local URL opener."""
import fcntl, os, pathlib, re, select, shlex, struct, subprocess, sys, termios, time, unittest
import smoke, viewers
from viewers import Viewer

class Links(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    command=smoke.Runtime.command
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
        output = f'\x1b]8;id=docs;{url}\x1b\\\x1b[4mNamed docs\x1b]8;;\x1b\\\x1b[0m ordinary\r\n'
        pane = self.new('printf %s '+shlex.quote(output)+'; exec /bin/sh')
        self.until(lambda:'Named docs' in self.command('pane.read', target=pane, view='screen')['text'])
        surface = self.rpc(op='pane.surface',protocol=1,pane=pane)['surface']
        self.assertIn(';'+url+'\x1b\\', ''.join(surface['lines']))
        viewer = Viewer(self)
        self.assertIn(';'+url+'\x1b\\', viewer.poll()['data'])
        rows = smoke.screen_text(viewer.state['data'], 100, 30)
        y = next(i for i, row in enumerate(rows) if 'Named docs' in row)
        x = rows[y].index('Named docs')
        self.assertIn('\x1b]22;pointer\x1b\\', viewer.input(f'\x1b[<35;{x+1};{y+1}M')['data'])
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
        self.until(lambda:url in self.command('pane.read', target=pane, view='screen')['text'])
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
        self.assertIn('\x1b]22;pointer\x1b\\',viewer.state['data'])
        self.assertIn('\x1b]22;default\x1b\\',other.poll()['data'])
        self.assertIn('\x1b[4m',viewer.state['data'])
        self.assertNotIn('\x1b[4m',other.poll()['data'])
        mouse(51)
        self.assertIn('\x1b[4m',viewer.state['data'])
        mouse(35,len(url)+2)
        self.assertIn('\x1b]22;default\x1b\\',viewer.state['data'])
        self.assertNotIn('\x1b[4m',viewer.state['data'])
        mouse(0);mouse(32,5)
        # First motion must survive the viewer's following snapshot refresh.
        self.assertIn('38;2;0;0;0;48;2;255;255;255m',viewer.state['data'])
        mouse(0,5,True)
        self.assertFalse(any('open_url' in effect for effect in viewer.state['effects']))
        # Dragging off and back onto the pressed cell still selects.
        mouse(0);mouse(32,5);mouse(32);mouse(0,release=True)
        self.assertFalse(any('open_url' in effect for effect in viewer.state['effects']))
        # A selection that starts off the link and ends on it must not open.
        mouse(0,len(url)+2);mouse(32,len(url)+1);mouse(32,3);mouse(0,3,True)
        self.assertFalse(any('open_url' in effect for effect in viewer.state['effects']))
        mouse(0);mouse(0,release=True)
        self.assertEqual(viewer.state['effects'], [{'open_url':url}])
        mouse(16);mouse(16,release=True)
        self.assertEqual(viewer.state['effects'], [{'open_url':url}])
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
        os.write(self.master,b'\x1b[<35;30;2M')
        def tooltip_ready():
            nonlocal received
            if select.select([self.master],[],[],.05)[0]: received += os.read(self.master,65536)
            return b'Click to open' in received
        self.until(tooltip_ready)
        os.write(self.master,b'\x1b[<16;30;2M\x1b[<16;30;2m')
        def opened_and_drain():
            if select.select([self.master],[],[],.05)[0]: os.read(self.master,65536)
            return opened.exists()
        self.until(opened_and_drain)
        self.assertEqual(opened.read_text(),url)

    def test_tooltip_waits_and_stays_hidden_through_interaction(self):
        url='https://example.com/tooltip'
        pane=self.new('printf %s '+shlex.quote(url+'\r\n')+'; exec /bin/sh')
        self.until(lambda:url in self.command('pane.read', target=pane, view='screen')['text'])
        viewer=Viewer(self)
        other=Viewer(self)
        hint='Click to open'
        def move(x=30): return viewer.input(f'\x1b[<35;{x};2M')
        def absent(): self.assertNotIn(hint,viewer.poll()['data'])
        def appears(): self.until(lambda:hint in viewer.poll()['data'])
        move()
        absent()
        appears()
        self.assertNotIn(hint,other.poll()['data'])
        viewer.input('\x1b[<0;30;2M')
        absent()
        viewer.input('\x1b[<32;35;2M')
        time.sleep(.55)
        absent()
        viewer.input('\x1b[<0;35;2m')
        time.sleep(.55)
        absent()
        move(34)
        absent()
        appears()
        viewer.input('x')
        absent()
        time.sleep(.55)
        absent()
        move(33)
        appears()
        viewer.input('\x1b[<65;33;2M')
        absent()
        time.sleep(.55)
        absent()
        move(32)
        appears()
        viewer.input('\x1b[O')
        absent()
        viewer.input('\x1b[I')
        time.sleep(.55)
        absent()
        move(31)
        appears()
        move(75)
        absent()

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
            frames=re.findall(rb'\x1b\[\?2026h(.*?)\x1b\[\?2026l',received,re.S)
            if not frames:return None
            rows=smoke.screen_text(frames[-1].decode(),80,24)
            for y,row in enumerate(rows):
                if 'Open Link' in row:return row.index('Open Link')+2,y+1
        x,y=self.until(frame,timeout=8)
        os.write(self.master,f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m'.encode())
        def did_open():
            if select.select([self.master],[],[],.05)[0]:os.read(self.master,65536)
            return opened.exists()
        self.until(did_open)
        self.assertEqual(opened.read_text(),f'http://localhost:{port}')

if __name__=='__main__': unittest.main()
