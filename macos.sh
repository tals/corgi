#!/bin/bash
# Run from a macOS terminal. Downloads only the standalone Corgi executable.
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'Run this on your Mac.' >&2; exit 1; }
check=0
if [[ ${1:-} == --check ]]; then check=1; shift; fi
[[ $# == 0 ]] || { echo 'Usage: macos.sh [--check]' >&2; exit 1; }
host=${CORGI_PROBE_HOST:-nocap}
remote=${CORGI_PROBE_REMOTE:-/home/t/dev/personal/corgi}
[[ $remote =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Expected an absolute remote path without shell characters.' >&2; exit 1; }
case $(uname -m) in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac
terminal=''
if [[ $check == 0 ]]; then
    exec 3>&1
    terminal=$(tty <&3) || { echo 'Run from a local terminal window.' >&2; exit 1; }
    exec 3>&-
    [[ $terminal == /dev/tty* ]] || { echo 'Expected a terminal device.' >&2; exit 1; }
fi
stage=$(mktemp -d /tmp/corgi-app.XXXXXX)
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
out="$stage/results"
bin="$stage/corgi-darwin-$arch"
started=0
mkdir -m 700 -p "$out" "$stage/workspace" "$stage/state" "$stage/environment"
mkdir -m 700 -p "$stage/state/corgi"
cat > "$stage/state/corgi/viewer.json" <<'EOF'
{"onboarding_complete":true,"preset":"corgi","prefix":"ctrl_b"}
EOF
export CORGI_SOCKET="$stage/corgi.sock" CORGI_ENV_DIR="$stage/environment" XDG_STATE_HOME="$stage/state"
unset CORGI_PANE CORGI_APP_EXE
finish() {
    code=$?
    trap - EXIT
    if [[ $started == 1 ]]; then
        if ! "$bin" shutdown > "$out/shutdown.json" 2> "$out/shutdown.stderr"; then
            echo "Isolated daemon shutdown failed; inspect $out/shutdown.stderr" >&2
            code=1
        fi
    fi
    [[ ! -f "$stage/server.log" ]] || cp "$stage/server.log" "$out/server.log"
    printf '%s\n' "$code" > "$out/exit-code.txt"
    echo "Uploading results to $host:$remote/results/macos-$stamp/"
    if ! rsync -az "$out/" "$host:$remote/results/macos-$stamp/"; then
        echo "Upload failed; results remain at $out" >&2
        code=1
    fi
    echo "Executable and isolated state retained at $stage"
    exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec > >(tee -a "$out/run.log") 2>&1
echo "Downloading standalone Corgi for darwin-$arch; no Bun, npm, or compiler needed."
rsync -az "$host:$remote/dist/corgi-darwin-$arch" "$stage/"
rsync -az "$host:$remote/dist/corgi-darwin-$arch.sha256" "$stage/"
rsync -az "$host:$remote/dist/corgi-darwin-$arch.build.json" "$out/build.json"
uname -a > "$out/host.txt"
sw_vers >> "$out/host.txt"
(cd "$stage" && shasum -a 256 -c "corgi-darwin-$arch.sha256")
chmod +x "$bin"
run() {
    printf 'corgi'; printf ' %q' "$@"; printf '\n'
    "$bin" "$@"
}
run --version | tee "$out/version.txt"
run --help > "$out/help.txt"
started=1
run start
"$bin" rpc '{"op":"hello","protocol":1}' > "$out/hello.json"
"$bin" rpc '{"op":"ping"}' > "$out/ping-before.json"
before=$(/usr/bin/plutil -extract pid raw -o - "$out/ping-before.json")
[[ $before =~ ^[0-9]+$ ]]
if [[ $check == 1 ]]; then
    "$bin" list > "$out/list-initial.json"
    workspace=$(/usr/bin/plutil -extract result.workspaces.0.id raw -o - "$out/list-initial.json")
    [[ $workspace =~ ^[0-9]+$ ]]
    "$bin" rpc "{\"op\":\"session.command\",\"protocol\":1,\"command\":{\"pane.create\":{\"workspace\":$workspace,\"cwd\":\"$stage/workspace\",\"command\":\"exec /bin/cat\"}}}" > "$out/pane.json"
    pane=$(/usr/bin/plutil -extract result.pane raw -o - "$out/pane.json")
    [[ $pane =~ ^[0-9]+$ ]]
    "$bin" list > "$out/list-before.json"
    pane_pid=$(/usr/bin/plutil -extract result.panes.0.pid raw -o - "$out/list-before.json")
    [[ $pane_pid =~ ^[0-9]+$ ]]
    run reload | tee "$out/reload.txt"
    "$bin" rpc '{"op":"ping"}' > "$out/ping-after.json"
    after=$(/usr/bin/plutil -extract pid raw -o - "$out/ping-after.json")
    [[ $after =~ ^[0-9]+$ && $after != "$before" ]] || { echo 'Reload did not replace the daemon PID.' >&2; exit 1; }
    "$bin" list > "$out/list-after.json"
    [[ $(/usr/bin/plutil -extract result.panes.0.pid raw -o - "$out/list-after.json") == "$pane_pid" ]] || { echo 'Reload changed the live pane PID.' >&2; exit 1; }
    "$bin" rpc "{\"op\":\"session.command\",\"protocol\":1,\"command\":{\"pane.send\":{\"target\":$pane,\"text\":\"CORGI_MAC_HANDOFF_INPUT\",\"enter\":true}}}" > "$out/input.json"
    received=0
    for attempt in {1..40}; do
        "$bin" rpc "{\"op\":\"session.command\",\"protocol\":1,\"command\":{\"pane.read\":{\"target\":$pane,\"view\":\"screen\"}}}" > "$out/screen.json"
        if /usr/bin/plutil -extract result.text raw -o - "$out/screen.json" | grep -q CORGI_MAC_HANDOFF_INPUT; then received=1; break; fi
        sleep 0.1
    done
    [[ $received == 1 ]] || { echo 'Input did not reach the retained pane after reload.' >&2; exit 1; }
    echo "CLI and live handoff passed: daemon $before -> $after; pane PID $pane_pid retained and input verified."
else
    echo 'Opening Corgi directly with its default shortcuts (Ctrl+B prefix).'
    echo "Review commands: $bin rpc '{\"op\":\"ping\"}' ; $bin list ; $bin reload"
    # Only this child takes terminal stdin/stdout; piped script stdin is preserved.
    "$bin" --no-update < "$terminal" > "$terminal" 2> "$out/viewer.stderr"
fi
