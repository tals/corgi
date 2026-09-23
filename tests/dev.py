#!/usr/bin/env python3
"""Default developer launch against an isolated daemon and real terminal client."""
import fcntl, hashlib, os, pathlib, select, struct, subprocess, termios, time, unittest
import smoke

# Isolate Corgi HOME while retaining the compiler dependency cache for go.sh.
os.environ.setdefault('ZIG_GLOBAL_CACHE_DIR', str(pathlib.Path(os.environ.get('XDG_CACHE_HOME', pathlib.Path.home() / '.cache')) / 'zig'))

class Dev(unittest.TestCase):
    setUp = smoke.Runtime.setUp
    tearDown = smoke.Runtime.tearDown
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    command=smoke.Runtime.command
    raw_rpc = smoke.Runtime.raw_rpc
    session = smoke.Runtime.session
    until = smoke.Runtime.until

    def launch(self):
        self.env.pop('CORGI_PANE', None)
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        self.proc = subprocess.Popen([str(smoke.ROOT / 'go.sh')], env=self.env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        return self.wait_viewer()

    def wait_viewer(self, old=None):
        output = bytearray()
        end = time.monotonic() + 15
        while time.monotonic() < end:
            if select.select([self.master], [], [], .03)[0]:
                try: output.extend(os.read(self.master, 65536))
                except OSError: break
            viewers = self.rpc(op='viewer.list')['viewers']
            if len(viewers) == 1 and viewers[0]['id'] != old and viewers[0]['pane']:
                return viewers[0]
        self.fail('viewer did not attach/relaunch: '+output.decode(errors='replace')[-4000:])

    def test_unchanged_daemon_and_nested_client_relaunch(self):
        before = self.rpc(op='hello', protocol=1)
        with open(smoke.EXE, 'rb') as binary:
            self.assertEqual(before['build_id'], hashlib.sha256(binary.read()).hexdigest())
        viewer = self.launch()
        panes = [(p['id'], p['pid']) for p in self.session()['panes']]
        # Run the command in the actual pane shell, so the runtime supplies CORGI_PANE.
        self.command('pane.input', data=str(smoke.ROOT / 'go.sh')+'\r', target=viewer['pane'])
        self.wait_viewer(viewer['id'])
        self.assertEqual(self.rpc(op='hello', protocol=1)['server_pid'], before['server_pid'])
        self.assertEqual([(p['id'], p['pid']) for p in self.session()['panes']], panes)
        os.write(self.master, b'\x02q')
        end = time.monotonic() + 5
        while self.proc.poll() is None and time.monotonic() < end:
            if select.select([self.master], [], [], .05)[0]:
                try: os.read(self.master, 65536)
                except OSError: break
        self.assertEqual(self.proc.wait(timeout=1), 0)

    @unittest.skipUnless(os.environ.get('CORGI_OLD_EXE'), 'requires another build')
    def test_changed_daemon_reloads_and_keeps_panes(self):
        self.command('pane.create', workspace=self.session()['workspaces'][0]['id'], command='sleep 60')
        panes = [(p['id'], p['pid']) for p in self.session()['panes']]
        self.rpc(op='server.reload', protocol=1, executable=os.environ['CORGI_OLD_EXE'])
        old = self.rpc(op='hello', protocol=1)
        self.launch()
        new = self.rpc(op='hello', protocol=1)
        self.assertNotEqual(old['build_id'], new['build_id'])
        self.assertNotEqual(old['server_pid'], new['server_pid'])
        self.assertEqual([(p['id'], p['pid']) for p in self.session()['panes']], panes)


if __name__ == '__main__': unittest.main()
