#!/usr/bin/env python3
"""Real SSH / real viewer network evaluation, isolated from host networking."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import shlex
import shutil
import signal
import socket
import subprocess as sp
import sys
import threading
import time
import traceback

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
UID, GID = os.getuid(), os.getgid()
USER = __import__("pwd").getpwuid(UID).pw_name
BUN = str(Path.home() / ".bun/bin/bun")


def run(args, **kwargs):
    result = sp.run([str(x) for x in args], text=True, stdout=sp.PIPE, stderr=sp.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{shlex.join(str(x) for x in args)}: {result.returncode}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def dump(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def wait_for(fn, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(.02)
    raise TimeoutError(f"Condition timed out after {timeout}s")


class Viewer:
    def __init__(self, lab, index):
        self.lab = lab
        self.events, self.latest = [], {}
        self.screen_replies = {}
        self.serial = 0
        self.index = index
        self.log = (lab.out / f"viewer-{index}.jsonl").open("w", buffering=1)
        spec = {"cols": 160 if lab.product == "corgi" else 159, "rows": 48,
                "command": lab.command("local", [lab.binary] + (["--no-update"] if lab.product == "corgi" else [])),
                "cwd": str(lab.root / "local/project"), "env": {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TERM": "xterm-256color"},
                "ansi": str(lab.out / f"viewer-{index}.ansi")}
        spec_path = lab.out / f"viewer-{index}.json"
        dump(spec_path, spec)
        env = dict(os.environ, CORGI_NATIVE_ROOT=str(REPO / "native/zig-out"))
        err = (lab.out / f"observer-{index}.stderr").open("w")
        self.proc = sp.Popen([BUN, str(HERE / "observe.ts"), str(spec_path)], stdin=sp.PIPE, stdout=sp.PIPE, stderr=err, text=True, env=env)
        def read():
            for line in self.proc.stdout:
                self.log.write(line)
                event = json.loads(line)
                self.events.append(event)
                if event["event"] == "frame":
                    self.latest[event["machine"]] = event
                if event["event"] == "screen":
                    self.screen_replies[event["id"]] = event
        self.thread = threading.Thread(target=read, daemon=True)
        self.thread.start()
        self.launch = wait_for(lambda: next((e for e in self.events if e["event"] == "launch"), None))

    def request(self, op, **kwargs):
        self.serial += 1
        self.proc.stdin.write(json.dumps({"op": op, "id": self.serial, **kwargs}) + "\n")
        self.proc.stdin.flush()
        return self.serial

    def screen(self):
        serial = self.request("screen")
        return wait_for(lambda: self.screen_replies.pop(serial, None), 3)["text"]

    def input(self, text):
        serial = self.request("input", text=text)
        return wait_for(lambda: next((e for e in reversed(self.events) if e["event"] == "input" and e["id"] == serial), None), 3)["at"]

    def switch(self, machine, timeout=120):
        start = time.monotonic()
        deadline = start + timeout
        while time.monotonic() < deadline:
            text = self.screen()
            rows = text.splitlines()
            row = next((i + 1 for i, line in enumerate(rows) if f"{machine.upper()}_WORK" in line), None)
            if row:
                self.input(f"\x1b[<0;10;{row}M\x1b[<0;10;{row}m")
                try:
                    frame = self.fresh(machine, start, min(2, deadline - time.monotonic()))
                    return {"seconds": frame["at"] - start, "frame": frame}
                except TimeoutError:
                    pass
            time.sleep(.1)
        (self.lab.out / f"failed-switch-{machine}.txt").write_text(self.screen())
        raise TimeoutError(f"Cannot switch to {machine}")

    def fresh(self, machine, after, timeout=120, max_age=.5):
        def check():
            event = self.latest.get(machine)
            return event if event and event["source"] >= after and 0 <= event["at"] - event["source"] <= max_age else None
        return wait_for(check, timeout)

    def echo(self, token, machine="atlas", timeout=20):
        token = f"{token}V{self.index}I{self.serial}"
        sent = self.input(token + "\r")
        try:
            event = wait_for(lambda: next((e for e in reversed(self.events) if e["event"] == "frame" and e["machine"] == machine and e["ack"] == token and e["at"] >= sent), None), timeout)
            return {"token": token, "sent": sent, "seconds": event["at"] - sent, "ok": True}
        except TimeoutError:
            return {"token": token, "sent": sent, "seconds": None, "ok": False, "timeout": timeout}

    def close(self):
        self.lab.flush_trace()
        if self.proc.poll() is None:
            self.request("exit")
            try:
                self.proc.wait(5)
            except sp.TimeoutExpired:
                self.proc.kill()
        self.thread.join(2)
        self.log.close()

    def ready_probe(self, machine="atlas"):
        probes = []
        begin = time.monotonic()
        tag = f"READYV{self.index}M{machine}I{self.serial}"
        for i in range(50):
            token = f"{tag}P{i}"
            sent = self.input(token + "\r")
            probes.append({"token": token, "sent": sent})
            time.sleep(.1)
            ack = next((e for e in self.events if e["event"] == "frame" and e["machine"] == machine and e["at"] >= begin and any(p["token"] == e["ack"] for p in probes)), None)
            if ack:
                return {"ack_at": ack["at"], "ack": ack["ack"], "probes": probes}
        return {"ack_at": None, "probes": probes}


class Lab:
    def __init__(self, args):
        self.args, self.product = args, args.product
        self.binary = str(Path(args.binary).resolve())
        self.out = Path(args.output).resolve()
        self.out.mkdir(parents=True, exist_ok=False)
        self.root = Path(f"/tmp/cne-{os.getpid()}")
        self.root.mkdir(mode=0o700)
        self.ns = {m: f"cne-{os.getpid()}-{m[0]}" for m in ["local", "atlas", "borealis"]}
        self.fabric = f"cne-{os.getpid()}-f"
        self.created, self.envs, self.processes = [], {}, []
        self.viewer = None
        self.viewer_index = 0
        self.results = []
        self.journal = (self.out / "events.jsonl").open("w", buffering=1)
        self.profiles = {}
        self.telemetry_stop = threading.Event()
        self.telemetry_thread = None
        self.captures = []

    def event(self, event_type, **kwargs):
        value = {"at": time.monotonic(), "epoch": time.time(), "event": event_type, **kwargs}
        self.journal.write(json.dumps(value) + "\n")
        compact = {k: v for k, v in value.items() if k not in ["frame_ages", "frame_times", "frame_sources", "initial_frame"]}
        print(json.dumps(compact), flush=True)
        return value["at"]

    def admin(self, machine, *args):
        namespace = self.fabric if machine == "fabric" else self.ns[machine]
        return run(["sudo", "-n", "ip", "netns", "exec", namespace, *args], timeout=15)

    def command(self, machine, args):
        return ["sudo", "-n", "ip", "netns", "exec", self.ns[machine], "setpriv", f"--reuid={UID}", f"--regid={GID}", "--init-groups",
                "env", "-i", *[f"{k}={v}" for k, v in self.envs[machine].items()], "taskset", "-c", self.args.cpus, *map(str, args)]

    def app(self, machine, *args, timeout=90):
        return run(self.command(machine, [self.binary, *args]), cwd=self.root / machine / "project", timeout=timeout)

    def rpc(self, machine, op, params=None):
        path = self.envs[machine]["CORGI_SOCKET" if self.product == "corgi" else "HERDR_SOCKET_PATH"]
        request = ({"id": "eval", "op": op, "protocol": 4, "runtime_protocol": 4, "viewer_protocol": 4, **(params or {})} if self.product == "corgi"
                   else {"id": "eval", "method": op, "params": params or {}})
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(10)
            conn.connect(path)
            conn.sendall((json.dumps(request) + "\n").encode())
            buffer = b""
            while b"\n" not in buffer:
                buffer += conn.recv(1 << 20)
            response = json.loads(buffer.split(b"\n")[0])
        if response.get("err") or response.get("error"):
            raise RuntimeError(str(response))
        return response if self.product == "corgi" else response.get("result", response)

    def action(self, machine, op, params):
        return self.rpc(machine, "session.command", {"command": {op: params}})["result"]

    def setup(self):
        self.event("setup", product=self.product, binary=self.binary, root=str(self.root), namespaces={**self.ns, "fabric": self.fabric})
        dump(self.out / "manifest.json", {"product": self.product, "binary": self.binary,
             "sha256": hashlib.sha256(Path(self.binary).read_bytes()).hexdigest(),
             "corgi_commit": run(["git", "rev-parse", "HEAD"], cwd=REPO).strip(),
             "build": json.loads(Path(self.binary + ".build.json").read_text()) if Path(self.binary + ".build.json").exists() else None,
             "args": vars(self.args), "kernel": os.uname().release, "clock": "CLOCK_MONOTONIC", "uid": UID,
             "topology": "intermediate-bridge-tbf-netem-v2",
             "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        dump(self.out / "harness.json", {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.iterdir() if p.suffix in [".py", ".ts"]})
        (self.out / "harness").mkdir()
        for source in HERE.iterdir():
            if source.suffix in [".py", ".ts"]:
                shutil.copy2(source, self.out / "harness" / source.name)
        for machine, ns in self.ns.items():
            run(["sudo", "-n", "ip", "netns", "add", ns])
            self.created.append(machine)
            self.admin(machine, "ip", "link", "set", "lo", "up")
            base = self.root / machine
            for folder in ["home/.ssh", "config", "state/corgi", "cache", "data", "run", "tmp", "project", "bin", "work"]:
                (base / folder).mkdir(parents=True, exist_ok=True)
            os.chmod(base / "run", 0o700)
            env = {"HOME": str(base / "home"), "PATH": f"{base}/bin:/usr/bin:/bin", "USER": USER, "LOGNAME": USER,
                   "SHELL": "/bin/sh", "TERM": "xterm-256color", "TERM_PROGRAM": "ghostty", "COLORTERM": "truecolor", "LANG": "C.UTF-8",
                   "XDG_CONFIG_HOME": str(base / "config"), "XDG_STATE_HOME": str(base / "state"), "XDG_CACHE_HOME": str(base / "cache"),
                   "XDG_DATA_HOME": str(base / "data"), "XDG_RUNTIME_DIR": str(base / "run"), "TMPDIR": str(base / "tmp"),
                   "CORGI_SOCKET": str(base / "run/corgi.sock"), "HERDR_SOCKET_PATH": str(base / "run/herdr.sock"),
                   "HERDR_CONFIG_PATH": str(base / "config/config.toml"),
                   "CODEX_HOME": str(base / "home/.codex"), "CLAUDE_CONFIG_DIR": str(base / "home/.claude")}
            if self.product == "corgi" and getattr(self.args, "trace", False):
                env.update(CORGI_TELEMETRY_DIR=str(self.out / "telemetry" / machine),
                           CORGI_TELEMETRY_TRACE="1", CORGI_TELEMETRY_FILTER="remote.")
            self.envs[machine] = env
            (base / "bin" / self.product).symlink_to(self.binary)
            (base / "home/.local/bin").mkdir(parents=True)
            (base / "home/.local/bin" / self.product).symlink_to(self.binary)
            dump(base / "state/corgi/viewer.json", {"onboarding_complete": True})
            (base / "config/config.toml").write_text('onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n')
        run(["sudo", "-n", "ip", "netns", "add", self.fabric])
        self.created.append("fabric")
        self.admin("fabric", "ip", "link", "set", "lo", "up")
        for i, machine in enumerate(["atlas", "borealis"], 1):
            self.admin("local", "ip", "link", "add", machine, "type", "veth", "peer", "name", f"{machine}-c", "netns", self.fabric)
            self.admin(machine, "ip", "link", "add", "uplink", "type", "veth", "peer", "name", f"{machine}-s", "netns", self.fabric)
            self.admin("fabric", "ip", "link", "add", f"br{i}", "type", "bridge")
            self.admin("fabric", "ip", "link", "set", f"br{i}", "up")
            for device in [f"{machine}-c", f"{machine}-s"]:
                self.admin("fabric", "ip", "link", "set", device, "master", f"br{i}")
                self.admin("fabric", "ip", "link", "set", device, "up")
                self.admin("fabric", "ethtool", "-K", device, "tso", "off", "gso", "off", "gro", "off")
            for side, device, host in [("local", machine, 1), (machine, "uplink", 2)]:
                self.admin(side, "ip", "addr", "add", f"10.203.{i}.{host}/24", "dev", device)
                self.admin(side, "ip", "link", "set", device, "up")
                self.admin(side, "ethtool", "-K", device, "tso", "off", "gso", "off", "gro", "off")
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", self.root / "client-key"])
        known, configs = [], []
        for i, machine in enumerate(["atlas", "borealis"], 1):
            base = self.root / machine
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", base / "host-key"])
            known.append(f"[10.203.{i}.2]:2222 " + (base / "host-key.pub").read_text())
            forced = base / "remote-shell"
            forced.write_text("#!/bin/sh\nprintf '%s\\n' \"$SSH_ORIGINAL_COMMAND\" >> " + str(self.out / f"ssh-commands-{machine}.log") + "\nexec env -i " + " ".join(shlex.quote(f"{k}={v}") for k, v in self.envs[machine].items()) + ' /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n')
            forced.chmod(0o700)
            config = base / "sshd_config"
            config.write_text(f"Port 2222\nListenAddress 10.203.{i}.2\nHostKey {base}/host-key\nPidFile {base}/sshd.pid\nAuthorizedKeysFile {self.root}/client-key.pub\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nAllowUsers {USER}\nLogLevel VERBOSE\nForceCommand {forced}\n")
            log = (self.out / f"sshd-{machine}.log").open("w")
            self.processes.append(sp.Popen(self.command(machine, ["/usr/sbin/sshd", "-D", "-e", "-f", str(config)]), stdout=log, stderr=log))
            configs.append(f"Host {machine}\n HostName 10.203.{i}.2\n Port 2222\n User {USER}\n IdentityFile {self.root}/client-key\n IdentitiesOnly yes\n UserKnownHostsFile {self.root}/known_hosts\n StrictHostKeyChecking yes\n")
            if self.args.ssh_compression != "default":
                configs[-1] += f" Compression {self.args.ssh_compression}\n"
        (self.root / "known_hosts").write_text("".join(known))
        sshconfig = self.root / "local/home/.ssh/config"
        sshconfig.write_text("".join(configs))
        sshwrapper = self.root / "local/bin/ssh"
        sshwrapper.write_text(f"#!/bin/sh\nexec /usr/bin/ssh -F {shlex.quote(str(sshconfig))} \"$@\"\n")
        sshwrapper.chmod(0o700)
        for machine in self.ns:
            if self.product == "corgi":
                self.app(machine, "start")
            else:
                log = (self.out / f"daemon-{machine}.log").open("w")
                self.processes.append(sp.Popen(self.command(machine, ["setsid", self.binary, "server"]), cwd=self.root / machine / "project", stdin=sp.DEVNULL, stdout=sp.DEVNULL, stderr=sp.DEVNULL))
            path = self.envs[machine]["CORGI_SOCKET" if self.product == "corgi" else "HERDR_SOCKET_PATH"]
            wait_for(lambda: Path(path).exists())
            self.seed(machine)
            if self.product == "herdr":
                (self.out / f"status-{machine}.json").write_text(self.app(machine, "status", "server", "--json"))
        for machine in ["atlas", "borealis"]:
            start = time.monotonic()
            answer = (self.app("local", "machine", "add", machine, machine, "--executable", self.binary) if self.product == "corgi"
                      else self.app("local", "machine", "add", machine, "--label", machine, "--remote-session", "default"))
            self.event("machine_add", machine=machine, seconds=time.monotonic() - start, answer=answer)
        dump(self.out / "machines.json", json.loads(self.app("local", "machine", "list", *(["--json"] if self.product == "herdr" else []))))
        self.event("setup_complete")
        if self.args.capture:
            for machine in ["local", "atlas"]:
                with (self.out / f"packets-{machine}.pcap").open("wb") as packets, (self.out / f"packets-{machine}.log").open("w") as log:
                    self.captures.append(sp.Popen([
                        "sudo", "-n", "ip", "netns", "exec", self.ns[machine],
                        "tcpdump", "-Z", USER, "-U", "-i", "any", "-s", "128", "-w", "-",
                        "tcp port 2222 or arp"], stdout=packets, stderr=log))
            time.sleep(.2)
            if any(capture.poll() is not None for capture in self.captures):
                raise RuntimeError("Packet capture failed to start")
        self.start_telemetry()

    def flush_trace(self):
        if self.product != "corgi" or not getattr(self.args, "trace", False):
            return
        for machine in self.ns:
            if machine not in self.created:
                continue
            for pid in self.pids(machine):
                try:
                    if Path(f"/proc/{pid}/exe").resolve() == Path(self.binary):
                        os.kill(pid, signal.SIGUSR2)
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    pass
        time.sleep(.1)

    def start_telemetry(self):
        def sample():
            with (self.out / "resources.jsonl").open("w", buffering=1) as output:
                while not self.telemetry_stop.is_set():
                    processes = []
                    for machine in self.ns:
                        for pid in self.pids(machine):
                            try:
                                stat = Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()
                                cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
                                processes.append({"machine": machine, "pid": pid, "command": cmdline,
                                                  "cpu_ticks": int(stat[11]) + int(stat[12]), "rss_bytes": int(stat[21]) * os.sysconf("SC_PAGE_SIZE")})
                            except (FileNotFoundError, ProcessLookupError, PermissionError):
                                pass
                    output.write(json.dumps({"at": time.monotonic(), "processes": processes}) + "\n")
                    if getattr(self.args, "trace", False):
                        with (self.out / "tcp.jsonl").open("a") as sockets:
                            sockets.write(json.dumps({"at": time.monotonic(), "epoch": time.time(),
                                "sockets": {machine: self.admin(machine, "ss", "-tinp") for machine in self.ns}}) + "\n")
                    self.telemetry_stop.wait(1)
        self.telemetry_thread = threading.Thread(target=sample, daemon=True)
        self.telemetry_thread.start()

    def calibrate(self):
        server = sp.Popen(self.command("atlas", ["python3", HERE / "calibrate.py", "server"]), stdout=sp.DEVNULL, stderr=sp.DEVNULL)
        time.sleep(.2)
        results = []
        try:
            for rate in [None, "1mbit", "256kbit", "64kbit"]:
                self.shape(rate=rate)
                ping = self.admin("local", "ping", "-n", "-c", "5", "-i", ".2", "10.203.1.2")
                throughput = json.loads(run(self.command("local", ["python3", HERE / "calibrate.py", "client"]), timeout=60))
                results.append({"rate": rate, "rtt": 120, "ping": ping, "tcp": throughput})
            dump(self.out / "calibration.json", results)
        finally:
            server.terminate()
            self.shape()

    def seed(self, machine):
        root = self.root / machine
        command = f"exec /usr/bin/python3 {shlex.quote(str(HERE / 'workload.py'))} {root}/work {machine}"
        if self.product == "corgi":
            snap = self.rpc(machine, "session.snapshot")
            workspace = snap["workspaces"][0]["id"]
            pane = (snap["panes"][0]["id"] if snap["panes"] else
                    self.action(machine, "pane.create", {"workspace": workspace, "cwd": str(root / "project")})["pane"])
            self.action(machine, "workspace.edit", {"target": workspace, "name": machine.upper() + "_WORK"})
            self.action(machine, "pane.send", {"target": pane, "text": command, "enter": True})
            for i in range(1, self.args.panes):
                self.action(machine, "pane.create", {"workspace": workspace, "cwd": str(root / "project"), "command": command + str(i)})
        else:
            snap = self.rpc(machine, "session.snapshot")["snapshot"]
            if not snap["workspaces"]:
                self.rpc(machine, "workspace.create", {"cwd": str(root / "project"), "label": machine.upper() + "_WORK"})
                snap = self.rpc(machine, "session.snapshot")["snapshot"]
            workspace, pane = snap["workspaces"][0]["workspace_id"], snap["panes"][0]["pane_id"]
            self.rpc(machine, "workspace.rename", {"workspace_id": workspace, "label": machine.upper() + "_WORK"})
            self.rpc(machine, "pane.send_input", {"pane_id": pane, "text": command, "keys": ["Enter"]})
            for i in range(1, self.args.panes):
                new = self.rpc(machine, "tab.create", {"workspace_id": workspace, "cwd": str(root / "project"), "focus": False})
                self.rpc(machine, "pane.send_input", {"pane_id": new["root_pane"]["pane_id"], "text": command + str(i), "keys": ["Enter"]})
            self.rpc(machine, "pane.focus", {"pane_id": pane})
        dump(self.out / f"initial-{machine}.json", snap)

    def shape(self, machine="atlas", rtt=120, rate=None, loss=None, direction="both", jitter=None):
        for way, device in [("up", f"{machine}-s"), ("down", f"{machine}-c")]:
            self.admin("fabric", "tc", "qdisc", "replace", "dev", device, "root", "handle", "1:", "tbf",
                       "rate", rate or "100gbit", "burst", "1600", "limit", "96000")
            args = ["tc", "qdisc", "replace", "dev", device, "parent", "1:1", "handle", "10:", "netem", "limit", "64", "delay", f"{rtt / 2}ms"]
            if jitter:
                args += [f"{jitter}ms", "distribution", "normal"]
            else:
                args += ["0ms"]
            dropped = loss if loss and (direction == "both" or direction == way) else 0
            args += ["loss", "random", str(dropped) + "%"]
            self.admin("fabric", *args)
        self.profiles[machine] = {"rtt": rtt, "rate": rate, "loss": loss, "direction": direction, "jitter": jitter}
        self.event("network", machine=machine, **self.profiles[machine])

    def network_snapshot(self, name):
        value = {}
        for machine in [*self.ns, "fabric"]:
            value[machine] = {"at": time.monotonic(), "qdisc": self.admin(machine, "tc", "-s", "-j", "qdisc", "show"),
                              "sockets": self.admin(machine, "ss", "-tinp"),
                              "links": self.admin(machine, "ip", "-s", "-j", "link", "show")}
        dump(self.out / f"network-{name}.json", value)

    def pids(self, machine):
        namespace = self.fabric if machine == "fabric" else self.ns[machine]
        return [int(x) for x in run(["sudo", "-n", "ip", "netns", "pids", namespace]).split()]

    def reset_ssh(self):
        for pid in self.pids("local"):
            try:
                if Path(f"/proc/{pid}/comm").read_text().strip() == "ssh":
                    os.kill(pid, signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError):
                pass

    def start_viewer(self):
        if self.viewer:
            self.viewer.close()
        self.viewer_index += 1
        self.viewer = Viewer(self, self.viewer_index)
        return self.viewer

    def record(self, value):
        self.results.append(value)
        dump(self.out / "results.json", self.results)
        self.event("result", **value)

    def fresh_viewer(self):
        if self.viewer:
            self.viewer.close()
            self.viewer = None
        self.reset_ssh()
        self.mode("sparse")
        for machine in ["atlas", "borealis"]:
            self.shape(machine)
        view = self.start_viewer()
        view.fresh("local", view.launch["launched"], 30)
        # Fault/throughput cases start with established connections. Startup
        # separately exercises clicking cached workspaces while connecting.
        time.sleep(max(0, view.launch["launched"] + 5 - time.monotonic()))
        view.switch("atlas")
        return view

    def mode(self, kind="sparse", hz=20):
        for machine in self.ns:
            dump(self.root / machine / "work/mode.json", {"kind": kind, "hz": hz})
        self.event("workload", kind=kind, hz=hz)

    def startup(self, rtt, repeat, warm=False):
        if self.viewer:
            self.viewer.close()
            self.viewer = None
        if not warm:
            self.reset_ssh()
        for machine in ["atlas", "borealis"]:
            self.shape(machine, rtt=rtt)
        view = self.start_viewer()
        local = view.fresh("local", view.launch["launched"], 30)
        view.switch("atlas")
        fresh = view.fresh("atlas", view.launch["launched"])
        ready = view.ready_probe()
        self.record({"case": "startup", "rtt_ms": rtt, "warm": warm, "repeat": repeat,
                     "local_seconds": local["at"] - view.launch["launched"], "remote_seconds": fresh["at"] - view.launch["launched"],
                     "usable_seconds": ready["ack_at"] - view.launch["launched"] if ready["ack_at"] else None, "ready": ready})

    def startup_attempt(self, rtt, repeat, warm=False):
        try:
            self.startup(rtt, repeat, warm)
        except (TimeoutError, BrokenPipeError) as error:
            exit_event = next((e for e in reversed(self.viewer.events) if e["event"] == "exit"), None) if self.viewer else None
            screen = next((e["text"] for e in reversed(self.viewer.events) if e["event"] == "screen"), "") if self.viewer else ""
            self.record({"case": "startup", "rtt_ms": rtt, "warm": warm, "repeat": repeat,
                         "local_seconds": None, "remote_seconds": None, "usable_seconds": None,
                         "failure": str(error), "viewer_exit": exit_event, "last_screen": screen})

    def recover(self, case, action, duration, repeat=0, isolation=False):
        view = self.fresh_viewer()
        self.mode(self.args.fault_kind)
        self.shape(rtt=120)
        time.sleep(2)
        before = view.echo(f"BEFORE{case}{repeat}")
        producers_before = self.producers()
        started = self.event("fault_start", case=case, repeat=repeat)
        action()
        snapshot_errors = []
        def snapshot():
            time.sleep(max(0, started + duration - 2 - time.monotonic()))
            began = time.monotonic()
            try:
                self.network_snapshot(f"{case}-{repeat}-fault")
            except Exception as error:
                snapshot_errors.append(error)
            self.event("fault_snapshot", case=case, repeat=repeat, started=began,
                       seconds=time.monotonic() - began)
        sampling = threading.Thread(target=snapshot, daemon=True)
        sampling.start()
        time.sleep(max(0, started + min(2, duration / 2 if duration <= 2 else duration) - time.monotonic()))
        during = view.input(f"DURING{case}{repeat}\r")
        (self.out / f"fault-screen-{case}-{repeat}.txt").write_text(view.screen())
        other = []
        if isolation:
            for machine in ["local", "borealis"]:
                switch_start = time.monotonic()
                switch = view.switch(machine, 10)
                ready = view.ready_probe(machine)
                echo = view.echo(f"OTHER{case}{repeat}{machine}", machine=machine, timeout=5)
                other.append({"machine": machine, "switch_seconds": switch["seconds"], "echo": echo,
                              "usable_seconds": ready["ack_at"] - switch_start if ready["ack_at"] else None, "ready": ready})
        late = None
        if not isolation and duration >= 15:
            time.sleep(max(0, started + 8 - time.monotonic()))
            late = view.input(f"LATE{case}{repeat}\r")
            (self.out / f"late-fault-screen-{case}-{repeat}.txt").write_text(view.screen())
        time.sleep(max(0, started + duration - time.monotonic()))
        self.shape(rtt=120)
        restored = self.event("fault_end", case=case, repeat=repeat)
        try:
            if isolation:
                view.switch("atlas", 150)
            fresh = view.fresh("atlas", restored, 150)
            elapsed = fresh["at"] - restored
        except TimeoutError:
            elapsed = None
        ready = view.ready_probe()
        echo = view.echo(f"AFTER{case}{repeat}", timeout=20)
        sampling.join()
        if snapshot_errors:
            raise snapshot_errors[0]
        self.record({"case": case, "kind": self.args.fault_kind, "repeat": repeat, "fault_seconds": duration, "actual_fault_seconds": restored - started, "recovery_seconds": elapsed,
                     "usable_seconds": ready["ack_at"] - restored if ready["ack_at"] else None, "ready": ready,
                     "before": before, "echo": echo, "during_input_at": during, "late_input_at": late, "isolation": other,
                     "producers_before": producers_before, "producers_after": self.producers()})
        (self.out / f"screen-{case}-{repeat}.txt").write_text(view.screen())

    def reset_connection(self, repeat=0):
        view = self.fresh_viewer()
        time.sleep(2)
        before = view.echo(f"BEFORERESET{repeat}")
        self.admin("atlas", "ss", "-K", "state", "established", "sport", "=", ":2222")
        start = self.event("tcp_reset_applied", repeat=repeat)
        try:
            fresh = view.fresh("atlas", start, 120)
            recovery = fresh["at"] - start
        except TimeoutError:
            recovery = None
        ready = view.ready_probe()
        self.record({"case": "tcp_reset", "repeat": repeat, "recovery_seconds": recovery, "before": before,
                     "usable_seconds": ready["ack_at"] - start if ready["ack_at"] else None, "ready": ready,
                     "echo": view.echo(f"AFTERRESET{repeat}")})

    def producers(self):
        producers = []
        for machine in self.ns:
            for source in sorted((self.root / machine / "work").glob("*-source.json")):
                state = json.loads(source.read_text())
                command = Path(f"/proc/{state['pid']}/cmdline")
                try:
                    alive = b"workload.py" in command.read_bytes()
                except FileNotFoundError:
                    alive = False
                producers.append({"machine": machine, "source": source.name, "alive": alive, **state})
        return producers

    def streaming(self, kind, rate, seconds, repeat=0, loss=None, jitter=None):
        view = self.fresh_viewer()
        self.mode(kind)
        self.shape(rtt=self.args.stream_rtt, rate=rate, loss=loss, jitter=jitter)
        time.sleep(4)
        start = self.event("sample_start", kind=kind, rate=rate, loss=loss, repeat=repeat)
        initial_frame = view.latest.get("atlas")
        first = len(view.events)
        snapshot_prefix = f"stream-{view.index}"
        self.network_snapshot(f"{snapshot_prefix}-start")
        probes = []
        for i in range(5):
            token = f"FLOW{view.index}P{i}"
            sent = view.input(token + "\r")
            probes.append({"token": token, "sent": sent})
            time.sleep(max(0, (start + seconds * (i + 1) / 5) - time.monotonic()))
        end = time.monotonic()
        for probe in probes:
            ack = next((e for e in view.events[first:] if e["event"] == "frame" and e["machine"] == "atlas" and e["ack"] == probe["token"] and probe["sent"] <= e["at"] <= end), None)
            probe.update({"ok": ack is not None, "seconds": ack["at"] - probe["sent"] if ack else None, "observation_seconds": end - probe["sent"]})
        self.network_snapshot(f"{snapshot_prefix}-end")
        producers = self.producers()
        frames = [e for e in view.events[first:] if e["event"] == "frame" and e["machine"] == "atlas" and start <= e["at"] <= end]
        self.shape(rtt=self.args.stream_rtt)
        restored = time.monotonic()
        try:
            caught = view.fresh("atlas", restored, 120)
            catchup = caught["at"] - restored
        except TimeoutError:
            catchup = None
        self.record({"case": "stream", "kind": kind, "rate": rate, "rtt_ms": self.args.stream_rtt, "loss_percent": loss, "jitter_ms": jitter, "repeat": repeat,
                     "snapshot_prefix": snapshot_prefix,
                     "start": start, "end": end, "frames": len(frames), "frame_ages": [e["at"] - e["source"] for e in frames],
                     "frame_times": [e["at"] for e in frames], "frame_sources": [e["source"] for e in frames],
                     "initial_frame": initial_frame, "probes": probes, "catchup_seconds": catchup,
                     "producers": producers,
                     "failure": None if len(producers) == 3 * self.args.panes and all(p["alive"] for p in producers) else "producer_exit"})

    def sleep(self, seconds):
        view = self.viewer
        view.switch("atlas")
        self.mode("sparse")
        before = view.echo("BEFORESLEEP")
        self.shape(loss=100, direction="down")
        pending = view.input("SLEEP_PENDING\r")
        time.sleep(.3)
        self.shape(loss=100)
        self.shape("borealis", loss=100)
        pids = self.pids("local")
        for pid in pids:
            try:
                os.kill(pid, signal.SIGSTOP)
            except ProcessLookupError:
                pass
        start = self.event("sleep_start", seconds=seconds, stopped=pids)
        for machine in ["atlas", "borealis"]:
            self.admin(machine, "ss", "-K", "state", "established", "sport", "=", ":2222")
        time.sleep(seconds)
        # Old connections died while the client could not observe it.
        for machine in ["atlas", "borealis"]:
            self.shape(machine)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGCONT)
            except ProcessLookupError:
                pass
        wake = self.event("sleep_end", actual_seconds=time.monotonic() - start)
        try:
            fresh = view.fresh("atlas", wake, 180)
            recovery = fresh["at"] - wake
        except TimeoutError:
            recovery = None
        ready = view.ready_probe()
        echo = view.echo("AFTERSLEEP", timeout=20)
        self.record({"case": "sleep", "sleep_seconds": seconds, "recovery_seconds": recovery, "before": before,
                     "usable_seconds": ready["ack_at"] - wake if ready["ack_at"] else None, "ready": ready,
                     "pending_input_at": pending, "echo": echo})
        (self.out / f"screen-sleep-{seconds}.txt").write_text(view.screen())

    def cleanup(self):
        self.event("cleanup_start")
        self.telemetry_stop.set()
        if self.telemetry_thread:
            self.telemetry_thread.join(5)
        if self.captures:
            for machine in ["local", "atlas"]:
                for pid in self.pids(machine):
                    try:
                        if Path(f"/proc/{pid}/comm").read_text().strip() == "tcpdump":
                            os.kill(pid, signal.SIGINT)
                    except (FileNotFoundError, ProcessLookupError):
                        pass
            for capture in self.captures:
                capture.wait(timeout=5)
        if self.viewer:
            self.viewer.close()
        for machine in self.created:
            for pid in self.pids(machine):
                try:
                    os.kill(pid, signal.SIGCONT)
                    os.kill(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
        time.sleep(.5)
        for machine in self.created:
            pids = self.pids(machine)
            if pids:
                run(["sudo", "-n", "kill", "-KILL", *map(str, pids)])
        # Preserve environment, application logs and input receipts, never keys.
        for machine in self.created:
            for folder in ["work", "config", "state"]:
                source = self.root / machine / folder
                if source.exists():
                    shutil.copytree(source, self.out / "runtime" / machine / folder, dirs_exist_ok=True)
        for machine in reversed(self.created):
            namespace = self.fabric if machine == "fabric" else self.ns[machine]
            run(["sudo", "-n", "ip", "netns", "delete", namespace])
        shutil.rmtree(self.root)
        self.event("cleanup_complete", namespaces_remaining=[n for n in [*self.ns.values(), self.fabric] if Path("/run/netns", n).exists()])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("product", choices=["corgi", "herdr"])
    parser.add_argument("binary")
    parser.add_argument("output")
    parser.add_argument("--suite", choices=["smoke", "startup", "faults", "stream", "sleep", "all"], default="smoke")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--panes", type=int, default=4)
    parser.add_argument("--cpus", default="32-39")
    parser.add_argument("--sleep-seconds", type=int, default=180)
    parser.add_argument("--ansi", action="store_true")
    parser.add_argument("--trace", action="store_true", help="retain remote telemetry and periodic TCP state")
    parser.add_argument("--capture", action="store_true", help="capture TCP headers in the client and Atlas namespaces (requires tcpdump)")
    parser.add_argument("--fault-cases", default="tcp_reset,blackhole3,blackhole15,downstream15,isolated30")
    parser.add_argument("--fault-kind", choices=["sparse", "dense"], default="sparse")
    parser.add_argument("--calibrate", action="store_true")
    parser.add_argument("--rtts", default="0,20,120,300")
    parser.add_argument("--ssh-compression", choices=["default", "yes", "no"], default="default")
    parser.add_argument("--stream-cases", default="sparse:unlimited,sparse:1mbit,sparse:256kbit,sparse:64kbit,dense:1mbit,dense:256kbit,dense:64kbit,loss")
    parser.add_argument("--stream-rtt", type=int, default=120)
    parser.add_argument("--stream-seconds", type=int, default=30)
    args = parser.parse_args()
    lock = open(f"/tmp/corgi-cpu-benchmark-{UID}.lock", "a")
    owner = os.environ.get("CORGI_CPU_BENCHMARK_LOCK")
    if owner:
        pid, started = owner.split(":")
        stat = Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()
        if stat[19] != started:
            raise RuntimeError("Stale benchmark lock owner")
    else:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    lab = Lab(args)
    try:
        lab.setup()
        if args.calibrate:
            lab.calibrate()
        if args.suite in ["smoke", "startup", "all"]:
            for rtt in ([120] if args.suite == "smoke" else [int(x) for x in args.rtts.split(",")]):
                for repeat in range(1 if args.suite == "smoke" else args.repeats):
                    lab.startup_attempt(rtt, repeat)
                    if args.suite != "smoke":
                        lab.startup_attempt(rtt, repeat, warm=True)
        else:
            lab.startup(120, 0)
        if args.suite in ["faults", "all"]:
            for repeat in range(args.repeats):
                for case in args.fault_cases.split(","):
                    if case == "tcp_reset":
                        lab.reset_connection(repeat)
                    elif case.startswith("blackhole"):
                        duration = int(case.removeprefix("blackhole"))
                        lab.recover(case, lambda: lab.shape(loss=100), duration, repeat)
                    elif case == "downstream15":
                        lab.recover(case, lambda: lab.shape(loss=100, direction="down"), 15, repeat)
                    elif case == "isolated30":
                        lab.recover(case, lambda: lab.shape(loss=100), 30, repeat, isolation=True)
                    else:
                        raise ValueError(f"Unknown fault case: {case}")
        if args.suite in ["stream", "all"]:
            for repeat in range(args.repeats):
                for selected in args.stream_cases.split(","):
                    if selected == "loss":
                        lab.streaming("sparse", None, args.stream_seconds, repeat, loss=1, jitter=10)
                    else:
                        kind, rate = selected.split(":")
                        lab.streaming(kind, None if rate == "unlimited" else rate, args.stream_seconds, repeat)
        if args.suite in ["sleep", "all"]:
            lab.sleep(args.sleep_seconds)
        if args.suite == "smoke":
            lab.streaming("sparse", "256kbit", 6)
    except BaseException:
        (lab.out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        lab.cleanup()


if __name__ == "__main__":
    main()
