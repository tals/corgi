"""cmux discovery -> real viewer -> daemon import, using a read-only CLI fixture.

Build with -Dviewer-test-driver=true, then run with CORGI_TEST_BIN=/path/to/corgi.
All homes, source data and runtimes belong to a disposable directory.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from viewer_client import Viewer, EXE
from smoke import screen_text

ROOT = Path(__file__).resolve().parents[1]
CLI = r'''
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['CMUX_TEST_LOG'], 'a') as f:
    f.write(json.dumps(args) + '\n')
mode = os.environ['CMUX_TEST_MODE']
if mode == 'hang':
    os.close(1)
    time.sleep(60)
    sys.exit(0)
if mode == 'unreadable':
    print('{new-format: ???')
    sys.exit(0)
if mode == 'old':
    if '--id-format' in args or args[0] == 'tree': sys.exit(1)
    if args[0] == 'list-windows':
        print(json.dumps({'windows': [{'id': 'w1'}, {'id': 'w2'}]}))
    elif args[0] == 'list-workspaces':
        window = args[args.index('--window') + 1]
        print(json.dumps({'workspaces': [{'id': window, 'name': 'Old ' + window, 'cwd': '/tmp'}]}))
    else: sys.exit(1)
elif args[0] == 'tree':
    print(Path(os.environ['CMUX_TEST_FIXTURE']).read_text())
elif args[0] == 'list-panes':
    print('{' + '"panes": []' + '}')
else:
    sys.exit(1)
'''


@unittest.skipUnless(sys.platform == 'darwin', 'cmux is offered only on macOS')
class CmuxImport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='corgi-cmux-', dir='/tmp')
        self.root = Path(self.temp.name)
        self.viewers = []
        self.proc = None
        self.addCleanup(self.cleanup)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(
            ('CORGI_', 'CMUX_', 'HERDR_', 'CODEX_', 'CLAUDE_', 'XDG_', 'GHOSTTY_', 'TMUX', 'ENV', 'BASH_ENV', 'ZDOTDIR'))}
        for name in ('home', 'config', 'state', 'bin'):
            (self.root / name).mkdir()
        self.path = str(self.root / 'control.sock')
        self.env.update({
            'HOME': str(self.root / 'home'), 'XDG_CONFIG_HOME': str(self.root / 'config'),
            'XDG_STATE_HOME': str(self.root / 'state'), 'CORGI_SOCKET': self.path,
            'CODEX_HOME': str(self.root / 'home/.codex'), 'CLAUDE_CONFIG_DIR': str(self.root / 'home/.claude'),
            'CORGI_INFERENCE_PROVIDER': 'off', 'CORGI_SUMMARY_COMMAND': 'off', 'CORGI_BELL': 'off',
            'CORGI_CODEX_BIN': '/usr/bin/false', 'CORGI_CLAUDE_BIN': '/usr/bin/false',
            'SHELL': '/bin/sh', 'PATH': str(self.root / 'bin') + ':/usr/bin:/bin',
            'CMUX_TEST_LOG': str(self.root / 'cmux-commands.jsonl'), 'CMUX_TEST_MODE': 'recent',
            'CMUX_TEST_FIXTURE': str(ROOT / 'src/testdata/cmux-tree.json'),
        })
        cli = self.root / 'bin/cmux'
        cli.write_text('#!' + sys.executable + '\n' + CLI)
        cli.chmod(0o700)
        self.log = (self.root / 'daemon.log').open('w+')
        self.proc = subprocess.Popen([EXE, 'serve'], env=self.env, cwd=self.root,
                                     stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        self.until(lambda: self.rpc(op='ping'))

    def cleanup(self):
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
        self.temp.cleanup()

    def rpc(self, allow_error=False, **message):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3)
            client.connect(self.path)
            client.sendall(json.dumps({'protocol': 1, **message}).encode() + b'\n')
            with client.makefile('rb') as stream:
                result = json.loads(stream.readline())
        if not allow_error:
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

    def wizard(self, mode='recent', cols=100, rows=34):
        self.env['CMUX_TEST_MODE'] = mode
        v = Viewer(self, cols, rows)
        v.input('\r')  # Corgi preset -> imports, without changing host shortcuts.
        v.input('3')
        return v

    def text(self, v, cols=100, rows=34):
        return '\n'.join(screen_text(v.poll()['data'], cols, rows))

    def shape(self, ws, tab, snapshot):
        names = {p['id']: p['name'] for p in snapshot['panes']}
        def visit(index):
            node = ws['model']['nodes'][index]
            if 'pane' in node:
                return names[node['pane']]
            s = node['split']
            return (s['axis'], s['ratio'], visit(s['first']), visit(s['second']))
        return visit(tab['root'])

    def test_layers_partial_recovery_and_real_shells(self):
        v = self.wizard()
        self.until(lambda: 'Workspace only' in self.text(v))
        before = self.text(v)
        self.assertIn("I'm confused by this cmux version.", before)
        self.assertIn('Split layout approximated', before)
        v.input(' j j \r')
        self.until(lambda: "You're ready to go" in self.text(v))
        snapshot = self.rpc(op='session.snapshot')
        by_name = {w['name']: w for w in snapshot['workspaces']}
        project = by_name['cmux project']
        self.assertEqual([self.shape(project, t, snapshot) for t in project['model']['tabs']], [
            ('horizontal', 600, 'Editor', 'Server'), ('horizontal', 600, 'Build', 'Logs'), 'Docs'])
        research = by_name['research']
        self.assertEqual(len(research['model']['tabs']), 1)
        self.assertEqual(Path(research['cwd']).resolve(), (self.root / 'home').resolve())
        imported = {w['id'] for name, w in by_name.items() if name in ('cmux project', 'layoutless', 'research')}
        panes = [p for p in snapshot['panes'] if p['workspace'] in imported]
        self.assertEqual(len(panes), 8)
        self.assertTrue(all(p['pid'] > 0 for p in panes))
        commands = [json.loads(line)[0] for line in Path(self.env['CMUX_TEST_LOG']).read_text().splitlines()]
        self.assertTrue(set(commands) <= {'tree', 'list-panes'})

    def test_old_cli_recovers_workspaces_across_windows(self):
        v = self.wizard('old')
        self.until(lambda: 'Old w2' in self.text(v))
        self.assertIn('Workspace only', self.text(v))
        v.input(' j \r')
        self.until(lambda: "You're ready to go" in self.text(v))
        ws = [w for w in self.rpc(op='session.snapshot')['workspaces'] if w['name'].startswith('Old ')]
        self.assertEqual({w['name'] for w in ws}, {'Old w1', 'Old w2'})
        self.assertTrue(all(len(w['model']['tabs']) == 1 for w in ws))

    def test_unreadable_source_is_not_reported_as_empty_and_blinks_without_input(self):
        v = self.wizard('unreadable', 76, 26)
        self.until(lambda: 'No workspaces could be recovered' in self.text(v, 76, 26))
        frames = set()
        def both_frames():
            text = self.text(v, 76, 26)
            for frame in ('ᐱoᴥ°ᐱ', 'ᐱ─ᴥ─ᐱ'):
                if frame in text:
                    frames.add(frame)
            self.assertIn("I'm confused by this cmux version.", text)
            self.assertNotIn('No available sessions found', text)
            return len(frames) == 2
        self.until(both_frames, timeout=6)
        self.assertEqual(self.rpc(op='session.snapshot')['panes'], [])

    def test_recovery_notes_keep_mouse_selection_aligned_at_minimum_size(self):
        v = self.wizard('old', 76, 26)
        self.until(lambda: 'Old w2' in self.text(v, 76, 26))
        rows = screen_text(v.poll()['data'], 76, 26)
        y = next(i for i, row in enumerate(rows) if 'Old w2' in row)
        x = rows[y].index('Old w2')
        v.input(f'\x1b[<0;{x+1};{y+1}M\x1b[<0;{x+1};{y+1}m')
        self.assertIn('[x] Old w2', self.text(v, 76, 26))
        self.assertIn('[ ] Old w1', self.text(v, 76, 26))
        v.input('\r')
        self.until(lambda: "You're ready to go" in self.text(v, 76, 26))
        names = {w['name'] for w in self.rpc(op='session.snapshot')['workspaces']}
        self.assertIn('Old w2', names)
        self.assertNotIn('Old w1', names)

    def test_invalid_import_tree_is_rejected_before_creating_shells(self):
        before = self.rpc(op='session.snapshot')
        result = self.rpc(allow_error=True, op='onboarding.copy', operation=71, source='cmux', workspaces=[{
            'id': 'bad', 'name': 'must not exist', 'cwd': '/tmp', 'tabs': [{
                'id': 'tab', 'name': 'bad', 'panes': [{'id': 'p', 'name': 'bad'}],
                'nodes': [{'pane': 7}],
            }],
        }])
        self.assertEqual(result['err'], 'InvalidImportLayout')
        after = self.rpc(op='session.snapshot')
        self.assertEqual(after['panes'], before['panes'])
        self.assertEqual(after['workspaces'], before['workspaces'])

    def test_closing_wizard_cancels_cli_that_closed_stdout_but_did_not_exit(self):
        v = self.wizard('hang')
        self.until(lambda: Path(self.env['CMUX_TEST_LOG']).exists())
        started = time.monotonic()
        v.input('s')
        self.assertLess(time.monotonic() - started, 2)


if __name__ == '__main__':
    unittest.main()
