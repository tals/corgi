"""Import real tmux windows through the wizard, with isolated source and Corgi runtimes.

Requires tmux and a Corgi build with -Dviewer-test-driver=true.
Set CORGI_TEST_BIN to use an isolated build.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

from viewer_client import Viewer, EXE
from smoke import screen_text

TMUX = shutil.which('tmux')


@unittest.skipUnless(TMUX, 'tmux is required')
class TmuxImport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='corgi-tmux-', dir='/tmp')
        self.root = Path(self.temp.name)
        self.viewers = []
        self.proc = None
        self.addCleanup(self.temp.cleanup)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(
            ('CORGI_', 'CMUX_', 'HERDR_', 'CODEX_', 'CLAUDE_', 'XDG_', 'GHOSTTY_', 'TMUX', 'ENV', 'BASH_ENV', 'ZDOTDIR'))}
        for name in ('home', 'config', 'state', 'bin', 'left', 'top', 'bottom'):
            (self.root / name).mkdir()
        (self.root / 'bin/tmux').symlink_to(TMUX)
        self.path = str(self.root / 'control.sock')
        self.env.update({
            'HOME': str(self.root / 'home'), 'XDG_CONFIG_HOME': str(self.root / 'config'),
            'XDG_STATE_HOME': str(self.root / 'state'), 'CORGI_SOCKET': self.path,
            'CODEX_HOME': str(self.root / 'home/.codex'), 'CLAUDE_CONFIG_DIR': str(self.root / 'home/.claude'),
            'CORGI_INFERENCE_PROVIDER': 'off', 'CORGI_SUMMARY_COMMAND': 'off', 'CORGI_BELL': 'off',
            'CORGI_CODEX_BIN': '/usr/bin/false', 'CORGI_CLAUDE_BIN': '/usr/bin/false',
            'SHELL': '/bin/sh', 'PATH': str(self.root / 'bin') + ':/usr/bin:/bin',
            'TMUX_TMPDIR': str(self.root),
        })
        self.tmux_base = [TMUX, '-S', str(self.root / 'tmux.sock'), '-f', '/dev/null']
        self.addCleanup(lambda: subprocess.run(self.tmux_base + ['kill-server'], env=self.env,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        self.tmux('new-session', '-d', '-s', 'tmux-fixture', '-n', 'nested', '-x', '120', '-y', '40',
                  '-c', str(self.root / 'left'), '/bin/sleep 120')
        self.left = self.tmux('display-message', '-p', '-t', 'tmux-fixture:0', '#{pane_id}')
        self.top = self.tmux('split-window', '-h', '-d', '-l', '60', '-P', '-F', '#{pane_id}',
                             '-t', self.left, '-c', str(self.root / 'top'), '/bin/sleep 120')
        self.bottom = self.tmux('split-window', '-v', '-d', '-l', '20', '-P', '-F', '#{pane_id}',
                                '-t', self.top, '-c', str(self.root / 'bottom'), '/bin/sleep 120')
        self.saved_layout = self.tmux('display-message', '-p', '-t', 'tmux-fixture:0', '#{window_layout}')
        self.env['TMUX'] = str(self.root / 'tmux.sock') + ',0,0'
        self.log = (self.root / 'daemon.log').open('w+')
        self.addCleanup(self.cleanup_corgi)
        self.proc = subprocess.Popen([EXE, 'serve'], env=self.env, cwd=self.root,
                                     stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        self.until(lambda: self.rpc(op='ping'))

    def tmux(self, *args):
        return subprocess.check_output(self.tmux_base + list(args), env=self.env, text=True).strip()

    def cleanup_corgi(self):
        for viewer in self.viewers:
            viewer.close()
        if self.proc:
            try:
                self.rpc(op='shutdown')
            except (OSError, ValueError, AssertionError):
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.log.seek(0)
        log = self.log.read()
        self.log.close()
        self.assertNotIn('panic:', log)

    def rpc(self, **message):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3)
            client.connect(self.path)
            client.sendall(json.dumps({'protocol': 1, **message}).encode() + b'\n')
            with client.makefile('rb') as stream:
                result = json.loads(stream.readline())
        self.assertNotIn('err', result, result)
        return result

    def until(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = predicate()
                if result:
                    return result
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            time.sleep(.02)
        self.fail('condition timed out')

    def check_import(self, zoomed_pane=None):
        if zoomed_pane:
            self.tmux('resize-pane', '-Z', '-t', zoomed_pane)
        before = self.tmux('list-panes', '-t', 'tmux-fixture:0', '-F',
                           '#{pane_id} #{pane_pid} #{pane_left} #{pane_top} #{pane_width} #{pane_height}')
        v = Viewer(self, 100, 34)
        v.input('\r')
        v.input('1')
        def text():
            return '\n'.join(screen_text(v.poll()['data'], 100, 34))
        self.until(lambda: 'tmux-fixture' in text())
        v.input(' \r')
        self.until(lambda: "You're ready to go" in text())
        snapshot = self.rpc(op='session.snapshot')
        ws = next(w for w in snapshot['workspaces'] if w['name'] == 'tmux-fixture')
        self.assertEqual(len(ws['model']['tabs']), 1)
        tab = ws['model']['tabs'][0]
        self.assertEqual(tab['title'], 'nested')
        panes = {p['id']: p for p in snapshot['panes'] if p['workspace'] == ws['id']}
        self.assertEqual(len(panes), 3)
        self.assertTrue(all(p['pid'] > 0 for p in panes.values()))
        def shape(index):
            node = ws['model']['nodes'][index]
            if 'pane' in node:
                return Path(panes[node['pane']]['cwd']).name
            split = node['split']
            return (split['axis'], split['ratio'], shape(split['first']), shape(split['second']))
        self.assertEqual(shape(tab['root']), ('horizontal', 500, 'left', ('vertical', 500, 'top', 'bottom')))
        self.assertEqual(self.tmux('display-message', '-p', '-t', 'tmux-fixture:0', '#{window_zoomed_flag}'),
                         '1' if zoomed_pane else '0')
        self.assertEqual(self.tmux('display-message', '-p', '-t', 'tmux-fixture:0', '#{window_layout}'),
                         self.saved_layout)
        self.assertEqual(self.tmux('list-panes', '-t', 'tmux-fixture:0', '-F',
                                  '#{pane_id} #{pane_pid} #{pane_left} #{pane_top} #{pane_width} #{pane_height}'), before)

    def test_unzoomed_window(self):
        self.check_import()

    def test_zoomed_first_pane_imports_all_splits_without_changing_source(self):
        self.check_import(self.left)

    def test_zoomed_nested_pane_imports_all_splits_without_changing_source(self):
        self.check_import(self.bottom)


if __name__ == '__main__':
    unittest.main()
