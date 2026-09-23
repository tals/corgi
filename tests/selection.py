"""Mouse copy feedback and stable selection during new output."""
import base64, time, unittest
from viewers import Viewers, Viewer

class Selection(Viewers):
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
