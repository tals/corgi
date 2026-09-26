#!/usr/bin/env python3
"""Incremental viewer transport against real PTYs and isolated daemons."""
import base64, json, pathlib, shlex, socket, sys, time, unittest
import smoke
from viewer_client import Viewer


class WireViewer:
    def __init__(self, test, pane, cols=80, rows=24):
        self.client = socket.socket(socket.AF_UNIX)
        self.client.settimeout(5)
        self.client.connect(test.path)
        self.stream = self.client.makefile('rb')
        self.pane, self.cols, self.rows = pane, cols, rows
        self.session_hash = None
        self.known = None
        self.frame = None
        self.session = None
        self.call(op='viewer.open', cwd=test.temp.name)
        test.addCleanup(self.close)

    def close(self):
        self.stream.close()
        self.client.close()

    def call(self, **request):
        self.client.sendall(json.dumps(dict(protocol=1, viewer_protocol=2, **request)).encode()+b'\n')
        line = self.stream.readline()
        self.response_bytes = len(line)
        reply = json.loads(line)
        if 'err' in reply:
            raise AssertionError(reply)
        return reply

    def sync(self, offset=None, accept=True, **options):
        reply = self.call(op='viewer.sync', session_hash=self.session_hash,
                          interests=[dict(pane=self.pane, cols=self.cols, rows=self.rows,
                                          offset=offset, known=self.known)],
                          focus=self.pane, **options)
        self.session_hash = reply['session_hash']
        if reply['session'] is not None:
            self.session = reply['session']
        if accept and reply['surfaces']:
            self.frame = reply['surfaces'][0]
            self.known = self.frame['stamp']
        return reply

    def text(self):
        return ''.join(self.frame['surface']['lines']) if self.frame else ''


class ViewerSync(unittest.TestCase):
    setUp = smoke.Runtime.setUp
    tearDown = smoke.Runtime.tearDown
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    command = smoke.Runtime.command
    session = smoke.Runtime.session
    until = smoke.Runtime.until

    def new(self, command="printf 'IDLE_SURFACE'; sleep 60"):
        return self.command('pane.create', workspace=self.session()['workspaces'][0]['id'],
                            cwd=self.temp.name, command=command)['pane']

    def ready(self, viewer, text):
        self.until(lambda: (viewer.sync(), text in viewer.text())[1])

    def test_idle_sync_omits_surfaces_and_metadata_but_delivers_controls(self):
        pane = self.new()
        viewer = WireViewer(self, pane)
        self.ready(viewer, 'IDLE_SURFACE')
        # Metadata can settle asynchronously; unchanged responses must become tiny.
        def unchanged():
            reply = viewer.sync()
            return reply if reply['session'] is None else None
        reply = self.until(unchanged)
        self.assertEqual(reply['surfaces'], [])
        self.assertLess(viewer.response_bytes, 400)
        for _ in range(10):
            self.assertEqual(viewer.sync()['surfaces'], [])
        self.command('pane.rename', target=pane, name='Renamed metadata')
        reply = viewer.sync()
        self.assertIsNotNone(reply['session'])
        self.assertEqual(reply['surfaces'], [])
        self.assertEqual(next(p for p in viewer.session['panes'] if p['id']==pane)['name'], 'Renamed metadata')
        self.rpc(op='action', name='rename', value='Queued', viewer=reply['viewer'])
        reply = viewer.sync()
        self.assertEqual(reply['controls'][0]['value'], 'Queued')
        self.assertEqual(reply['surfaces'], [])
        self.assertEqual(viewer.sync(ack=reply['controls'][0]['seq'])['controls'], [])

    def test_output_modes_viewport_resize_and_theme_invalidate_receipts(self):
        fixture = pathlib.Path(self.temp.name, 'modes.py')
        fixture.write_text("import os,tty\ntty.setraw(0)\n"
                           "os.write(1,''.join(f'ROW_{i:03d}\\r\\n' for i in range(60)).encode())\n"
                           "while os.read(0,1):os.write(1,b'\\x1b[?1h\\x1b[?2004h')\n")
        pane = self.new(shlex.join([sys.executable, str(fixture)]))
        viewer = WireViewer(self, pane)
        self.ready(viewer, 'ROW_059')
        live = viewer.known
        reply = viewer.sync(offset=0)
        self.assertTrue(reply['surfaces'])
        self.assertIn('ROW_000', viewer.text())
        self.assertEqual(viewer.sync(offset=0)['surfaces'], [])
        self.assertTrue(viewer.sync()['surfaces'])
        self.assertEqual(viewer.known, live)
        viewer.cols = 90
        self.assertEqual(viewer.sync(active=True)['surfaces'][0]['surface']['cols'], 90)
        self.assertEqual(viewer.sync()['surfaces'], [])
        # Change input modes without printing visible text.
        before = viewer.text()
        self.command('pane.input', target=pane, data='m')
        self.until(lambda: (viewer.sync(), viewer.frame['modes']['cursor_keys'] and viewer.frame['modes']['bracketed_paste'])[1])
        self.assertEqual(viewer.text(), before)
        self.assertEqual(viewer.sync()['surfaces'], [])
        viewer.call(op='theme', theme=dict(background=dict(r=1,g=2,b=3)))
        self.assertTrue(viewer.sync()['surfaces'])
        self.assertEqual(viewer.sync()['surfaces'], [])

    def test_unapplied_surface_is_retried_and_handoff_invalidates_receipts(self):
        pane = self.new('exec /bin/sh')
        viewer = WireViewer(self, pane)
        viewer.sync()
        self.command('pane.input', target=pane, data="printf 'LATEST_%s\\n' OUTPUT\r")
        def latest():
            reply = viewer.sync(accept=False)
            return reply if reply['surfaces'] and 'LATEST_OUTPUT' in ''.join(reply['surfaces'][0]['surface']['lines']) else None
        self.until(latest)
        # A viewer holding mouse selection has not acknowledged that surface.
        self.assertTrue(viewer.sync(accept=False)['surfaces'])
        self.assertTrue(viewer.sync()['surfaces'])
        self.assertEqual(viewer.sync()['surfaces'], [])
        identity = viewer.known['identity']
        before = self.session()
        result = self.rpc(op='server.reload', protocol=1, executable=smoke.EXE)
        self.assertNotEqual(result['server_pid'], before['server_pid'])
        self.assertTrue(viewer.sync()['surfaces'])
        self.assertNotEqual(viewer.known['identity'], identity)
        self.assertIn('LATEST_OUTPUT', viewer.text())
        self.assertEqual(self.session()['panes'][0]['pid'], before['panes'][0]['pid'])

    def test_synchronized_output_timeout_publishes_held_changes(self):
        fixture = pathlib.Path(self.temp.name, 'sync.py')
        fixture.write_text("import os,pathlib,time\n"
                           "os.write(1,b'READY')\n"
                           "while not pathlib.Path('begin').exists():time.sleep(.005)\n"
                           "os.write(1,b'\\x1b[?2026h\\x1b[2J\\x1b[HAFTER_TIMEOUT')\n"
                           "time.sleep(60)\n")
        pane = self.new(shlex.join([sys.executable, str(fixture)]))
        viewer = WireViewer(self, pane)
        self.ready(viewer, 'READY')
        pathlib.Path(self.temp.name, 'begin').touch()
        time.sleep(.1)
        viewer.sync()
        self.assertIn('READY', viewer.text())
        self.assertNotIn('AFTER_TIMEOUT', viewer.text())
        self.ready(viewer, 'AFTER_TIMEOUT')
        self.assertEqual(viewer.sync()['surfaces'], [])

    def test_search_updates_selection_on_an_unchanged_viewport(self):
        pane = self.new("printf 'one NEEDLE two NEEDLE'; sleep 60")
        viewer = Viewer(self)
        viewer.focus(pane)
        self.until(lambda: 'one NEEDLE two NEEDLE' in viewer.poll()['data'])
        first = viewer.input('\x02s/NEEDLE\r')['data']
        second = viewer.input('n')['data']
        self.assertNotEqual(first, second)
        copied = viewer.input('y')['effects'][0]['write_terminal']
        encoded = copied.split('52;c;',1)[1].split('\x07',1)[0]
        self.assertEqual(base64.b64decode(encoded).decode(), 'NEEDLE')


if __name__ == '__main__':
    unittest.main(verbosity=2)
