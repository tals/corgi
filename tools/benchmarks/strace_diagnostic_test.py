"""Fixed trace fixtures; no strace launch or ptrace permission is needed."""
import json
from pathlib import Path
import tempfile
import unittest

from strace_diagnostic import parse_lines, summarize


class TraceParsing(unittest.TestCase):
    def test_resumed_call_keeps_entry_time_and_decodes_errors(self):
        result = list(parse_lines([
            '99.500000 read(5,  <unfinished ...>\n',
            '100.100000 <... read resumed>"", 64) = -1 EAGAIN (Resource temporarily unavailable) <0.600000>\n',
            '100.200000 --- SIGCHLD {si_signo=SIGCHLD} ---\n',
            '100.300000 write(1, "fake) = -1 ERRNO", 16) = 16 <0.000010>\n',
            '100.400000 futex(0x123, FUTEX_WAIT, 0, NULL) = ? ERESTARTSYS (To be restarted) <0.100000>\n',
            '100.500000 recvfrom(4,  <unfinished ...>\n',
        ]))
        self.assertEqual(len(result), 4)
        self.assertEqual((result[0]['at'], result[0]['name'], result[0]['errno']), (99.5, 'read', 'EAGAIN'))
        self.assertEqual(result[1]['result'], '16')
        self.assertIsNone(result[1]['errno'])
        self.assertEqual(result[2]['errno'], 'ERESTARTSYS')
        self.assertTrue(result[3]['incomplete'])

    def test_phase_filter_and_thread_ancestry_exclude_providers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root/'run'/'corgi-node0-try1'
            run.mkdir(parents=True)
            traces = root/'traces'
            traces.mkdir()
            (root/'run/comparison.json').write_text(json.dumps({'attempts': [{'name': run.name, 'accepted': True}]}))
            (run/'results.json').write_text(json.dumps({'daemon': 100, 'viewer': 300, 'results': [{
                'name': 'streaming-agents-viewer', 'started_at': '1970-01-01T00:01:40Z', 'seconds': 2,
            }]}))
            (run/'host.json').write_text(json.dumps({'samples': [{
                'daemon_threads': {'100': {'name': 'corgi'}, '101': {'name': 'corgi-fd-ready'}},
                'viewer_threads': {'300': {'name': 'corgi'}},
            }]}))
            (traces/'daemon.100').write_text(
                '99.500000 read(5,  <unfinished ...>\n'
                '100.100000 <... read resumed>"", 64) = 0 <0.600000>\n'
                '100.200000 clone(child_stack=0, flags=CLONE_VM|CLONE_THREAD) = 102 <0.000020>\n'
                '100.300000 clone(child_stack=0, flags=SIGCHLD) = 200 <0.000020>\n'
                '100.500000 read(5, "", 64) = -1 EAGAIN (Resource temporarily unavailable) <0.000001>\n'
                '101.500000 write(4, "x", 1) = 1 <0.000002>\n'
                '102.000000 read(5, "", 64) = 0 <0.000001>\n')
            (traces/'daemon.101').write_text('100.500000 sendto(8, "x", 1, 0, NULL, 0) = 1 <0.000001>\n')
            (traces/'daemon.102').write_text('101.500000 futex(4, FUTEX_WAIT, 0, NULL <unfinished ...>\n')
            (traces/'daemon.200').write_text('100.500000 write(1, "provider", 8) = 8 <0.000001>\n')
            (traces/'viewer.300').write_text('100.500000 epoll_wait(5, [], 16, 0) = 0 <0.000001>\n')
            report = summarize(root)['reports'][0]
            daemon = report['roles']['daemon']
            self.assertTrue(daemon['trace_complete'])
            self.assertEqual(daemon['excluded_unmatched_logs'], 1)
            threads = {t['tid']: t for t in daemon['threads']}
            self.assertEqual(set(threads), {100, 101, 102})
            self.assertEqual(threads[100]['counts'], {'clone': 2, 'read': 1, 'write': 1})
            self.assertEqual(threads[100]['errors'], {'read': {'EAGAIN': 1}})
            self.assertEqual(threads[101]['names'], ['corgi-fd-ready'])
            self.assertEqual(threads[102]['membership'], 'CLONE_THREAD ancestry')
            self.assertEqual(threads[102]['incomplete_calls'], 1)
            (traces/'viewer.300').unlink()
            self.assertFalse(summarize(root)['reports'][0]['roles']['viewer']['trace_complete'])


if __name__ == '__main__':
    unittest.main()
