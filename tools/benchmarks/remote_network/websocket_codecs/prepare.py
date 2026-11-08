#!/usr/bin/env python3
"""Build isolated plain, zstd and native-deflate WebSocket application variants."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def replace(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Expected one hook in {path}: {old!r}")
    path.write_text(text.replace(old, new))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("revision", help="Committed, reviewed application baseline")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[4]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    checkout = output / "source"
    run(["git", "worktree", "add", "--detach", checkout, args.revision], cwd=source)
    (checkout / "node_modules").symlink_to(
        source / "node_modules", target_is_directory=True
    )
    shutil.copy2(
        Path(__file__).with_name("adapter.ts"), checkout / "src/eval_transport.ts"
    )
    shutil.copy2(
        Path(__file__).with_name("inspect.ts"), checkout / "src/eval_inspect.ts"
    )
    daemon = checkout / "src/daemon_transport.ts"
    server = checkout / "src/server.ts"
    daemon.write_text(
        'import * as evalTransport from "./eval_transport";\n'
        'import { evalDeflate } from "./eval_transport_mode";\n' + daemon.read_text()
    )
    replace(
        daemon,
        "  private listener: Server | null = null;",
        "  private listener: Server | null = null;\n"
        "  private evalAdapter: { close(): void } | null = null;",
    )
    replace(
        daemon,
        "      listener.listen(this.socket, () => {",
        '      listener.listen(this.socket + ".tunnel", () => {',
    )
    replace(
        daemon,
        "          chmodSync(this.socket, 0o600);",
        '          chmodSync(this.socket + ".tunnel", 0o600);',
    )
    replace(
        daemon,
        "    });\n  }\n  private attach(client: Socket): void {",
        '    });\n    const adapter = await evalTransport.listenWebSocketClient({ path: this.socket, target: this.socket + ".tunnel", deflate: evalDeflate });\n'
        '    if (this.stopped) { await adapter.close(); throw Error("TransportClosed"); }\n'
        "    this.evalAdapter = adapter;\n"
        "  }\n  private attach(client: Socket): void {",
    )
    replace(
        daemon,
        "ssh.command(this.profile.bridge!, [this.profile.socket])",
        'ssh.command(this.profile.bridge!, [this.profile.socket + ".transport"])',
    )
    replace(
        daemon,
        "    this.listener?.close();",
        "    this.evalAdapter?.close();\n    this.listener?.close();",
    )
    server.write_text(
        'import * as evalTransport from "./eval_transport";\n'
        'import { evalDeflate } from "./eval_transport_mode";\n' + server.read_text()
    )
    replace(
        server,
        "  listener = -1;",
        "  listener = -1;\n  private evalAdapter: { close(): void } | null = null;",
    )
    replace(
        server,
        "      this.startLoop();",
        "      this.startLoop();\n"
        '      this.evalAdapter = await evalTransport.listenWebSocket({ path: this.socket + ".transport", target: this.socket, deflate: evalDeflate });',
    )
    replace(
        server,
        "    this.stopped = true;\n    clearInterval(this.timer);",
        "    this.stopped = true;\n    this.evalAdapter?.close();\n    clearInterval(this.timer);",
    )
    daemon.write_text(
        'import { inspect } from "./eval_inspect";\n' + daemon.read_text()
    )
    replace(
        daemon,
        "    const close = () => {",
        "    const observed = inspect(this.profile.name, client, preamble);\n    const close = () => {\n      observed();",
    )
    endpoint = checkout / "src/machine_connection.ts"
    endpoint.write_text(
        'import { evalZstd } from "./eval_transport_mode";\n' + endpoint.read_text()
    )
    replace(endpoint, "compression: true,", "compression: evalZstd,")
    replace(
        endpoint,
        "compression: this.profile !== null,",
        "compression: this.profile !== null && evalZstd,",
    )
    peer = checkout / "src/peer.ts"
    peer.write_text(
        'import { evalRawAccounting } from "./eval_transport_mode";\n'
        + peer.read_text()
    )
    replace(
        peer,
        "delivery?.encoded(frame, count)",
        "delivery?.encoded(frame, evalRawAccounting ? bytes.length : count)",
    )
    builds = {}
    for mode in ["identity", "zstd", "deflate", "zstd-raw"]:
        (checkout / "src/eval_transport_mode.ts").write_text(
            f'export const evalDeflate = {str(mode == "deflate").lower()};\n'
            f'export const evalZstd = {str(mode in ("zstd", "zstd-raw")).lower()};\n'
            f'export const evalRawAccounting = {str(mode == "zstd-raw").lower()};\n'
        )
        binary = output / f"corgi-{mode}"
        with (output / f"build-{mode}.log").open("w") as log:
            run(
                [
                    "bun",
                    "build.ts",
                    "--no-native",
                    "--native-root",
                    source / "native/zig-out",
                    "--outfile",
                    binary,
                ],
                cwd=checkout,
                stdout=log,
                stderr=log,
            )
        run(
            [
                "git",
                "add",
                "-N",
                "src/eval_transport.ts",
                "src/eval_transport_mode.ts",
                "src/eval_inspect.ts",
            ],
            cwd=checkout,
        )
        with (output / f"{mode}.patch").open("w") as patch:
            run(["git", "diff", "HEAD", "--", "src"], cwd=checkout, stdout=patch)
        builds[mode] = {
            "binary": str(binary),
            "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            "patch_sha256": hashlib.sha256(
                (output / f"{mode}.patch").read_bytes()
            ).hexdigest(),
            "build": json.loads(Path(str(binary) + ".build.json").read_text()),
        }
    (output / "builds.json").write_text(json.dumps(builds, indent=2) + "\n")
    print(json.dumps(builds, indent=2))


if __name__ == "__main__":
    main()
