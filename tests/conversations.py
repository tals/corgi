#!/usr/bin/env python3
"""Conversation ownership through actual hooks, provider observation and panes."""
import datetime
import json
import pathlib
import time
import unittest

import codex_titles
import smoke

A = codex_titles.A
B = codex_titles.B


class RuntimeAssertions(unittest.TestCase):
    # Reuse runtime plumbing without inheriting the smoke suite's test methods.
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    raw_rpc = smoke.Runtime.raw_rpc
    command = smoke.Runtime.command
    until = smoke.Runtime.until
    session = smoke.Runtime.session
    panes = smoke.Runtime.panes

    def actor(self, session, provider='codex'):
        return next(actor for actor in self.session()['conversations']
                    if actor['agent']['provider'] == provider and actor['agent']['session'] == session)

    def pane_snapshot(self, pane):
        return next(item for item in self.session()['panes'] if item['id'] == pane)


class CodexConversations(RuntimeAssertions):
    setUp = codex_titles.Titles.setUp
    tearDown = codex_titles.Titles.tearDown
    create_attachment = codex_titles.Titles.create_attachment
    state = codex_titles.Titles.state
    turns = codex_titles.observer_field('turns')
    errors = codex_titles.observer_field('errors')

    def test_background_commands_follow_provider_inventory_and_session(self):
        self.sim.background_tasks = {A: [
            {'processId': 'task-1', 'command': 'bun test'},
            {'processId': 'task-2', 'command': 'bun run dev'},
        ]}
        self.until(lambda: len(self.actor(A)['background_tasks']['items']) == 2)
        tasks = self.actor(A)['background_tasks']
        self.assertTrue(tasks['live'])
        self.assertEqual([t['group'] for t in tasks['items']], ['tests', 'servers'])
        self.switch(B)
        self.assertEqual(self.actor(B)['background_tasks']['items'], [])
        self.sim.background_tasks[A] = []
        self.switch(A)
        self.until(lambda: self.actor(A)['background_tasks']['items'] == [])

    def finish_a(self):
        self.sim.set_turn(A, 'first-turn', 'inProgress')
        self.until(lambda: self.state()['state'] == 'working')
        self.sim.set_turn(A, 'first-turn', 'completed')
        self.until(lambda: self.state()['completed'] == 1)

    def switch(self, session):
        self.attachment.select(session)
        self.until(lambda: self.state()['session'] == session)

    def test_switch_preserves_each_conversations_receipts(self):
        self.finish_a()
        first = self.actor(A)
        self.assertGreater(first['id'], 0)
        self.assertEqual(first['attachments'], 1)
        self.switch(B)
        self.assertEqual(self.state()['completed'], 0)
        self.assertFalse(self.state()['unread'])
        retained = self.actor(A)
        self.assertEqual(retained['id'], first['id'])
        self.assertEqual(retained['attachments'], 0)
        self.assertEqual(retained['agent']['observation']['completed'], 1)
        self.assertEqual(retained['agent']['observation']['read'], 0)
        self.assertNotEqual(self.actor(B)['id'], first['id'])
        self.switch(A)
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['conversation'], first['id'])
        self.assertEqual(self.state()['completed'], 1)
        self.assertTrue(self.state()['unread'])

    def test_two_attachments_share_completion_and_acknowledgement(self):
        second = self.create_attachment(A)
        self.until(lambda: second.state()['session'] == A)
        self.assertEqual(self.actor(A)['attachments'], 2)
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['conversation'],
                         self.pane_snapshot(second.pane)['agent']['conversation'])
        self.finish_a()
        self.until(lambda: second.state()['completed'] == 1)
        self.assertEqual(self.actor(A)['agent']['observation']['completed'], 1)
        self.assertTrue(second.state()['unread'])
        self.rpc(op='pane.acknowledge', protocol=1, pane=second.pane, session=A, through=1)
        self.until(lambda: not self.state()['unread'] and not second.state()['unread'])
        self.assertEqual(self.actor(A)['agent']['observation']['read'], 1)
        self.command('pane.close', target=second.pane)
        self.assertEqual(self.actor(A)['attachments'], 1)
        self.assertEqual(self.state()['completed'], 1)

    def test_old_attachment_acknowledgement_cannot_read_another_conversation(self):
        self.finish_a()
        self.switch(B)
        result = self.raw_rpc(op='pane.acknowledge', protocol=1, pane=self.pane, session=A, through=1)
        self.assertEqual(result['err'], 'StaleAcknowledgement')
        self.assertEqual(self.actor(A)['agent']['observation']['read'], 0)
        self.assertEqual(self.actor(B)['agent']['observation']['completed'], 0)

    def test_unselected_working_conversation_can_finish_in_background(self):
        self.sim.set_turn(A, 'background', 'inProgress')
        self.until(lambda: self.state()['state'] == 'working')
        self.switch(B)
        self.assertEqual(self.actor(A)['attachments'], 0)
        self.sim.set_turn(A, 'background', 'completed')
        self.until(lambda: self.actor(A)['agent']['observation']['completed'] == 1)
        self.assertEqual(self.state()['session'], B)
        self.assertEqual(self.state()['completed'], 0)
        self.assertEqual(self.state()['state'], 'idle')
        self.switch(A)
        self.assertTrue(self.state()['unread'])

    def test_aba_selection_discards_held_old_observation(self):
        self.sim.set_turn(A, 'before-switch', 'inProgress')
        self.until(lambda: self.state()['state'] == 'working')
        with self.sim.hold_turn(A, 'before-switch', 'completed') as old:
            old.wait()
            self.assertEqual(old.response['result']['data'][0]['status'], 'completed')
            before = self.pane_snapshot(self.pane)['binding']
            self.attachment.select(B)
            self.until(lambda: self.pane_snapshot(self.pane)['binding'] > before)
            middle = self.pane_snapshot(self.pane)['binding']
            self.attachment.select(A)
            self.until(lambda: self.pane_snapshot(self.pane)['binding'] > middle)
            self.sim.set_turn(A, 'after-switch', 'inProgress')
            with self.sim.hold('thread/turns/list', A) as fresh:
                old.release()
                fresh.wait()
                self.assertEqual(fresh.response['result']['data'][0]['id'], 'after-switch')
                self.assertEqual(self.actor(A)['agent']['observation']['completed'], 0)
            self.until(lambda: self.state()['session'] == A and self.state()['state'] == 'working')
            self.assertEqual(self.state()['completed'], 0)

    def test_reload_preserves_detached_actor_and_shared_binding(self):
        self.finish_a()
        second = self.create_attachment(A)
        self.until(lambda: second.state()['session'] == A)
        self.switch(B)
        original = {session: self.actor(session)['id'] for session in (A, B)}
        self.rpc(op='server.reload', protocol=1, executable=smoke.EXE)
        self.assertEqual({session: self.actor(session)['id'] for session in (A, B)}, original)
        self.assertEqual(self.state()['session'], B)
        self.assertEqual(self.state()['completed'], 0)
        self.assertEqual(second.state()['session'], A)
        self.assertEqual(second.state()['completed'], 1)
        self.rpc(op='pane.acknowledge', protocol=1, pane=second.pane, session=A, through=1)
        self.switch(A)
        self.assertFalse(self.state()['unread'])

    def test_cold_recovery_preserves_unselected_completion(self):
        self.finish_a()
        self.switch(B)
        actor_id = self.actor(A)['id']
        self.run_cli('checkpoint')
        self.run_cli('shutdown')
        self.until(lambda: not pathlib.Path(self.path).exists())
        self.run_cli('start')
        retained = self.actor(A)
        self.assertEqual(retained['id'], actor_id)
        self.assertEqual(retained['agent']['observation']['completed'], 1)
        self.assertEqual(retained['agent']['observation']['read'], 0)
        self.assertEqual(self.state()['session'], B)
        self.assertEqual(self.state()['completed'], 0)


class ClaudeConversations(RuntimeAssertions):
    def test_shell_task_descriptions_are_last_reported_and_empty_census_clears(self):
        self.hook('tasks', 'SessionStart')
        self.hook('tasks', 'UserPromptSubmit')
        self.hook('tasks', 'Stop', background_tasks=[
            {'id': 'shell-1', 'type': 'shell', 'status': 'running',
             'description': 'Run parser tests', 'command': 'bun test'},
            {'id': 'agent-1', 'type': 'subagent', 'description': 'Review'},
        ])
        tasks = self.actor('tasks', 'claude')['background_tasks']
        self.assertFalse(tasks['live'])
        self.assertEqual(tasks['items'], [{'id': 'shell-1', 'label': 'Run parser tests', 'group': 'tests'}])
        self.hook('tasks', 'UserPromptSubmit')
        self.hook('tasks', 'Stop', background_tasks=[])
        self.assertEqual(self.actor('tasks', 'claude')['background_tasks']['items'], [])

    def setUp(self):
        smoke.Runtime.setUp(self)
        self.pane = self.command('pane.create', workspace=1, command='sleep 60')['pane']
        self.seq = time.time_ns() // 1000
        self.logs = {}

    tearDown = smoke.Runtime.tearDown

    def log(self, session):
        if session not in self.logs:
            self.logs[session] = pathlib.Path(self.temp.name, session + '.jsonl')
            self.logs[session].write_text('')
        return self.logs[session]

    def hook(self, session, event, *, pane=None, background=False, **extra):
        self.seq = max(self.seq + 1, time.time_ns() // 1000)
        return self.rpc(op='hook', pane=self.pane if pane is None else pane, provider='claude', seq=self.seq, background=background, event={
            'hook_event_name': event, 'session_id': session,
            'transcript_path': str(self.log(session)), **extra})

    def record(self, session, **fields):
        with self.log(session).open('a') as log:
            log.write(json.dumps({'sessionId': session, **fields}) + '\n')

    def finish(self, session):
        self.hook(session, 'Stop')
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        with self.logs[session].open('a') as log:
            log.write(json.dumps({'type': 'system', 'subtype': 'turn_duration', 'sessionId': session, 'timestamp': stamp}) + '\n')

    def test_background_hook_updates_known_actor_without_changing_selection(self):
        self.hook('claude-a', 'SessionStart')
        self.hook('claude-a', 'UserPromptSubmit')
        self.hook('claude-b', 'SessionStart')
        self.hook('claude-b', 'UserPromptSubmit')
        self.hook('claude-b', 'PermissionRequest')
        self.finish('claude-a')
        self.until(lambda: self.actor('claude-a', 'claude')['agent']['observation']['completed'] == 1)
        selected = self.pane_snapshot(self.pane)['agent']
        self.assertEqual(selected['session'], 'claude-b')
        self.assertEqual(selected['state'], 'blocked')
        self.assertEqual(selected['attention'], 'needs_input')
        self.assertEqual(selected['observation']['completed'], 0)
        self.assertEqual(self.actor('claude-a', 'claude')['attachments'], 0)

    def test_transcript_titles_name_claude_conversations(self):
        self.hook('titled', 'SessionStart')
        self.record('titled', type='ai-title', aiTitle='Generated title')
        self.until(lambda: self.pane_snapshot(self.pane)['agent']['name'] == 'Generated title')
        self.record('titled', type='agent-name', agentName='Chosen name')
        self.record('titled', type='ai-title', aiTitle='Later generated title')
        self.until(lambda: self.pane_snapshot(self.pane)['agent']['name'] == 'Chosen name')

    def test_claude_activity_follows_tools_and_text_updates(self):
        self.hook('active', 'SessionStart')
        self.hook('active', 'UserPromptSubmit')
        self.hook('active', 'PreToolUse', tool_name='Read', tool_input={'file_path': '/repo/src/server.zig'})
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['activity'], 'Reading server.zig')
        time.sleep(0.01)
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        self.record('active', type='assistant', timestamp=stamp, message={'content': [{'type': 'text', 'text': 'Tracing the hook router'}]})
        self.until(lambda: self.pane_snapshot(self.pane)['agent']['activity'] == 'Tracing the hook router')
        self.hook('active', 'PreToolUse', tool_name='Bash', tool_input={'command': 'zig build test', 'description': 'Run unit tests'})
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['activity'], 'Run unit tests')
        # The already-read text update is older than this hook and must not return.
        time.sleep(0.6)
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['activity'], 'Run unit tests')

    def test_background_daemon_hooks_never_select_by_inherited_pane(self):
        self.hook('foreground', 'SessionStart')
        self.hook('foreground', 'UserPromptSubmit')
        # Daemon sessions inherit CORGI_PANE from whichever pane spawned it.
        self.hook('unrelated', 'SessionStart', background=True)
        self.hook('unrelated', 'UserPromptSubmit', background=True)
        selected = self.pane_snapshot(self.pane)['agent']
        self.assertEqual(selected['session'], 'foreground')
        self.assertEqual(selected['state'], 'working')
        self.assertFalse(any(actor['agent']['session'] == 'unrelated' for actor in self.session()['conversations']))

    def test_backgrounded_conversation_follows_its_continuation(self):
        self.hook('original', 'SessionStart')
        self.hook('original', 'UserPromptSubmit')
        self.record('continued', type='ai-title', aiTitle='Backgrounded work')
        self.record('original', type='continued-in', continuedInSessionId='continued')
        self.until(lambda: self.pane_snapshot(self.pane)['agent']['session'] == 'continued')
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['state'], 'working')
        self.until(lambda: self.pane_snapshot(self.pane)['agent']['name'] == 'Backgrounded work')
        self.assertEqual(self.actor('original', 'claude')['agent']['state'], 'done')
        self.hook('continued', 'Notification', background=True, notification_type='permission_prompt')
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['state'], 'blocked')

    def test_second_attachment_does_not_reset_existing_conversation(self):
        self.hook('shared-claude', 'SessionStart')
        self.hook('shared-claude', 'UserPromptSubmit')
        self.finish('shared-claude')
        self.until(lambda: self.actor('shared-claude', 'claude')['agent']['observation']['completed'] == 1)
        second = self.command('pane.create', workspace=1, command='sleep 60')['pane']
        self.hook('shared-claude', 'SessionStart', pane=second)
        actor = self.actor('shared-claude', 'claude')
        self.assertEqual(actor['attachments'], 2)
        self.assertEqual(actor['agent']['observation']['completed'], 1)
        self.rpc(op='pane.acknowledge', protocol=1, pane=second, session='shared-claude', through=1)
        self.assertEqual(self.pane_snapshot(self.pane)['agent']['observation']['read'], 1)
        self.assertEqual(self.pane_snapshot(second)['agent']['observation']['read'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
