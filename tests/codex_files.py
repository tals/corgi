#!/usr/bin/env python3
"""Hook identity and local files supply metadata without an app-server socket."""
import json
import os
import pathlib
import shlex
import tempfile
import time
import unittest
from unittest.mock import patch

import activity_summary
import codex_titles
import smoke
from provider_sim import CodexObserver, write_codex_terminal


class Files(unittest.TestCase):
    run_cli = smoke.Runtime.run_cli
    rpc = smoke.Runtime.rpc
    raw_rpc = smoke.Runtime.raw_rpc
    command = smoke.Runtime.command
    until = smoke.Runtime.until
    session = smoke.Runtime.session
    panes = smoke.Runtime.panes
    create_attachment = codex_titles.Titles.create_attachment
    append_record = activity_summary.Summaries.append_record
    tools = activity_summary.Summaries.tools
    finish_tool = activity_summary.Summaries.finish_tool
    calls = activity_summary.Summaries.calls

    def state(self):
        pane = next(p for p in self.panes() if p['id'] == self.pane)
        return {**pane, 'name': pane['agent']['name']}

    def setUp(self):
        self.backend_dir = tempfile.TemporaryDirectory(prefix='corgi-files-')
        root = pathlib.Path(self.backend_dir.name)
        self.log = root / 'calls.jsonl'
        program = pathlib.Path(__file__).with_name('inference_harness.py').resolve()
        control = root / 'control.json'
        control.write_text(json.dumps({'label': 'Tracing pane focus'}))
        with patch.dict(os.environ, {'CORGI_INFERENCE_PROVIDER': 'codex', 'CORGI_INFERENCE_BIN': str(program), 'CORGI_INFERENCE_TEST_LOG': str(self.log), 'CORGI_INFERENCE_TEST_CONTROL': str(control)}):
            smoke.Runtime.setUp(self)
        self.sim = None
        self.attachments = []
        self.attachment = self.create_attachment(codex_titles.A)
        self.pane = self.attachment.pane
        self.transcript = root / 'rollout.jsonl'
        self.transcript.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': codex_titles.A}}) + '\n')
        self.index = pathlib.Path(self.env['CODEX_HOME'], 'session_index.jsonl')
        self.index.parent.mkdir(parents=True, exist_ok=True)
        self.rename('Investigate missing session details')
        self.tool_index = 0
        self.hook('SessionStart')
        self.until(lambda: self.state()['name'] == 'Investigate missing session details')

    def tearDown(self):
        if self.sim:
            self.sim.close()
        try:
            smoke.Runtime.tearDown(self)
        finally:
            self.backend_dir.cleanup()

    def rename(self, name, session=codex_titles.A):
        with self.index.open('a') as f:
            f.write(json.dumps({'id': session, 'thread_name': name}) + '\n')

    def hook(self, event, turn='current', session=codex_titles.A):
        return self.rpc(op='hook', pane=self.pane, provider='codex', seq=time.time_ns() // 1000,
                        event={'hook_event_name': event, 'session_id': session, 'turn_id': turn,
                               'transcript_path': str(self.transcript)})

    def start(self):
        self.hook('UserPromptSubmit')
        self.append_record('event_msg', {'type': 'task_started', 'turn_id': 'current'})
        self.append_record('response_item', {'type': 'message', 'role': 'assistant', 'phase': 'commentary',
                                           'content': [{'type': 'output_text', 'text': 'Tracing focus from the transcript.'}]})
        self.tools(3)
        self.until(lambda: self.state()['activity'] == 'Tracing pane focus')

    def test_no_socket_name_summary_rename_and_completion(self):
        self.assertFalse(pathlib.Path(self.env['CODEX_HOME'], 'app-server-control/app-server-control.sock').exists())
        self.start()
        self.assertIn('Tracing focus from the transcript', json.loads(self.calls()[0])['evidence'])
        self.assertIn('rg focus src', json.loads(self.calls()[0])['evidence'])
        self.rename('Renamed session')
        self.until(lambda: self.state()['name'] == 'Renamed session')
        self.assertEqual(self.state()['completed'], 0)
        self.hook('Stop')
        self.append_record('event_msg', {'type': 'task_complete', 'turn_id': 'current'})
        self.until(lambda: self.state()['completed'] == 1)
        time.sleep(.7)
        self.assertEqual(self.state()['completed'], 1)

    def test_app_server_preferred_then_files_resume(self):
        self.start()
        self.sim = CodexObserver(self.env['CODEX_HOME'], [codex_titles.A])
        self.sim.paths[codex_titles.A] = str(self.transcript)
        self.sim.names[codex_titles.A] = 'App server name'
        self.sim.set_turn(codex_titles.A, 'current', 'inProgress')
        self.until(lambda: self.state()['source'] == 'protocol')
        self.until(lambda: self.state()['name'] != 'Investigate missing session details')
        protocol_name = self.state()['name']
        self.assertEqual(self.state()['activity'], 'Tracing pane focus')
        self.rename('File rename while connected')
        time.sleep(1.3)
        self.assertEqual(self.state()['name'], protocol_name)
        self.sim.close()
        self.sim = None
        self.hook('PreToolUse')
        self.until(lambda: self.state()['name'] == 'File rename while connected', timeout=9)
        self.assertEqual(self.state()['activity'], 'Tracing pane focus')
        self.assertEqual(self.state()['completed'], 0)

    def test_missing_or_wrong_transcript_still_supplies_name(self):
        replacement = self.transcript.with_suffix('.replacement')
        replacement.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': codex_titles.B}}) + '\n')
        replacement.replace(self.transcript)
        self.hook('UserPromptSubmit')
        self.append_record('event_msg', {'type': 'task_started', 'turn_id': 'current'})
        self.tools(3)
        self.rename('Metadata survives invalid transcript')
        self.until(lambda: self.state()['name'] == 'Metadata survives invalid transcript')
        self.assertEqual(self.calls(), [])
        self.transcript.unlink()
        self.rename('Metadata survives missing transcript')
        self.until(lambda: self.state()['name'] == 'Metadata survives missing transcript')
        self.assertEqual(self.state()['completed'], 0)

    def test_session_switch_keeps_names_and_evidence_separate(self):
        self.start()
        self.rename('Second conversation', session=codex_titles.B)
        self.hook('SessionStart', turn='second', session=codex_titles.B)
        self.until(lambda: self.state()['session'] == codex_titles.B and self.state()['name'] == 'Second conversation')
        self.hook('UserPromptSubmit', turn='second', session=codex_titles.B)
        # The hook deliberately supplies A's transcript; it must not seed B.
        self.tools(3)
        time.sleep(1)
        self.assertEqual(self.state()['activity'], '')
        self.assertEqual(self.state()['completed'], 0)
        self.hook('SessionStart')
        self.until(lambda: self.state()['session'] == codex_titles.A)
        self.assertEqual(self.state()['name'], 'Investigate missing session details')
        self.assertEqual(self.state()['activity'], 'Tracing pane focus')

    def test_exit_and_resume_restores_sidebar_name_before_any_hook(self):
        from viewers import Viewer
        self.command('pane.close', target=self.pane)
        self.pane = self.command('pane.create', workspace=1, command='/bin/sh')['pane']
        fake = write_codex_terminal(pathlib.Path(self.temp.name, 'resume', 'codex'), codex_titles.A)
        viewer = Viewer(self)
        try:
            for _ in range(2):
                self.command('pane.input', target=self.pane, data=shlex.join([str(fake), 'resume', codex_titles.A]) + '\r')
                self.until(lambda: self.state()['name'] == 'Investigate missing session details')
                self.assertEqual(self.state()['session'], codex_titles.A)
                self.assertEqual(self.state()['completed'], 0)
                self.until(lambda: 'Investigate missing' in viewer.poll()['data'])
                self.command('pane.input', target=self.pane, data='exit\r')
                self.until(lambda: self.state()['session'] == '')
        finally:
            viewer.close()


if __name__ == '__main__':
    unittest.main()
