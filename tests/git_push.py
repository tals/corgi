#!/usr/bin/env python3
"""Hover-to-push through real viewers, with disposable local Git remotes only."""
import pathlib
import subprocess
import time
import unittest

import smoke
import viewers
from viewer_client import Viewer


class GitPush(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    raw_rpc = smoke.Runtime.raw_rpc
    command = smoke.Runtime.command
    session = smoke.Runtime.session
    until = smoke.Runtime.until
    new = viewers.Viewers.new

    def setUp(self):
        smoke.Runtime.setUp(self)
        self.root = pathlib.Path(self.temp.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Push Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.commit('base')
        self.remote = self.root / 'remote.git'
        self.git('init', '--bare', str(self.remote))
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('push', '-u', 'origin', 'main')
        self.commit('ready to push')
        self.new()
        self.until(lambda: self.workspace()['git_ahead'] == 1)
        self.viewer = Viewer(self)

    def tearDown(self):
        smoke.Runtime.tearDown(self)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', self.temp.name, *args], stderr=subprocess.DEVNULL).decode().strip()

    def commit(self, message):
        self.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message)

    def workspace(self):
        return self.session()['workspaces'][0]

    def row(self, viewer=None):
        return smoke.screen_text((viewer or self.viewer).state['data'], 100, 30)[2]

    def hover(self, x=25, y=3, viewer=None):
        (viewer or self.viewer).input(f'\x1b[<35;{x};{y}M')

    def click(self, x=25, y=3, viewer=None):
        target = viewer or self.viewer
        target.input(f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m')

    def hook(self, body):
        path = self.remote / 'hooks' / 'pre-receive'
        path.write_text('#!/bin/sh\n' + body + '\n')
        path.chmod(0o700)
        return path

    def test_hover_shared_progress_and_success(self):
        other = Viewer(self)
        original = self.row()
        self.assertIn('↑1', original)
        self.hover()
        self.assertIn('Push ↑1', self.row())
        self.assertEqual(original.index('↑1'), self.row().index('↑1'))
        self.assertNotIn('Push ↑1', self.row(other))
        self.hover(21)
        self.assertIn('Push ↑1', self.row())
        self.hover(5)
        self.assertNotIn('Push ↑1', self.row())
        self.hover()
        time.sleep(.6)
        self.assertIn('ready to push', self.viewer.poll()['data'])
        pathlib.Path('/tmp/corgi-git-push-hover.txt').write_text('\n'.join(smoke.screen_text(self.viewer.state['data'], 100, 30)))
        calls = self.remote / 'calls'
        self.hook(f'echo push >> "{calls}"\nsleep 1')
        # Push configuration must not expand the scope to another branch/tag.
        self.git('branch', 'unrelated')
        self.git('tag', 'unrelated-tag')
        self.git('config', 'remote.origin.mirror', 'true')
        self.git('config', 'push.followTags', 'true')
        self.click()
        self.assertIn('Pushing', self.row())
        self.assertIn('Pushing', other.poll()['data'])
        self.click(viewer=other)
        self.click()
        self.until(lambda: self.workspace()['git_push']['phase'] != 'pushing')
        self.assertEqual(self.workspace()['git_push']['phase'], 'succeeded', self.workspace()['git_push'])
        self.assertIn('Pushed ✓', self.viewer.poll()['data'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.git('--git-dir', str(self.remote), 'rev-parse', 'main'))
        self.assertEqual(calls.read_text().splitlines(), ['push'])
        self.assertEqual(self.git('--git-dir', str(self.remote), 'for-each-ref', '--format=%(refname)'), 'refs/heads/main')
        self.until(lambda: self.workspace()['git_ahead'] == 0 and self.workspace()['git_push']['phase'] == 'idle')
        self.assertNotIn('↑1', self.viewer.poll()['data'])

    def test_failure_is_visible_without_moving_and_retry_works(self):
        hook = self.hook('echo "fixture rejected this push" >&2\nexit 1')
        self.hover()
        self.click()
        self.until(lambda: self.workspace()['git_push']['phase'] == 'failed')
        frame = self.viewer.poll()['data']
        self.assertIn('Retry !', frame)
        self.assertIn('fixture rejected this push', frame)
        self.assertIn('Push failed', frame)
        hook.unlink()
        self.click()
        self.until(lambda: self.workspace()['git_ahead'] == 0)

    def test_stale_preview_and_non_fast_forward_never_force(self):
        before = self.workspace()
        self.commit('created after the preview')
        response = self.raw_rpc(op='git.push', protocol=1, workspace=before['id'], ref=before['git_ref'])
        if response.get('ok'):
            self.until(lambda: self.workspace()['git_push']['phase'] == 'failed')
        else:
            self.assertEqual(response['err'], 'GitPreviewChanged')
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), self.git('--git-dir', str(self.remote), 'rev-parse', 'main'))
        self.until(lambda: self.workspace()['git_ahead'] == 2)
        # Install a diverged remote commit without changing the tracked preview.
        tree = self.git('rev-parse', 'HEAD^{tree}')
        base = self.git('rev-parse', 'origin/main')
        remote_tip = self.git('-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', base, '-m', 'remote-only')
        self.git('push', 'origin', f'{remote_tip}:refs/heads/other')
        self.git('--git-dir', str(self.remote), 'update-ref', 'refs/heads/main', remote_tip)
        self.viewer.poll()
        self.hover()
        self.click()
        self.until(lambda: self.workspace()['git_push']['phase'] == 'failed')
        self.assertEqual(remote_tip, self.git('--git-dir', str(self.remote), 'rev-parse', 'main'))

    def test_background_workspace_push_does_not_switch_selection(self):
        second = self.command('workspace.create', cwd=str(self.root / 'remote.git'), name='elsewhere')['workspace']
        self.viewer.poll()
        self.viewer.request(op='workspace', workspace=second)
        self.hover()
        self.click()
        self.assertEqual(self.viewer.state['workspace'], second)
        self.until(lambda: self.workspace()['git_ahead'] == 0)
        self.assertEqual(self.viewer.poll()['workspace'], second)

    def test_push_freezes_commit_and_finishes_after_checkout_changes(self):
        marker = self.remote / 'started'
        self.hook(f'touch "{marker}"\nsleep 4')
        expected = self.git('rev-parse', 'HEAD')
        self.hover()
        self.click(21)
        self.until(marker.exists)
        self.commit('created while pushing')
        self.git('checkout', '--detach')
        self.until(lambda: self.workspace()['git_ref']['head'] == '')
        self.until(lambda: self.workspace()['git_push']['phase'] != 'pushing', timeout=6)
        self.until(lambda: expected == self.git('--git-dir', str(self.remote), 'rev-parse', 'main'))

    def test_changed_upstream_is_rejected_and_local_upstream_can_push(self):
        before = self.workspace()
        self.git('branch', 'local-upstream', 'origin/main')
        base = self.git('rev-parse', 'local-upstream')
        self.git('branch', '--set-upstream-to=local-upstream')
        response = self.raw_rpc(op='git.push', protocol=1, workspace=before['id'], ref=before['git_ref'])
        if response.get('ok'):
            self.until(lambda: self.workspace()['git_push']['phase'] == 'failed')
            self.assertIn('upstream changed', self.workspace()['git_push']['message'])
        else:
            self.assertEqual(response['err'], 'GitPreviewChanged')
        self.assertEqual(base, self.git('rev-parse', 'local-upstream'))
        self.until(lambda: self.workspace()['git_ref']['remote'] == '.')
        self.viewer.poll()
        self.hover()
        self.click()
        self.until(lambda: self.workspace()['git_ahead'] == 0)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.git('rev-parse', 'local-upstream'))

    def test_switching_branches_cannot_join_an_old_push(self):
        base = self.git('rev-parse', 'origin/main')
        expected = self.git('rev-parse', 'HEAD')
        self.git('push', 'origin', f'{base}:refs/heads/second')
        self.git('branch', 'second')
        self.git('branch', '--set-upstream-to=origin/second', 'second')
        marker = self.remote / 'started'
        self.hook(f'touch "{marker}"\nsleep 4')
        self.hover()
        self.click()
        self.until(marker.exists)
        self.git('checkout', 'second')
        self.until(lambda: self.workspace()['git_ref']['branch'] == 'refs/heads/second')
        self.viewer.poll()
        self.assertEqual(self.workspace()['git_push']['phase'], 'idle')
        self.click()
        self.assertIn('A push is already running', self.viewer.state['data'])
        self.until(lambda: self.git('--git-dir', str(self.remote), 'rev-parse', 'main') == expected)
        self.assertEqual(self.workspace()['git_push']['phase'], 'idle')
        self.assertEqual(base, self.git('--git-dir', str(self.remote), 'rev-parse', 'second'))


if __name__ == '__main__':
    unittest.main()
