"""Mouse copy feedback and stable selection during new output."""
import base64, pathlib, shlex, sys, time, unittest
from viewers import Viewers, Viewer

class Selection(Viewers):
    def test_agent_drag_copies_when_application_enables_mouse(self):
        fixture=pathlib.Path(self.temp.name,'mouse.py')
        capture=pathlib.Path(self.temp.name,'mouse.bin')
        fixture.write_text("import os,sys,tty\ntty.setraw(0)\nos.write(1,b'\\x1b[?1002h\\x1b[?1006hSELECT_ME')\nwith open(sys.argv[1],'wb',buffering=0) as f:\n while True:f.write(os.read(0,4096))\n")
        pane=self.new(shlex.join([sys.executable,str(fixture),str(capture)]))
        self.until(lambda:'SELECT_ME' in self.command('pane.read',target=pane,view='screen')['text'])
        self.mark_agent(pane,'Mouse agent')
        viewer=Viewer(self);viewer.focus(pane)
        # Separate frames match a real drag, with mouse reporting enabled.
        viewer.input('\x1b[<0;29;2M')
        viewer.input('\x1b[<32;37;2M')
        viewer.input('\x1b[<0;37;2m')
        effects=viewer.state['effects']
        self.assertTrue(effects,'agent drag did not copy')
        encoded=effects[0]['write_terminal'].split('52;c;',1)[1].split('\x07',1)[0]
        self.assertEqual(base64.b64decode(encoded).decode(),'SELECT_ME')
        self.assertIn('Copied to clipboard',viewer.state['data'])
        # Selection must not leak an unmatched press into the agent.
        self.assertEqual(capture.read_bytes(),b'')
        viewer.input('\x1b[<64;29;2M')
        self.until(lambda:b'\x1b[<64;1;1M' in capture.read_bytes())
        # Alt-click remains available for the application's own controls.
        viewer.input('\x1b[<8;29;2M\x1b[<8;29;2m')
        self.until(lambda:b'\x1b[<8;1;1m' in capture.read_bytes())

    def test_drag_freezes_text_and_release_copies_then_resumes(self):
        pane=self.new("printf 'SELECT_ME\\n'; exec /bin/sh")
        self.until(lambda:'SELECT_ME' in self.command('pane.read', target=pane, view='screen')['text'])
        a=Viewer(self);b=Viewer(self);a.focus(pane);b.focus(pane)
        a.input('\x1b[<0;29;2M\x1b[<32;37;2M')
        held=a.state['data']
        self.command('pane.input', data="printf 'NEW_OUTPUT\\n'\n", target=pane)
        self.until(lambda:'NEW_OUTPUT' in self.command('pane.read', target=pane, view='screen')['text'])
        self.assertEqual(a.poll()['data'],held)
        self.assertIn('NEW_OUTPUT',b.poll()['data'])
        # Release over the sidebar still copies the captured pane.
        a.input('\x1b[<0;1;3m')
        effect=a.state['effects'][0]['write_terminal']
        encoded=effect.split('52;c;',1)[1].split('\x07',1)[0]
        self.assertEqual(base64.b64decode(encoded).decode(),'SELECT_ME')
        self.assertIn('Copied to clipboard',a.state['data'])
        self.assertIn('NEW_OUTPUT',a.state['data'])
        self.assertNotIn('Copied to clipboard',b.poll()['data'])
        time.sleep(2.1)
        self.assertEqual(a.poll()['data'],b.poll()['data'])

if __name__=='__main__':unittest.main()
