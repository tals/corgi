#!/usr/bin/env python3
"""Live child discovery, owned usage, and grouped hover through real viewers."""
import datetime, json, pathlib, time, unittest
import codex_titles as titles
import smoke
from viewer_client import Viewer

C = '01921234-1234-1234-1234-123456789abc'
D = '01931234-1234-1234-1234-123456789abc'
E = '01941234-1234-1234-1234-123456789abc'


class Children(titles.Titles):
    def setUp(self):
        super().setUp()
        self.viewers = []

    def tearDown(self):
        for viewer in self.viewers:
            viewer.close()
        super().tearDown()

    def conversation(self, session):
        return next((c for c in self.session()['conversations'] if c['agent']['session'] == session), None)

    def stamp(self):
        return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    def token_event(self, ordinal, total, last):
        def usage(values):
            return dict(input_tokens=values[0], cached_input_tokens=values[1], output_tokens=values[2])
        return dict(type='event_msg', ordinal=ordinal, timestamp=self.stamp(), payload=dict(
            type='token_count', info=dict(total_token_usage=usage(total), last_token_usage=usage(last))))

    def create_child(self, session, parent, role, name, *, boundary=True):
        path = pathlib.Path(self.temp.name, session + '.jsonl')
        stamp = self.stamp()
        metadata = dict(id=session, timestamp=stamp, source={'subagent': {'thread_spawn': {'parent_thread_id': parent}}})
        if boundary:
            metadata['subagent_history_start_ordinal'] = 10
        records = [dict(type='session_meta', ordinal=0, timestamp=stamp, payload=metadata),
                   self.token_event(2, (1000, 800, 100), (1000, 800, 100)),
                   dict(type='turn_context', ordinal=10, timestamp=stamp, payload={'turn_id': 'work-' + session}),
                   self.token_event(11, (1200, 850, 120), (100, 50, 20))]
        path.write_text(''.join(json.dumps(r) + '\n' for r in records))
        self.sim.set_turn(session, 'work-' + session, 'inProgress')
        self.sim.names[session] = name
        self.sim.paths[session] = str(path)
        self.children.append(dict(id=session, parentThreadId=parent, agentRole=role, name=name,
                                  path=str(path), status={'type': 'active', 'activeFlags': []}))
        return path

    def test_owned_catchup_nested_groups_and_live_hover(self):
        self.sim.set_turn(titles.A, 'parent-work', 'inProgress')
        path = self.create_child(C, titles.A, 'Explorer', 'Trace usage')
        self.create_child(D, titles.A, 'Explorer', 'Map sessions')
        self.create_child(E, C, 'Reviewer', 'Check accounting')
        self.until(lambda: all(self.conversation(s) and self.conversation(s)['usage']['known'] for s in (C, D, E)))
        root = self.conversation(titles.A)
        child = self.conversation(C)
        nested = self.conversation(E)
        self.assertEqual(child['parent'], root['id'])
        self.assertEqual(nested['parent'], child['id'])
        for session in (C, D, E):
            self.assertEqual(self.conversation(session)['usage']['tokens'], dict(input=100, cached_input=50, output=20))
        a, b = Viewer(self, 120, 40), Viewer(self, 120, 40)
        self.until(lambda: '↳2' in a.poll()['data'])
        rows = smoke.screen_text(a.state['data'], 120, 40)
        y = next(i for i, row in enumerate(rows) if '↳2' in row)
        x = rows[y].index('↳2')
        a.input(f'\x1b[<35;{x+1};{y+1}M')
        self.assertNotIn('Total · agent + 3 subagents', a.state['data'])
        time.sleep(.6)
        frame = a.poll()['data']
        self.assertIn('Own usage', frame)
        self.assertIn('Total · agent + 3 subagents', frame)
        self.assertIn('Explorer · 2', frame)
        self.assertIn('Reviewer · 1', frame)
        self.assertIn('240 tokens', frame)
        self.assertIn('120 tokens', frame)
        self.assertIn('100 in · 20 out', frame)
        self.assertIn('50 cached', frame)
        self.assertNotIn('Total · agent + 3 subagents', b.poll()['data'])
        screen = smoke.screen_text(frame, 120, 40)
        border = next(row for row in screen if '╭' in row and '╮' in row)
        self.assertEqual(len(border[border.index('╭'):border.index('╮')+1]), 88)
        self.assertIn('\x1b[1;38;2;148;226;213m', frame)
        pathlib.Path('/tmp/corgi-subagents-screen.txt').write_text('\n'.join(screen))
        pathlib.Path('/tmp/corgi-subagents-frame.json').write_text(json.dumps(dict(cols=120, rows=40, frame=frame)))
        # The agent name and activity open the same combined view as its badge.
        for hover_y in (y - 1, y):
            a.input(f'\x1b[<35;6;{hover_y+1}M')
            self.assertNotIn('Total · agent + 3 subagents', a.state['data'])
            time.sleep(.6)
            frame = a.poll()['data']
            self.assertIn('Own usage', frame)
            self.assertIn('Total · agent + 3 subagents', frame)
            self.assertIn('Explorer · 2', frame)
            self.assertIn('Reviewer · 1', frame)
        a.request(op='size', cols=64, rows=13)
        rows = smoke.screen_text(a.poll()['data'], 64, 13)
        small_y = next(i for i, row in enumerate(rows) if i > 6 and 'codex' in row)
        a.input(f'\x1b[<35;6;{small_y+1}M')
        time.sleep(.6)
        small = a.poll()['data']
        self.assertIn('Own usage', small)
        self.assertIn('+3 more', small)
        self.assertNotIn('Trace usage', small)
        a.request(op='size', cols=120, rows=40)
        # Repeated telemetry and re-observation through another pane do not charge twice.
        repeated = self.token_event(12, (1200, 850, 120), (100, 50, 20))
        with path.open('a') as f:
            f.write(json.dumps(repeated) + '\n')
            f.write(json.dumps(self.token_event(13, (1250, 860, 125), (50, 10, 5))) + '\n')
        self.until(lambda: self.conversation(C)['usage']['tokens']['input'] == 150)
        second_attachment = self.create_attachment(C)
        self.until(lambda: second_attachment.state()['session'] == C)
        self.assertEqual(len([c for c in self.session()['conversations'] if c['agent']['session'] == C]), 1)
        self.assertEqual(self.conversation(C)['usage']['tokens']['output'], 25)
        # Opening/watching a workspace cannot clear per-child spend.
        a.focus(self.pane)
        time.sleep(.3)
        self.assertEqual(self.conversation(C)['usage']['tokens']['input'], 150)
        a.input('x')
        self.assertNotIn('Total · agent + 3 subagents', a.state['data'])
        self.assertEqual(self.errors, [])

    def test_ambiguous_prefix_is_partial_and_failed_discovery_retains_children(self):
        path = self.create_child(C, titles.A, 'Explorer', 'Legacy child', boundary=False)
        self.until(lambda: self.conversation(C) and self.conversation(C)['usage']['partial'])
        self.assertEqual(self.conversation(C)['usage']['tokens']['input'], 0)
        with path.open('a') as f:
            f.write(json.dumps(self.token_event(12, (1230, 860, 125), (30, 10, 5))) + '\n')
        self.until(lambda: self.conversation(C)['usage']['tokens']['input'] == 30)
        self.create_child(D, titles.A, 'Explorer', 'Second child')
        self.create_child(E, titles.A, 'Reviewer', 'Third child')
        self.until(lambda: self.conversation(E) is not None)
        self.child_error = True
        self.until(lambda:self.conversation(titles.A)['children_observed_at']==0)
        self.assertIsNotNone(self.conversation(C))
        self.assertEqual(self.conversation(C)['usage']['tokens']['input'], 30)
        viewer=Viewer(self,120,40)
        rows=smoke.screen_text(viewer.poll()['data'],120,40)
        y=next(i for i,row in enumerate(rows) if i>20 and 'codex' in row)
        viewer.input(f'\x1b[<35;6;{y+1}M')
        time.sleep(.6)
        frame=viewer.poll()['data']
        self.assertIn('Own usage',frame)
        for text in ('No subagents','Updating child details','Total · agent','Explorer','Reviewer','↳'):
            self.assertNotIn(text,frame)
        self.child_error = False
        self.until(lambda:self.conversation(titles.A)['children_observed_at']>0)
        self.assertIn('Explorer',viewer.poll()['data'])
        self.sim.set_turn(C, 'work-' + C, 'completed')
        for child in self.children:
            if child['id'] == C:
                child['status']['type'] = 'idle'
        self.until(lambda: self.conversation(C)['agent']['state'] == 'idle')
        self.assertEqual(self.conversation(C)['usage']['tokens']['input'], 30)
        self.assertEqual(self.errors, [])


class NativeUsage(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    raw_rpc = smoke.Runtime.raw_rpc
    command = smoke.Runtime.command
    until = smoke.Runtime.until
    session = smoke.Runtime.session
    def setUp(self):
        self.viewers = []
        smoke.Runtime.setUp(self)

    def tearDown(self):
        for viewer in self.viewers:
            viewer.close()
        smoke.Runtime.tearDown(self)

    def test_native_agent_hover_shows_own_usage_without_children(self):
        self.command('pane.create', workspace=1, command='sleep 60')
        native = self.rpc(op='native.start', provider='codex', cwd=self.temp.name)['session']
        for method, params in (
            ('thread/started', {'thread': {'id': 'solo', 'name': 'Solo agent'}}),
            ('turn/started', {'threadId': 'solo', 'turn': {'id': 'work'}}),
            ('item/started', {'threadId': 'solo', 'turnId': 'work', 'item': {'id': 'tool-1', 'type': 'commandExecution'}}),
            ('thread/tokenUsage/updated', {'threadId': 'solo', 'tokenUsage': {
                'total': {'inputTokens': 12345, 'cachedInputTokens': 8100, 'outputTokens': 2345},
                'last': {'inputTokens': 12345, 'cachedInputTokens': 8100, 'outputTokens': 2345}}}),
        ):
            self.rpc(op='native.send', session=native, message={'id': 1, 'method': 'test/event',
                     'params': {'method': method, 'params': params}})
        self.until(lambda: any(c['agent']['session'] == 'solo' and c['usage']['known'] for c in self.session()['conversations']))
        a, b = Viewer(self, 100, 30), Viewer(self, 100, 30)
        rows = smoke.screen_text(a.poll()['data'], 100, 30)
        y = next(i for i, row in enumerate(rows) if i > 15 and 'codex' in row)
        for hover_y in (y, y + 1):
            a.input(f'\x1b[<35;6;{hover_y+1}M')
            self.assertNotIn('Own usage', a.state['data'])
            time.sleep(.6)
            frame = a.poll()['data']
            self.assertIn('Own usage', frame)
            self.assertIn('Running a tool', frame)
            self.assertNotIn('Activity not reported yet', frame)
            self.assertIn('14.7k tokens', frame)
            self.assertIn('12.3k input', frame)
            self.assertIn('2.3k output', frame)
            self.assertIn('8.1k cached', frame)
            self.assertIn('14.7k recent', frame)
            self.assertIn('\x1b[38;2;137;180;250m', frame)
            self.assertIn('\x1b[38;2;203;166;247m', frame)
            self.assertNotIn('No subagents', frame)
            self.assertNotIn('Updating child details', frame)
            self.assertNotIn('Own usage', b.poll()['data'])
        pathlib.Path('/tmp/corgi-agent-hover-screen.txt').write_text('\n'.join(smoke.screen_text(frame, 100, 30)))
        pathlib.Path('/tmp/corgi-agent-hover-frame.json').write_text(json.dumps(dict(cols=100, rows=30, frame=frame)))
        a.input('\x1b[<35;40;10M')
        self.assertNotIn('Own usage', a.poll()['data'])
        a.request(op='size', cols=64, rows=13)
        rows = smoke.screen_text(a.poll()['data'], 64, 13)
        y = next(i for i, row in enumerate(rows) if i > 6 and 'codex' in row)
        a.input(f'\x1b[<35;6;{y+1}M')
        time.sleep(.6)
        self.assertIn('Own usage', a.poll()['data'])
        self.assertIn('14.7k tokens', a.state['data'])
        a.input('x')
        self.assertNotIn('Own usage', a.state['data'])

    def test_reload_baselines_replayed_native_usage_but_counts_new_requests(self):
        self.command('pane.create', workspace=1, command='sleep 60')
        native = self.rpc(op='native.start', provider='codex', cwd=self.temp.name)['session']

        def send(method, params):
            self.rpc(op='native.send', session=native, message={'id': 1, 'method': 'test/event',
                     'params': {'method': method, 'params': params}})

        def actor():
            return next(c for c in self.session()['conversations'] if c['agent']['session'] == 'native-child')

        send('turn/started', {'threadId': 'native-child', 'turn': {'id': 'work'}})
        self.until(lambda: any(c['agent']['session'] == 'native-child' for c in self.session()['conversations']))
        first = {'total': {'inputTokens': 100, 'outputTokens': 20},
                 'last': {'inputTokens': 100, 'outputTokens': 20}}
        send('thread/tokenUsage/updated', {'threadId': 'native-child', 'tokenUsage': first})
        self.until(lambda: actor()['usage']['tokens']['input'] == 100)
        self.rpc(op='server.reload', protocol=1, executable=smoke.EXE)
        restored = actor()
        self.assertFalse(restored['usage']['known'])
        self.assertEqual(restored['usage']['tokens']['input'], 0)
        send('thread/tokenUsage/updated', {'threadId': 'native-child', 'tokenUsage': first})
        self.until(lambda: actor()['observed_at'] > restored['observed_at'])
        self.assertEqual(actor()['usage']['tokens']['input'], 0)
        self.assertTrue(actor()['usage']['partial'])
        send('thread/tokenUsage/updated', {'threadId': 'native-child', 'tokenUsage': {
            'total': {'inputTokens': 130, 'outputTokens': 25},
            'last': {'inputTokens': 30, 'outputTokens': 5}}})
        self.until(lambda: actor()['usage']['tokens']['input'] == 30)
        self.assertEqual(actor()['usage']['tokens']['output'], 5)


if __name__ == '__main__':
    unittest.main()
