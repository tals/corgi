#!/usr/bin/env python3
"""Viewer compatibility across inherited sockets and server replacement.

Build first: ./scripts/zig build -Dviewer-test-driver=true
"""
import json
import os
import select
import socket
import subprocess
import termios
import threading
import time
import unittest

import smoke
from viewer_client import EXE, Viewer


class ReplyProxy:
    """Keep real daemon sockets while simulating another viewer wire format."""

    def __init__(self, path, upstream):
        self.upstream = upstream
        self.sync_reply = None
        self.open_reply = None
        self.synced = threading.Event()
        self.stopped = threading.Event()
        self.connections = []
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(path)
        self.listener.listen()
        self.listener.settimeout(.1)
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stopped.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.connections.append(client)
            threading.Thread(target=self.forward, args=(client,), daemon=True).start()

    def forward(self, client):
        server = socket.socket(socket.AF_UNIX)
        self.connections.append(server)
        try:
            server.connect(self.upstream)
            with client, server, client.makefile('rb') as requests, server.makefile('rb') as replies:
                for line in requests:
                    request = json.loads(line)
                    server.sendall(line)
                    reply = replies.readline()
                    if not reply:
                        return
                    if request.get('op') == 'viewer.open' and self.open_reply is not None:
                        reply = json.dumps(self.open_reply).encode() + b'\n'
                    if request.get('op') == 'viewer.sync':
                        if self.sync_reply is not None:
                            reply = json.dumps(self.sync_reply).encode() + b'\n'
                        self.synced.set()
                    client.sendall(reply)
        except (OSError, ValueError):
            pass

    def close(self):
        self.stopped.set()
        self.listener.close()
        self.thread.join(timeout=2)
        for connection in self.connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()


class ViewerCompatibility(unittest.TestCase):
    setUp = smoke.Runtime.setUp
    tearDown = smoke.Runtime.tearDown
    run_cli = smoke.Runtime.run_cli
    raw_rpc = smoke.Runtime.raw_rpc
    rpc = smoke.Runtime.rpc
    session = smoke.Runtime.session

    def proxy(self):
        path = self.temp.name + '/viewer.sock'
        proxy = ReplyProxy(path, self.path)
        self.addCleanup(proxy.close)
        return proxy, {**self.env, 'CORGI_SOCKET': path}

    def assert_explanation(self, process, output):
        self.assertEqual(process.returncode, 1, output)
        self.assertIn('this viewer is incompatible with the server', output)
        self.assertIn('requires viewer protocol 2', output)
        self.assertIn('Reattach using the same Corgi version as the server', output)
        self.assertNotIn('MissingField', output)
        self.assertNotIn('panic:', output)

    def test_server_rejects_open_before_creating_or_attaching(self):
        for version in (None, 1, 3, -1, '2'):
            request = dict(op='viewer.open', protocol=1, cwd=self.temp.name)
            if version is not None:
                request['viewer_protocol'] = version
            result = self.raw_rpc(**request)
            self.assertEqual(result['err'], 'UnsupportedViewerProtocol')
            self.assertEqual(result['viewer_protocol'], 2)
        self.assertEqual(self.session()['panes'], [])
        self.assertEqual(self.raw_rpc(op='viewer.list')['viewers'], [])

    def test_server_rechecks_sync_on_inherited_connection(self):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(self.path)
            with client.makefile('rb') as stream:
                def call(**request):
                    client.sendall(json.dumps(dict(protocol=1, **request)).encode() + b'\n')
                    return json.loads(stream.readline())

                opened = call(op='viewer.open', viewer_protocol=2, onboarding=True)
                self.assertEqual(opened['viewer_protocol'], 2)
                old_pid = self.session()['server_pid']
                self.run_cli('reload', EXE)
                self.assertNotEqual(self.session()['server_pid'], old_pid)
                # The incompatible payload must never reach the typed parser.
                rejected = call(op='viewer.sync', viewer_protocol=3, interests='different format')
                self.assertEqual(rejected['err'], 'UnsupportedViewerProtocol')
                self.assertEqual(rejected['viewer_protocol'], 2)
                accepted = call(op='viewer.sync', viewer_protocol=2, interests=[])
                self.assertEqual(accepted['type'], 'view')

    def test_connected_viewer_explains_incompatible_handoff_responses(self):
        proxy, env = self.proxy()
        original_env = self.env
        # Missing, changed, and malformed versions must all fail before parsing
        # the intentionally absent session/surface fields in these responses.
        replies = ({}, {'viewer_protocol': 3}, {'viewer_protocol': '2'},
                   {'err': 'UnsupportedViewerProtocol', 'viewer_protocol': 3},
                   {'err': 'UnsupportedProtocol'})
        for reply in replies:
            with self.subTest(reply=reply):
                proxy.sync_reply = None
                self.env = env
                try:
                    viewer = Viewer(self)
                finally:
                    self.env = original_env
                old_pid = self.session()['server_pid']
                self.run_cli('reload', EXE)
                self.assertNotEqual(self.session()['server_pid'], old_pid)
                self.assertFalse(viewer.poll()['detached'])
                proxy.sync_reply = reply
                stdout, stderr = viewer.proc.communicate('{"op":"poll"}\n', timeout=5)
                self.assertEqual(stdout, '')
                self.assert_explanation(viewer.proc, stderr)

    def test_attach_restores_terminal_before_explaining_incompatibility(self):
        proxy, env = self.proxy()
        env.pop('CORGI_PANE', None)
        master, slave = os.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        before = termios.tcgetattr(slave)
        process = subprocess.Popen([EXE, '--no-update'], env=env, cwd=self.temp.name,
                                   stdin=slave, stdout=slave, stderr=slave)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        output = bytearray()

        def drain():
            if select.select([master], [], [], .05)[0]:
                output.extend(os.read(master, 65536))

        deadline = time.monotonic() + 5
        while not proxy.synced.is_set() and time.monotonic() < deadline:
            drain()
        self.assertTrue(proxy.synced.is_set(), output)
        self.run_cli('reload', EXE)
        proxy.sync_reply = {'viewer_protocol': 3}
        deadline = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < deadline:
            drain()
        process.wait(timeout=1)
        while select.select([master], [], [], 0)[0]:
            output.extend(os.read(master, 65536))
        text = output.decode(errors='replace')
        self.assert_explanation(process, text)
        self.assertLess(text.index('\x1b[?1049l'), text.index('this viewer is incompatible'))
        self.assertEqual(termios.tcgetattr(slave), before)

    def test_new_viewer_rejects_unversioned_open_reply(self):
        proxy, env = self.proxy()
        proxy.open_reply = {'ok': True, 'workspace': 1, 'bell_seq': 0}
        process = subprocess.run([EXE, '__viewer-test'], input='', capture_output=True,
                                 text=True, env=env, cwd=self.temp.name, timeout=5)
        self.assert_explanation(process, process.stderr)


if __name__ == '__main__':
    unittest.main()
