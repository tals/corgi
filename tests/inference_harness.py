#!/usr/bin/env python3
"""Deterministic native inference harness; never contacts a model."""
import json
import os
import pathlib
import sys
import time


def emit(value):
    print(json.dumps(value), flush=True)


def main():
    codex = 'app-server' in sys.argv
    log = os.environ.get('CORGI_INFERENCE_TEST_LOG')
    if log:
        with open(log + '.processes', 'a') as f:
            f.write(str(os.getpid()) + '\n')
    counter = 0
    thread = ''
    turns = 0
    for line in sys.stdin:
        value = json.loads(line)
        method = value.get('method')
        ident = value.get('id')
        if method == 'initialize':
            emit({'id': ident, 'result': {}})
        elif method == 'config/read':
            emit({'id': ident, 'result': {'config': {'model': 'fixture-codex', 'mcp_servers': {'fixture': {}}}}})
        elif method == 'account/read':
            emit({'id':ident,'result':{'account':{'type':'chatgpt','email':'codex@example.com','planType':'pro'}}})
        elif method == 'account/rateLimits/read':
            emit({'id': ident, 'result': {'rateLimits': {'primary': {'usedPercent': 23, 'windowDurationMins': 300}, 'secondary': {'usedPercent': 61, 'windowDurationMins': 10080}}}})
        elif method == 'thread/start':
            assert value['params']['config']['mcp_servers.fixture.enabled'] is False
            counter += 1
            turns = 0
            thread = f'thread-{counter}'
            emit({'id': ident, 'result': {'thread': {'id': thread}}})
        elif method == 'thread/unsubscribe':
            emit({'id': ident, 'result': {}})
        elif value.get('type') == 'control_request':
            emit({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': value['request_id'], 'response': {}}})
        elif method == 'turn/start' or value.get('type') == 'user':
            content = value['params']['input'][0]['text'] if codex else value['message']['content']
            if content == 'crash':
                sys.exit(2)
            if content == 'hang':
                time.sleep(60)
            turns += 1
            turn = f'turn-{turns}'
            control_path = os.environ.get('CORGI_INFERENCE_TEST_CONTROL')
            control = json.loads(pathlib.Path(control_path).read_text()) if control_path else {}
            if log:
                with open(log, 'a') as f:
                    f.write(content + '\n')
                with open(log + '.sessions', 'a') as f:
                    f.write(json.dumps({'pid':os.getpid(),'thread':thread,'turn':turns}) + '\n')
            time.sleep(control.get('delay', 0))
            result = control.get('label', json.dumps({'pid': os.getpid(), 'thread': thread, 'turn': turns}))
            if content == 'oversize':
                result = 'x' * 9000
            if codex:
                # Deliberately deliver the complete turn before its RPC reply.
                emit({'method': 'turn/started', 'params': {'threadId': thread, 'turn': {'id': turn}}})
                usage={'method':'thread/tokenUsage/updated','params':{'threadId':thread,'tokenUsage':{'total':{'inputTokens':1000*turns,'cachedInputTokens':600*turns,'outputTokens':10*turns},'last':{'inputTokens':1000,'cachedInputTokens':600,'outputTokens':10}}}}
                emit(usage)
                emit(usage) # A repeated cumulative sample must not charge twice.
                emit({'method': 'item/completed', 'params': {'threadId': 'wrong-thread', 'turnId': turn, 'item': {'type': 'agentMessage', 'text': 'Wrong stale result'}}})
                emit({'method': 'item/completed', 'params': {'threadId': thread, 'turnId': turn, 'item': {'type': 'agentMessage', 'phase': 'final_answer', 'text': result}}})
                emit({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': turn, 'status': 'failed' if content == 'fail' else 'completed'}}})
                emit({'id': ident, 'result': {'turn': {'id': turn}}})
            else:
                emit({'type': 'result', 'session_id': 'fixture-session', 'subtype': 'error' if content == 'fail' else 'success', 'is_error': content == 'fail', 'result': result, 'structured_output': {'label': 'Tracing pane focus'}, 'usage':{'input_tokens':300,'cache_read_input_tokens':600,'cache_creation_input_tokens':100,'output_tokens':10}})


if __name__ == '__main__':
    main()
