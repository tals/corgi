#!/usr/bin/env python3
"""Verify simulator scheduling and real fixture programs without a daemon."""
import json
import pathlib
import queue
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import provider_sim


class PairListener:
    """Supply connected socketpairs where a real server would accept clients."""

    def __init__(self, peers):
        self.peers = queue.Queue()
        for peer in peers:
            self.peers.put(peer)
        self.closed = False

    def bind(self, path):
        pass

    def listen(self):
        pass

    def settimeout(self, seconds):
        pass

    def accept(self):
        if self.closed:
            raise OSError('listener closed')
        try:
            return self.peers.get(timeout=.02), None
        except queue.Empty:
            raise socket.timeout() from None

    def close(self):
        self.closed = True


def handshake(client):
    client.settimeout(2)
    client.sendall(b'GET / HTTP/1.1\r\nHost: fixture\r\nUpgrade: websocket\r\n'
                   b'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
    response = b''
    while not response.endswith(b'\r\n\r\n'):
        response += client.recv(1)
    if b'101 Switching Protocols' not in response:
        raise AssertionError(response)


class Simulator(unittest.TestCase):
    def test_frozen_response_does_not_block_another_connection(self):
        first, first_peer = socket.socketpair()
        second, second_peer = socket.socketpair()
        with tempfile.TemporaryDirectory(prefix='corgi-sim-') as directory:
            listener = PairListener([first_peer, second_peer])
            with patch.object(provider_sim.socket, 'socket', return_value=listener):
                sim = provider_sim.CodexObserver(directory, ['A', 'B'])
            try:
                handshake(first)
                handshake(second)
                with sim.hold('thread/read', 'A') as held:
                    first.sendall(provider_sim._frame({'id': 1, 'method': 'thread/read', 'params': {'threadId': 'A'}}))
                    held.wait()
                    self.assertEqual(held.response['result']['thread']['status']['type'], 'idle')
                    index = sim.wait_for_request('thread/read', session='A')
                    sim.set_turn('A', 'next', 'inProgress', waiting=True)
                    second.sendall(provider_sim._frame({'id': 2, 'method': 'thread/read', 'params': {'threadId': 'A'}}))
                    index2 = sim.wait_for_request('thread/read', session='A', after=index)
                    self.assertGreater(index2, index)
                    response = provider_sim._receive(second)
                    self.assertEqual(response['id'], 2)
                    self.assertEqual(response['result']['thread']['status'], {
                        'type': 'active', 'activeFlags': ['waitingOnUserInput']})
                response = provider_sim._receive(first)
                self.assertEqual(response, held.response)
                # Waiting belongs to the requested conversation, not the server.
                second.sendall(provider_sim._frame({'id': 3, 'method': 'thread/read', 'params': {'threadId': 'B'}}))
                self.assertEqual(provider_sim._receive(second)['result']['thread']['status'], {
                    'type': 'idle', 'activeFlags': []})
            finally:
                first.close()
                second.close()
                sim.close()
            self.assertEqual(sim.errors, [])

    def test_native_program_preserves_both_provider_protocols(self):
        with tempfile.TemporaryDirectory(prefix='corgi-sim-') as directory:
            program = provider_sim.write_executable(pathlib.Path(directory, 'provider'), provider_sim.NATIVE_PROVIDER)
            for provider, arguments in [('codex', []), ('claude', ['--print'])]:
                with self.subTest(provider=provider):
                    messages = [
                        {'id': 1, 'method': 'initialize'},
                        {'method': 'test/approval'},
                        {'id': 900} if provider == 'codex' else {'type': 'control_response'},
                        {'method': 'test/exit'},
                    ]
                    result = subprocess.run([str(program), *arguments], input=''.join(json.dumps(v) + '\n' for v in messages),
                                            text=True, capture_output=True, timeout=3, check=True)
                    events = [json.loads(line) for line in result.stdout.splitlines()]
                    self.assertEqual(events[0], {'id': 1, 'result': {'version': 'fixture'}})
                    if provider == 'codex':
                        self.assertEqual(events[1]['method'], 'turn/started')
                        self.assertEqual(events[2]['method'], 'item/commandExecution/requestApproval')
                        self.assertEqual(events[3]['method'], 'turn/completed')
                    else:
                        self.assertEqual(events[1]['type'], 'control_request')
                        self.assertEqual(events[2]['type'], 'result')
                    self.assertEqual(result.stderr, '')

    def test_terminal_programs_emit_real_titles_and_screen_sequences(self):
        with tempfile.TemporaryDirectory(prefix='corgi-sim-') as directory:
            root = pathlib.Path(directory)
            terminal = provider_sim.write_codex_terminal(root / 'codex', 'A' * 36)
            result = subprocess.run([str(terminal), 'resume'], input='B\n', text=True,
                                    capture_output=True, timeout=3, check=True)
            self.assertIn('ARGS:["resume"]', result.stdout)
            self.assertIn('\x1b]0;codex | ' + 'A' * 29 + '...\x07', result.stdout)
            self.assertTrue(result.stdout.endswith('\x1b]0;codex | B\x07'))
            ordinary = provider_sim.write_ordinary_agent(root / 'claude')
            env = {'HOME': directory, 'CODEX_HOME': str(root / '.codex'), 'CLAUDE_CONFIG_DIR': str(root / '.claude')}
            result = subprocess.run([str(ordinary), '--loading'], env=env, input='ready\nwork\nblock\nstop\nexit\n',
                                    text=True, capture_output=True, timeout=3, check=True)
            self.assertIn('Initializing (esc to interrupt)', result.stdout)
            self.assertIn('Working (esc to interrupt)', result.stdout)
            self.assertIn('enter to confirm or esc to cancel', result.stdout)
            self.assertEqual(result.stdout.count('\x1b]2;✳ Ready\x07'), 2)
            self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
