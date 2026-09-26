#!/usr/bin/env python3
"""Terminal evidence -> native inference -> named workspace link and click."""
import json
import os
import pathlib
import re
import shlex
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import ports
import smoke
import viewers


@unittest.skipUnless(shutil.which('lsof') and shutil.which('curl'), 'requires lsof and curl')
class LinkLabels(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    command = smoke.Runtime.command
    raw_rpc = smoke.Runtime.raw_rpc
    session = smoke.Runtime.session
    until = smoke.Runtime.until
    new = viewers.Viewers.new

    def setUp(self):
        self.inference_temp = tempfile.TemporaryDirectory(prefix='corgi-link-label-')
        root = pathlib.Path(self.inference_temp.name)
        self.log = root / 'requests.jsonl'
        self.control = root / 'control.json'
        self.control.write_text(json.dumps({'label': 'Finance', 'delay': 1}))
        fixture = pathlib.Path(__file__).with_name('inference_harness.py').resolve()
        with patch.dict(os.environ, {
            'CORGI_INFERENCE_PROVIDER': 'codex',
            'CORGI_INFERENCE_BIN': str(fixture),
            'CORGI_INFERENCE_TEST_LOG': str(self.log),
            'CORGI_INFERENCE_TEST_CONTROL': str(self.control),
        }):
            ports.Ports.setUp(self)

    def tearDown(self):
        try:
            ports.Ports.tearDown(self)
        finally:
            self.inference_temp.cleanup()

    def start_server(self):
        root = pathlib.Path(self.temp.name)
        script = root / 'finance.py'
        ready = root / 'ready.json'
        script.write_text('''import http.server,json,os,sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
    def log_message(self,*args): pass
s=http.server.HTTPServer(('127.0.0.1',0),Handler)
print('Finance personal dashboard ready at http://localhost:'+str(s.server_port),flush=True)
with open(sys.argv[1],'w') as f: json.dump({'port':s.server_port,'pid':os.getpid()},f)
s.serve_forever()
''')
        pane = self.new('exec ' + shlex.join([sys.executable, '-u', str(script), str(ready)]))
        self.until(ready.exists)
        info = json.loads(ready.read_text())
        self.fixture_pid = info['pid']
        return pane, info

    def endpoints(self):
        return [e for w in self.session()['ports']['workspaces'] for e in w['endpoints']]

    def test_names_link_from_owning_terminal_and_preserves_destination(self):
        pane, info = self.start_server()
        self.until(lambda: any(e.get('label') == 'Finance' for e in self.endpoints()), timeout=25)
        payload = json.loads(self.log.read_text().splitlines()[0])
        self.assertIn('Finance personal dashboard', payload['terminal'])
        self.assertEqual(payload['pid'], info['pid'])
        self.assertEqual(payload['url'], f'http://localhost:{info["port"]}')
        viewer = viewers.Viewer(self)
        self.assertIn('Open Finance ↗', viewer.poll()['data'])
        self.assertIn('\x1b]22;pointer\x1b\\', viewer.input('\x1b[<35;14;3M')['data'])
        state = viewer.input('\x1b[<0;14;3M\x1b[<0;14;3m')
        self.assertEqual(state['effects'], [{'open_url': payload['url']}])
        time.sleep(1)
        self.assertEqual(len(self.log.read_text().splitlines()), 1)
        self.assertEqual(self.rpc(op='native.list')['sessions'], [])
        self.command('pane.close', target=pane)
        self.until(lambda: not self.endpoints(), timeout=15)
        self.assertNotIn('Open Finance', viewer.poll()['data'])

    def test_pending_dots_glimmer_then_resolve_without_changing_the_url(self):
        self.control.write_text(json.dumps({'label': 'Finance', 'delay': 4}))
        _, info = self.start_server()
        self.until(lambda: any(e.get('label_pending') for e in self.endpoints()), timeout=25)
        viewer = viewers.Viewer(self)
        first = viewer.poll()['data']
        self.assertIn('Open ... ↗', smoke.screen_text(first, 100, 30)[2])
        colors = lambda frame: re.findall(r'\x1b\[38;2;(\d+;\d+;\d+)m\.', frame)
        self.assertEqual(len(colors(first)), 3)
        self.until(lambda: colors(viewer.poll()['data']) != colors(first), timeout=2)
        self.assertIn('Open ... ↗', smoke.screen_text(viewer.state['data'], 100, 30)[2])
        clicked = viewer.input('\x1b[<0;14;3M\x1b[<0;14;3m')
        self.assertEqual(clicked['effects'], [{'open_url': f'http://localhost:{info["port"]}'}])
        self.until(lambda: any(e.get('label') == 'Finance' and not e.get('label_pending') for e in self.endpoints()), timeout=10)
        final = viewer.poll()['data']
        self.assertIn('Open Finance ↗', final)
        self.assertEqual(colors(final), [])

    def test_inflight_result_and_cached_name_survive_reload_without_rebilling(self):
        self.control.write_text(json.dumps({'label': 'Finance', 'delay': 2.5}))
        self.start_server()
        self.until(self.log.exists, timeout=25)
        self.assertTrue(any(e.get('label_pending') for e in self.endpoints()))
        self.rpc(op='server.reload', protocol=1, executable=smoke.EXE)
        self.until(lambda: any(e.get('label') == 'Finance' and not e.get('label_pending') for e in self.endpoints()), timeout=25)
        self.assertEqual(len(self.log.read_text().splitlines()), 1,
                         'completed in-flight link inference was billed again')
        self.rpc(op='server.reload', protocol=1, executable=smoke.EXE)
        self.until(lambda: any(e.get('label') == 'Finance' for e in self.endpoints()), timeout=25)
        time.sleep(1)
        self.assertEqual(len(self.log.read_text().splitlines()), 1,
                         'cached link name was inferred again after reload')

    def test_invalid_guess_keeps_fallback_and_does_not_loop(self):
        self.control.write_text(json.dumps({'label': 'Bad\u001b[2J', 'delay': 0}))
        self.start_server()
        self.until(self.log.exists, timeout=25)
        time.sleep(.8)
        self.assertTrue(all(not e.get('label') for e in self.endpoints()))
        self.assertTrue(all(not e.get('label_pending') for e in self.endpoints()))
        viewer = viewers.Viewer(self)
        self.assertIn('Open Link ↗', viewer.poll()['data'])
        time.sleep(1)
        self.assertEqual(len(self.log.read_text().splitlines()), 1)

    def test_late_guess_for_removed_endpoint_is_discarded(self):
        self.control.write_text(json.dumps({'label': 'Stale App', 'delay': 2}))
        pane, _ = self.start_server()
        self.until(self.log.exists, timeout=25)
        self.command('pane.close', target=pane)
        self.until(lambda: not self.endpoints(), timeout=15)
        time.sleep(2.2)
        viewer = viewers.Viewer(self)
        self.assertNotIn('Open Stale App', viewer.poll()['data'])


if __name__ == '__main__':
    unittest.main()
