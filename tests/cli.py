#!/usr/bin/env python3
"""Agent CLI regressions against isolated runtimes; never touches the live session."""
import json
import os
import pathlib
import subprocess
import unittest
from smoke import Runtime, EXE


class AgentCli(Runtime):
    def cli(self, *args, caller=None, error=None, stdin=None):
        env = {**self.env}
        env.pop('CORGI_PANE', None)
        if caller is not None:
            env['CORGI_PANE'] = str(caller)
        p = subprocess.run([EXE, *map(str, args)], env=env, input=stdin,
                           capture_output=True, text=True, timeout=8)
        if error is not None:
            self.assertNotEqual(p.returncode, 0, p.stdout)
            self.assertEqual(json.loads(p.stderr)['err'], error)
            self.assertEqual(p.stdout, '')
            return p.returncode
        self.assertEqual(p.returncode, 0, (args, p.stderr, p.stdout))
        return json.loads(p.stdout)

    def new(self, name='tab', workspace=1):
        return self.cli('tab', 'new', '--name', name, '--workspace', workspace)['result']

    def snapshot(self):
        return self.cli('list')['result']

    def topology(self):
        return [(w['id'], w['tabs']) for w in self.snapshot()['workspaces']]

    def test_layout_moves_keep_processes_and_tree(self):
        one = self.new('one')
        two = self.new('two')
        split = self.cli('pane', 'split', one['pane'], '--down')['result']
        before = self.snapshot()
        source_tree = before['workspaces'][0]['tabs'][0]['layout']
        pids = {p['id']: p['pid'] for p in before['panes']}
        self.cli('tab', 'rename', one['tab'], 'Backend')
        self.cli('tab', 'move', one['tab'], '--after', two['tab'])
        self.assertEqual([t['id'] for t in self.snapshot()['workspaces'][0]['tabs']], [two['tab'], one['tab']])
        self.cli('tab', 'merge', one['tab'], '--right-of', two['pane'])
        tabs = self.snapshot()['workspaces'][0]['tabs']
        self.assertEqual(len(tabs), 1)
        self.assertEqual(tabs[0]['layout']['split']['second'], source_tree)
        detached = self.cli('pane', 'move', split['pane'], '--new-tab', '--name', 'Logs')['result']
        self.assertNotEqual(detached['tab'], one['tab'])
        self.cli('pane', 'move', split['pane'], '--above', one['pane'])
        self.cli('pane', 'swap', split['pane'], two['pane'])
        self.assertEqual({p['id']: p['pid'] for p in self.snapshot()['panes']}, pids)
        for pid in pids.values():
            os.kill(pid, 0)

    def test_cross_workspace_current_and_atomic_failures(self):
        one = self.new()
        split = self.cli('pane', 'split', one['pane'], '--left')['result']
        ws = self.rpc(op='workspace.new', name='other', cwd=self.temp.name)['workspace']
        self.cli('tab', 'move', one['tab'], '--workspace', ws)
        here = self.cli('current', caller=split['pane'])['result']
        self.assertEqual(here['workspace'], ws)
        self.assertEqual(here['tab'], one['tab'])
        self.cli('tab', 'rename', 'current', 'Moved', caller=split['pane'])
        two = self.new('destination')
        self.cli('pane', 'move', 'current', '--below', two['pane'], caller=split['pane'])
        self.assertEqual(self.cli('current', caller=split['pane'])['result']['workspace'], 1)
        before = self.topology()
        self.cli('tab', 'merge', two['tab'], '--right-of', split['pane'], error='InvalidDestination')
        self.cli('pane', 'move', one['pane'], '--right-of', 999999, error='NoPane')
        self.cli('pane', 'resize', one['pane'], '--width', '60%', error='NoSplit')
        self.assertEqual(self.topology(), before)
        self.cli('pane', 'swap', one['pane'], two['pane'])
        self.assertEqual(self.cli('current', caller=one['pane'])['result']['workspace'], 1)
        self.assertEqual(self.cli('current', caller=two['pane'])['result']['workspace'], ws)

    def test_split_resize_and_close(self):
        one = self.new()
        split = self.cli('pane', 'split', one['pane'], '--left')['result']
        tree = self.snapshot()['workspaces'][0]['tabs'][0]['layout']['split']
        self.assertEqual(tree['first']['pane'], split['pane'])
        self.cli('pane', 'resize', one['pane'], '--width', '60%')
        tree = self.snapshot()['workspaces'][0]['tabs'][0]['layout']['split']
        self.assertEqual(tree['ratio'], 400)
        self.cli('pane', 'close', split['pane'])
        self.assertEqual(len(self.snapshot()['panes']), 1)
        self.cli('tab', 'close', one['tab'])
        self.assertEqual(self.snapshot()['panes'], [])

    def test_discovery_errors_and_terminal_io(self):
        for args in [('--help',), ('--skill',), ('tab',), ('pane',), ('pane', 'move', '--help')]:
            result = subprocess.run([EXE, *args], env={**self.env, 'CORGI_SOCKET':self.temp.name+'/absent.sock'}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Otherwise run: corgi --skill', self.run_cli('--help'))
        self.assertEqual(self.cli('pane', 'split', 'current', '--right', error='NoCallerPane'), 2)
        self.cli('tab', 'new', error='MissingWorkspace')
        one = self.new()
        before = self.topology()
        for args in [('pane', 'move', one['pane'], '--new-tab', '--below', one['pane']),
                     ('pane', 'split', one['pane'], '--right', '--up'),
                     ('pane', 'split', one['pane'], '--right', '--unknown'),
                     ('tab', 'rename', one['tab'], '--clear', 'oops')]:
            self.assertEqual(self.cli(*args, error='Usage'), 2)
        self.assertEqual(self.topology(), before)
        self.cli('pane', 'send', one['pane'], '--stdin', '--enter', stdin="printf 'cli_marker_123\\n'")
        self.until(lambda: 'cli_marker_123' in self.cli('pane', 'read', one['pane'])['text'])
        self.cli('pane', 'keys', one['pane'], 'ctrl+c')
        self.cli('pane', 'keys', one['pane'], 'enter', 'invalid-key', error='InvalidKey')
        self.cli('focus', one['pane'], error='Usage')
        self.cli('focus', one['pane'], '--viewer', 999, error='NoViewer')

    def test_viewers_keep_selection_and_explicit_focus(self):
        from viewers import Viewer
        self.viewers = []
        one = self.new('one')
        two = self.new('two')
        try:
            left, right = Viewer(self), Viewer(self)
            left.focus(one['pane'])
            right.focus(two['pane'])
            before = self.cli('list')['viewers']
            self.cli('tab', 'rename', one['tab'], 'renamed')
            self.cli('tab', 'move', one['tab'], '--after', two['tab'])
            self.cli('pane', 'split', one['pane'], '--down')
            left.poll(); right.poll()
            self.assertEqual(self.cli('list')['viewers'], before)
            viewer_id = next(v['id'] for v in before if v['pane'] == one['pane'])
            self.cli('focus', two['pane'], '--viewer', viewer_id)
            left.poll(); right.poll()
            self.assertTrue(all(v['pane'] == two['pane'] for v in self.cli('list')['viewers']))
        finally:
            for viewer in self.viewers:
                viewer.close()

    def test_cwd_and_scrollback(self):
        folder = pathlib.Path(self.temp.name, 'project')
        folder.mkdir()
        folder = folder.resolve()
        one = self.cli('tab', 'new', '--workspace', 1, '--cwd', str(folder))['result']
        split = self.cli('pane', 'split', 'current', '--up', caller=one['pane'])['result']
        self.assertEqual(next(p['cwd'] for p in self.snapshot()['panes'] if p['id'] == split['pane']), str(folder))
        new = self.cli('tab', 'new', caller=split['pane'])['result']
        self.assertEqual(next(p['cwd'] for p in self.snapshot()['panes'] if p['id'] == new['pane']), str(folder))
        self.cli('pane', 'send', one['pane'], "i=0; while [ $i -lt 150 ]; do printf 'row_%03d\\n' $i; i=$((i+1)); done", '--enter')
        self.until(lambda: 'row_149' in self.cli('pane', 'read', one['pane'], '--lines', 10)['text'])
        recent = self.cli('pane', 'read', one['pane'], '--lines', 100)['text']
        self.assertIn('row_080', recent)
        self.assertNotIn('row_000', recent)
        self.assertLessEqual(len(recent.splitlines()), 100)
        invalid = self.raw_rpc(op='cli.control', protocol=1, action='pane.move', target=one['pane'])
        self.assertEqual(invalid['err'], 'InvalidDestination')

    def test_full_tab_capacity_rolls_back(self):
        one = self.new()
        split = self.cli('pane', 'split', one['pane'], '--right')['result']
        for _ in range(23):
            self.new()
        before = self.topology()
        self.cli('pane', 'move', split['pane'], '--new-tab', error='TooManyTabs')
        self.assertEqual(self.topology(), before)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(AgentCli(name) for name in AgentCli.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main()
