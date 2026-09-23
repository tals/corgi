#!/usr/bin/env python3
"""Process/socket discovery and OSC8 links through isolated real viewers.
Build: scripts/zig build -Doptimize=ReleaseSafe -Dviewer-test-driver=true
"""
import json, os, pathlib, shlex, shutil, signal, subprocess, sys, time, unittest
import smoke
import viewers
from viewers import Viewer

FIXTURE = r'''
import http.server, json, os, socket, ssl, sys, threading, time
os.setpgid(0, 0)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
    def log_message(self, *args): pass
servers = []
for address in ('0.0.0.0', '127.0.0.1'):
    server = http.server.ThreadingHTTPServer((address, 0), Handler)
    servers.append(server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
secure = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[2], sys.argv[3])
secure.socket = context.wrap_socket(secure.socket, server_side=True)
threading.Thread(target=secure.serve_forever, daemon=True).start()
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); udp.bind(('127.0.0.1', 0))
with open(sys.argv[1], 'w') as f:
    json.dump(dict(wild=servers[0].server_port, local=servers[1].server_port, secure=secure.server_port, udp=udp.getsockname()[1], pid=os.getpid()), f)
while True: time.sleep(1)
'''

@unittest.skipUnless(shutil.which('lsof') and shutil.which('curl'), 'discovery requires lsof and curl')
class Ports(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    command=smoke.Runtime.command
    raw_rpc = smoke.Runtime.raw_rpc
    session = smoke.Runtime.session
    until = smoke.Runtime.until
    new = viewers.Viewers.new
    def setUp(self):
        self.viewers = []
        self.fixture_pid = None
        smoke.Runtime.setUp(self)
        for key in ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'):
            self.env.pop(key, None)
    def tearDown(self):
        for v in self.viewers: v.close()
        if self.fixture_pid:
            try: os.kill(self.fixture_pid, signal.SIGTERM)
            except ProcessLookupError: pass
        smoke.Runtime.tearDown(self)
    def test_inventory_http_https_udp_and_per_viewer_links(self):
        root = pathlib.Path(self.temp.name)
        script = root/'serve.py'; script.write_text(FIXTURE)
        ready = root/'ready.json'
        cert, key = root/'cert.pem', root/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=localhost'], check=True, capture_output=True)
        args = [sys.executable, str(script), str(ready), str(cert), str(key)]
        pane = self.new(shlex.join(args) + ' & wait')
        self.until(ready.exists)
        info = json.loads(ready.read_text())
        self.fixture_pid = info["pid"]
        ws = self.session()['workspaces'][0]['id']
        def inventory():
            return next((w for w in self.session()['ports']['workspaces'] if w['id'] == ws), {})
        def discovered():
            endpoints = inventory().get('endpoints', [])
            return len(endpoints) == 4 and sum(e['scheme'] != 'unknown' for e in endpoints) == 3
        self.until(discovered, timeout=25)
        work = inventory()
        self.assertGreaterEqual(work['background'], 1)
        endpoints = {e['port']: e for e in work['endpoints']}
        for e in endpoints.values():
            self.assertEqual(e['pid'], info['pid'])
            self.assertEqual(e['pane'], pane)
        self.assertEqual(endpoints[info['wild']]['scheme'], 'http')
        self.assertEqual(endpoints[info['secure']]['scheme'], 'https')
        self.assertEqual(endpoints[info['udp']]['transport'], 'udp')
        self.assertEqual(endpoints[info['udp']]['scheme'], 'unknown')
        self.assertTrue(endpoints[info['wild']]['interfaces'])
        self.assertTrue(all(i['kind'] == 'loopback' for i in endpoints[info['local']]['interfaces']))
        local = Viewer(self)
        local.request(op='size', cols=160, rows=40)
        # Widen the sidebar to show all endpoint labels.
        local.input('\x1b[<0;28;6M\x1b[<32;100;6M\x1b[<0;100;6m')
        data = local.poll()['data']
        self.assertIn('Open Link ↗ 3', data)
        self.assertNotIn('http://localhost:', data)
        self.assertFalse(local.input('\x1b[<0;90;3M')['effects'])
        state = local.input('\x1b[<0;90;3m')
        self.assertFalse(state['effects'])
        data = state['data']
        self.assertIn(f';http://localhost:{info["wild"]}\x1b\\', data)
        self.assertIn(f'https://localhost:{info["secure"]}', data)
        self.assertIn('Links · Esc to close', data)
        self.assertFalse(local.input('\x1b[<0;52;16M')['effects'])
        opened = local.input('\x1b[<0;52;16m')['effects']
        self.assertEqual(opened, [{'open_url':f'http://localhost:{work["endpoints"][0]["port"]}'}])
        # A drag cancels both direct launches and opening the chooser.
        local.input('\x1b[<0;90;3M')
        local.input('\x1b[<32;95;3M')
        cancelled = local.input('\x1b[<0;90;3m')
        self.assertFalse(cancelled['effects'])
        self.assertNotIn('Links · Esc to close', cancelled['data'])
        local.input('\x1b[<0;90;3M\x1b[<0;90;3m')
        local.input('\x1b[B')
        self.assertEqual(len(local.input('\r')['effects']), 1)
        self.env['SSH_CONNECTION'] = '100.80.1.9 12345 100.80.1.2 22'
        remote = Viewer(self)
        remote.request(op='size', cols=160, rows=40)
        remote.input('\x1b[<0;28;6M\x1b[<32;100;6M\x1b[<0;100;6m')
        data = remote.poll()['data']
        self.assertFalse(remote.input('\x1b[<0;7;5M\x1b[<0;7;5m')['effects'])
        self.assertNotIn('http://localhost:', data)
        self.assertNotIn('https://localhost:', data)
        self.assertNotIn(f'localhost:{info["local"]}', data)
        self.assertNotIn(f':{info["udp"]}', data)
        choices = [i for i in endpoints[info['wild']]['interfaces'] if i['kind'] != 'loopback' and not i['address'].startswith(('169.254.', 'fe80:'))]
        if choices:
            rank = {'tailscale':0, 'vpn':1, 'network':2}
            preferred = min(choices, key=lambda i: (rank[i['kind']], i['ipv6']))
            self.assertIn(f'http://{preferred["address"]}:{info["wild"]}', data)
        # A second workspace must not inherit the first workspace's listeners.
        second = self.command('workspace.create', name='Other', cwd=self.temp.name)['workspace']
        self.command('pane.create', workspace=second, command='sleep 60')
        self.until(lambda: any(w['id'] == second for w in self.session()['ports']['workspaces']), timeout=15)
        self.assertFalse(next(w for w in self.session()['ports']['workspaces'] if w['id'] == second)['endpoints'])
        self.command('pane.close', target=pane)
        self.until(lambda: not any(w['endpoints'] for w in self.session()['ports']['workspaces']), timeout=15)

    def test_single_url_opens_directly(self):
        root = pathlib.Path(self.temp.name)
        script = root/'single.py'
        ready = root/'single-port'
        script.write_text("import http.server,sys\ns=http.server.HTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler)\nopen(sys.argv[1],'w').write(str(s.server_port))\ns.serve_forever()\n")
        self.new('exec ' + shlex.join([sys.executable, str(script), str(ready)]))
        self.until(ready.exists)
        port = int(ready.read_text())
        self.until(lambda: any(e.get('http_status') == 200 for w in self.session()['ports']['workspaces'] for e in w['endpoints']), timeout=20)
        viewer = Viewer(self)
        data = viewer.poll()['data']
        self.assertIn(f'http://localhost:{port}', data)
        self.assertNotIn('Open Link ↗ 1', data)
        state = viewer.input('\x1b[<0;14;3M\x1b[<0;14;3m')
        self.assertEqual(state['effects'], [{'open_url':f'http://localhost:{port}'}])
        self.assertNotIn('Links · Esc to close', state['data'])

    def test_get_probe_filters_http_errors_and_counts_foreground_workload(self):
        root = pathlib.Path(self.temp.name)
        script = root/'status_fixture.py'
        ready = root/'statuses.json'
        script.write_text(r'''import http.server, json, socket, threading, time, sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200); self.end_headers()
    def do_GET(self):
        self.send_response(self.server.status)
        if self.server.status == 302: self.send_header('Location', '/login')
        self.end_headers()
    def log_message(self, *args): pass
servers = []
ports = {}
for status in (200, 302, 401, 404, 500):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.status = status
    servers.append(server)
    ports[str(status)] = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
raw = socket.socket(); raw.bind(('127.0.0.1', 0)); raw.listen()
ports['raw'] = raw.getsockname()[1]
def reject():
    while True:
        conn, _ = raw.accept()
        with conn:
            try: conn.sendall(b'NOT HTTP\r\n')
            except OSError: pass
threading.Thread(target=reject, daemon=True).start()
with open(sys.argv[1], 'w') as f: json.dump(ports, f)
while True: time.sleep(1)
''')
        pane = self.new('exec ' + shlex.join([sys.executable, str(script), str(ready)]))
        self.until(ready.exists)
        ports = json.loads(ready.read_text())
        ws = self.session()['workspaces'][0]['id']
        def work():
            return next((w for w in self.session()['ports']['workspaces'] if w['id'] == ws), {})
        def complete():
            ends = work().get('endpoints', [])
            return len(ends) == 6 and all(e['probed_at'] > 0 for e in ends)
        self.until(complete, timeout=25)
        result = work()
        self.assertEqual(result['background'], 1)
        endpoints = {e['port']: e for e in result['endpoints']}
        for status in (200, 302, 401, 404, 500):
            self.assertEqual(endpoints[ports[str(status)]]['http_status'], status)
            self.assertEqual(endpoints[ports[str(status)]]['scheme'], 'http')
        self.assertEqual(endpoints[ports['raw']]['scheme'], 'unknown')
        viewer = Viewer(self)
        viewer.request(op='size', cols=160, rows=40)
        viewer.input('\x1b[<0;28;6M\x1b[<32;100;6M\x1b[<0;100;6m')
        data = viewer.poll()['data']
        self.assertIn('Open Link ↗ 2', data)
        data = viewer.input('\x1b[<0;90;3M\x1b[<0;90;3m')['data']
        for status in (200, 302):
            self.assertIn(f'http://localhost:{ports[str(status)]}', data)
        for status in ('401', '404', '500', 'raw'):
            self.assertNotIn(f'http://localhost:{ports[status]}', data)
            self.assertNotIn(f':{ports[status]}', data)
        # Cached scan results retain the error status, not just the scheme.
        time.sleep(3.2)
        cached = {e['port']: e for e in work()['endpoints']}
        self.assertEqual(cached[ports['401']]['http_status'], 401)
        self.assertNotIn(f'http://localhost:{ports["401"]}', viewer.poll()['data'])

if __name__ == '__main__': unittest.main()
