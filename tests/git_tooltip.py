#!/usr/bin/env python3
"""Unpushed commit metadata and hover behavior through a real daemon/viewer."""
import pathlib, re, subprocess, time, unittest
import smoke, viewers
from viewers import Viewer

class GitTooltip(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    raw_rpc = smoke.Runtime.raw_rpc
    session = smoke.Runtime.session
    until = smoke.Runtime.until
    new = viewers.Viewers.new
    def setUp(self):
        self.viewers = []
        smoke.Runtime.setUp(self)
        for key in ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CORGI_PANE'):
            self.env.pop(key, None)
    def tearDown(self):
        for viewer in self.viewers: viewer.close()
        smoke.Runtime.tearDown(self)
    def git(self, *args):
        return subprocess.check_output(['git', '-C', self.temp.name, *args], stderr=subprocess.DEVNULL).decode().strip()
    def test_hover_metadata_is_local_and_refreshes_after_push(self):
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Corgi Author')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base')
        self.git('branch', 'upstream')
        self.git('branch', '--set-upstream-to=upstream')
        for i in range(14):
            self.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', f'Change {i:02d} — tooltip metadata')
        self.new()
        self.until(lambda: self.session()['workspaces'][0]['git_ahead'] == 14)
        a, b = Viewer(self), Viewer(self)
        a.input('\x1b[<35;25;3M')
        self.assertNotIn('14 unpushed commits', a.state['data'])
        time.sleep(.6)
        frame = a.poll()['data']
        self.assertIn('14 unpushed commits', frame)
        self.assertIn('Change 13 — tooltip metadata', frame)
        self.assertIn('Corgi Author', frame)
        self.assertIn('+2 more', frame)
        self.assertIn('just now', frame)
        self.assertRegex(frame, r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}')
        self.assertNotIn('Newest first', frame)
        self.assertNotIn('newest first', frame)
        self.assertNotIn('compared with upstream', frame)
        self.assertNotIn('14 unpushed commits', b.poll()['data'])
        # Keep a rendered frame for visual inspection, without terminal control sequences.
        clean = re.sub(r'\x1b\]8;[^\x1b]*\x1b\\', '', frame).replace('\x1b7', '').replace('\x1b8', '')
        pathlib.Path('/tmp/corgi-git-tooltip-screen.txt').write_text('\n'.join(smoke.screen_text(clean, 120, 40)))
        a.input('\x1b[<35;5;3M')
        self.assertNotIn('14 unpushed commits', a.state['data'])
        a.input('\x1b[<35;25;3M')
        time.sleep(.6)
        self.assertIn('14 unpushed commits', a.poll()['data'])
        a.input('x')
        self.assertNotIn('14 unpushed commits', a.state['data'])
        self.git('branch', '-f', 'upstream', 'HEAD')
        self.until(lambda: self.session()['workspaces'][0]['git_ahead'] == 0)
        a.input('\x1b[<35;24;3M')
        time.sleep(.6)
        self.assertNotIn('unpushed commits', a.poll()['data'])
        self.assertEqual(self.session()['workspaces'][0]['git_commits'], [])

if __name__ == '__main__': unittest.main()
