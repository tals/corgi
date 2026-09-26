#!/usr/bin/env python3
"""Opt-in real Herdr -> Corgi migration tests; no user sessions or agent accounts.

Run: ./scripts/zig build test-handoff -Doptimize=ReleaseSafe
Or:  python3 tests/herdr_handoff.py --corgi /path/to/corgi --herdr /path/to/herdr
Remaining arguments are unittest selectors/options. No viewer test driver needed.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest


CORGI = os.environ.get("CORGI_TEST_BIN", str(Path(__file__).resolve().parents[1] / "zig-out/bin/corgi"))
HERDR = os.environ.get("HERDR_TEST_BIN", "herdr")


class HerdrHandoff(unittest.TestCase):
    def setUp(self):
        # Short explicit root avoids macOS AF_UNIX limits and tempfile globals
        # changed by other suites. No existing runtime paths are ever accepted.
        self.root = Path(tempfile.mkdtemp(prefix="corgi-handoff-", dir="/tmp")).resolve()
        self.processes = []
        self.logs = []
        self.corgi_socket = self.root / "control.sock"
        self.herdr_socket = None
        self.addCleanup(self.cleanup)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("CORGI_", "HERDR_", "XDG_", "CODEX_", "CLAUDE_", "TMUX", "ZDOTDIR", "ENV", "BASH_ENV"))}
        for name in ("home", "config", "state", "cache", "data", "run", "tmp"):
            (self.root / name).mkdir(mode=0o700)
        self.env.update({
            "HOME": str(self.root / "home"), "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_STATE_HOME": str(self.root / "state"), "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_DATA_HOME": str(self.root / "data"), "XDG_RUNTIME_DIR": str(self.root / "run"),
            "TMPDIR": str(self.root / "tmp"), "SHELL": "/bin/sh", "TERM": "xterm-256color",
            "CODEX_HOME": str(self.root / "home/.codex"), "CLAUDE_CONFIG_DIR": str(self.root / "home/.claude"),
            "CORGI_SOCKET": str(self.corgi_socket), "CORGI_BELL": "off",
            "CORGI_INFERENCE_PROVIDER": "off", "CORGI_SUMMARY_COMMAND": "off",
        })
        # Stable and debug Herdr binaries use different application directories.
        for app in ("herdr", "herdr-dev"):
            directory = self.root / "config" / app
            directory.mkdir(mode=0o700)
            (directory / "config.toml").write_text(
                'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n'
                '[update]\nversion_check = false\nmanifest_check = false\n')
        self.donor = self.launch(HERDR, "server", label="herdr")

        def source_ready():
            self.assertIsNone(self.donor.poll(), "Herdr exited during startup")
            paths = [self.root / "config" / app / "herdr.sock" for app in ("herdr", "herdr-dev")]
            found = [path for path in paths if path.is_socket()]
            if len(found) == 1:
                self.herdr_socket = found[0]
                return self.herdr("ping")

        pong = self.until(source_ready, "Herdr startup")
        self.assertTrue(pong.get("capabilities", {}).get("live_handoff"),
                        "This Herdr build does not advertise live_handoff")
        self.receiver = self.launch(CORGI, "serve", label="corgi")
        self.until(lambda: self.corgi(op="ping"), "Corgi startup")

    def launch(self, *args, label):
        log = (self.root / (label + ".log")).open("wb")
        self.logs.append(log)
        process = subprocess.Popen(args, env=self.env, cwd=self.root,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   start_new_session=True)
        self.processes.append(process)
        return process

    def exchange(self, path, message, timeout=3):
        # Even cleanup and failures may only connect inside this fixture.
        Path(path).relative_to(self.root)
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(timeout)
            client.connect(str(path))
            client.sendall(json.dumps(message).encode() + b"\n")
            with client.makefile("rb") as stream:
                line = stream.readline(16 * 1024 * 1024)
            if not line:
                raise ConnectionError("Runtime closed its response socket")
            response = json.loads(line)
        self.assertNotIn("error", response, response)
        self.assertNotIn("err", response, response)
        return response

    def corgi(self, **message):
        return self.exchange(self.corgi_socket, {"protocol": 1, **message})

    def herdr(self, method, **params):
        return self.exchange(self.herdr_socket, {"id": "migration-test", "method": method, "params": params})["result"]

    def command(self, operation, **params):
        return self.corgi(op="session.command", command={operation: params})["result"]

    def until(self, predicate, description, seconds=15):
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            try:
                last = predicate()
                if last:
                    return last
            except (OSError, json.JSONDecodeError) as error:
                last = str(error)
            time.sleep(.05)
        self.fail(f"Timed out waiting for {description}: {last}")

    def source_shell(self, label="Migrated website", tab="Development"):
        folder = self.root / label.replace(" ", "-")
        folder.mkdir()
        created = self.herdr("workspace.create", cwd=str(folder), label=label)
        pane = created["root_pane"]["pane_id"]
        self.herdr("tab.rename", tab_id=created["tab"]["tab_id"], label=tab)
        return pane, folder

    def source_input(self, pane, text):
        self.herdr("pane.send_input", pane_id=pane, text=text, keys=["Enter"])

    def source_pid(self, pane):
        return self.herdr("pane.process_info", pane_id=pane)["process_info"]["shell_pid"]

    def handoff(self, operation, viewer_pgid=None):
        self.corgi(op="onboarding.handoff", operation=operation, socket=str(self.herdr_socket),
                   viewer_pgid=viewer_pgid or os.getpgrp())

        def finished():
            progress = self.corgi(op="onboarding.status", operation=operation)["progress"]
            return progress if progress["phase"] in ("complete", "failed") else None

        return self.until(finished, "handoff completion", seconds=45)

    def imported_pane(self, pid):
        return next(p for p in self.corgi(op="session.snapshot")["panes"] if p["pid"] == pid)

    def shell_receipt(self, pane, filename, source=False):
        path = self.root / filename
        text = "printf '%s %s\\n' \"$$\" \"$handoff_token\" > " + shlex.quote(str(path))
        if source:
            self.source_input(pane, text)
        else:
            self.command("pane.input", target=pane, data=text + "\r")
        return self.until(lambda: path.read_text().strip(), "shell receipt")

    def test_process_state_layout_and_terminal_io_survive(self):
        # Preserve existing Corgi work while appending the imported workspaces.
        original = self.corgi(op="session.snapshot")["workspaces"][0]["id"]
        existing = self.command("pane.create", workspace=original, cwd=str(self.root), command="exec /bin/sh")["pane"]
        existing_pid = self.corgi(op="session.snapshot")["panes"][0]["pid"]
        first, folder = self.source_shell()
        self.source_input(first, "handoff_token=only-in-this-shell")
        first_pid = self.source_pid(first)
        self.assertEqual(self.shell_receipt(first, "before", source=True), f"{first_pid} only-in-this-shell")
        self.herdr("pane.split", target_pane_id=first, direction="right", ratio=.4, cwd=str(folder))
        research, _ = self.source_shell("Migrated research", "Notes")
        snapshot = self.herdr("session.snapshot")["snapshot"]
        split = next(p["pane_id"] for p in snapshot["panes"] if p["pane_id"] not in (first, research))
        pids = {self.source_pid(p["pane_id"]) for p in snapshot["panes"]}
        split_shell_pid = self.source_pid(split)

        # A running foreground process must retain its PID and in-memory counter.
        heartbeat = self.root / "heartbeat"
        worker = self.root / "worker.py"
        worker.write_text('''import os, pathlib, select, sys
path = pathlib.Path(sys.argv[1])
count = 0
while True:
    count += 1
    pending = path.with_suffix('.tmp')
    pending.write_text(f'{os.getpid()} {count}')
    pending.replace(path)
    if select.select([sys.stdin], [], [], .05)[0]:
        line = sys.stdin.readline()
        if not line: break
        print('WORKER_ACK:' + line.strip(), flush=True)
''')
        self.source_input(split, shlex.join([sys.executable, "-u", str(worker), str(heartbeat)]))
        before_pid, before_count = map(int, self.until(lambda: heartbeat.read_text(), "foreground workload").split())
        progress = self.handoff(1)
        self.assertEqual(progress["phase"], "complete", progress)
        self.assertEqual((progress["completed"], progress["total"]), (3, 3))
        self.assertEqual(self.donor.wait(timeout=5), 0)
        self.assertFalse(self.herdr_socket.exists())
        after = self.corgi(op="session.snapshot")
        self.assertEqual({p["pid"] for p in after["panes"]}, pids | {existing_pid})
        self.assertEqual(len(after["workspaces"]), 3)
        self.assertEqual(next(p["pid"] for p in after["panes"] if p["id"] == existing), existing_pid)
        website = next(w for w in after["workspaces"] if w["name"] == "Migrated website")
        research_ws = next(w for w in after["workspaces"] if w["name"] == "Migrated research")
        self.assertEqual([t["title"] for t in website["model"]["tabs"]], ["Development"])
        self.assertEqual([t["title"] for t in research_ws["model"]["tabs"]], ["Notes"])
        branch = website["model"]["nodes"][website["model"]["tabs"][0]["root"]]["split"]
        self.assertEqual(branch["axis"], "horizontal")
        self.assertAlmostEqual(branch["ratio"], 400, delta=1)
        imported = self.imported_pane(first_pid)
        self.assertEqual(imported["cwd"], str(folder))
        self.assertEqual(self.shell_receipt(imported["id"], "after"), f"{first_pid} only-in-this-shell")
        self.until(lambda: int(heartbeat.read_text().split()[1]) > before_count + 3, "continued foreground work")
        self.assertEqual(int(heartbeat.read_text().split()[0]), before_pid)
        target = self.imported_pane(split_shell_pid)["id"]
        self.command("pane.input", target=target, data="after-migration\r")
        self.until(lambda: "WORKER_ACK:after-migration" in self.command("pane.read", target=target, view="screen")["text"], "transferred terminal output")
        # Duplicate start requests cannot append the same session again.
        self.corgi(op="onboarding.handoff", operation=1, socket=str(self.herdr_socket), viewer_pgid=os.getpgrp())
        self.assertEqual(len(self.corgi(op="session.snapshot")["panes"]), 4)

    def test_rejected_handoff_rolls_back_and_can_retry(self):
        self.corgi(op="viewer.open", viewer_protocol=2, onboarding=True, cwd=str(self.root))
        self.assertEqual(self.corgi(op="session.snapshot")["panes"], [])
        pane, _ = self.source_shell()
        self.source_input(pane, "handoff_token=rollback-survived")
        pid = self.source_pid(pane)
        self.assertEqual(self.shell_receipt(pane, "ready", source=True), f"{pid} rollback-survived")
        process = self.herdr("pane.process_info", pane_id=pane)["process_info"]
        before = self.corgi(op="session.snapshot")
        # Exercise a real rejection after descriptors arrive but before ownership
        # commits: importing the viewer's own foreground process is prohibited.
        progress = self.handoff(1, viewer_pgid=process["foreground_process_group_id"])
        self.assertEqual(progress["phase"], "failed", progress)
        self.assertEqual(progress["message"], "CannotHandoffCurrentConsole")
        self.until(lambda: self.herdr("session.snapshot"), "Herdr rollback")
        self.assertIsNone(self.donor.poll())
        self.assertEqual(self.source_pid(pane), pid)
        self.assertEqual(self.shell_receipt(pane, "rollback", source=True), f"{pid} rollback-survived")
        after = self.corgi(op="session.snapshot")
        self.assertEqual(after["workspaces"], before["workspaces"])
        self.assertEqual(after["panes"], before["panes"])
        progress = self.handoff(2)
        self.assertEqual(progress["phase"], "complete", progress)
        imported = self.corgi(op="session.snapshot")
        self.assertEqual([w["name"] for w in imported["workspaces"]], ["Migrated website"])
        self.assertEqual(self.shell_receipt(self.imported_pane(pid)["id"], "retry"), f"{pid} rollback-survived")

    def cleanup(self):
        # Stop only children launched by this fixture. Stop the donor first so
        # an ambiguous import can settle before the receiver releases its PTYs.
        for process in self.processes:
            if process.poll() is None:
                if process is getattr(self, "receiver", None):
                    try:
                        self.exchange(self.corgi_socket, {"op": "shutdown"}, timeout=1)
                    except (OSError, AssertionError, ValueError):
                        pass
                else:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for log in self.logs:
            log.close()
        result = self._outcome.result
        failed = any(test is self for test, _ in result.errors + result.failures)
        if failed:
            for log in self.root.rglob("*.log"):
                print(f"\n--- {log.relative_to(self.root)} ---\n{log.read_text(errors='replace')[-6000:]}", file=sys.stderr)
        shutil.rmtree(self.root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--corgi", default=CORGI)
    parser.add_argument("--herdr", default=HERDR)
    args, remaining = parser.parse_known_args()
    CORGI = shutil.which(args.corgi)
    HERDR = shutil.which(args.herdr)
    if not CORGI or not HERDR:
        parser.error("test-handoff needs Corgi and Herdr executables; use --corgi/--herdr or -Dherdr-bin=/path/to/herdr")
    CORGI, HERDR = str(Path(CORGI).resolve()), str(Path(HERDR).resolve())
    print(f"Migration binaries: Corgi={CORGI}, Herdr={HERDR}", flush=True)
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
