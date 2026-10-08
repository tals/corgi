#!/bin/bash
# Interactive trial using the already-built executable and isolated Corgi state.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[[ $# -le 1 ]] || { echo 'Usage: play.sh [existing-trial-directory]' >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { echo 'A terminal is required; connect with ssh -t.' >&2; exit 1; }
[[ -x "$root/dist/corgi" ]] || { echo "Build first: bun $root/build.ts" >&2; exit 1; }
if [[ $# == 1 ]]; then
    [[ -f "$1/state/corgi/viewer.json" && -d "$1/environment" ]] || {
        echo 'Expected an existing Corgi trial directory.' >&2; exit 1;
    }
    stage=$(CDPATH= cd -- "$1" && pwd)
else
    stage=$(mktemp -d /tmp/corgi-play.XXXXXX)
    mkdir -m 700 -p "$stage/state/corgi" "$stage/environment"
    cat > "$stage/state/corgi/viewer.json" <<'EOF'
{"onboarding_complete":true,"preset":"corgi","prefix":"ctrl_b"}
EOF
fi
export CORGI_SOCKET="$stage/control.sock" CORGI_ENV_DIR="$stage/environment" XDG_STATE_HOME="$stage/state"
unset CORGI_PANE CORGI_APP_EXE
echo "Isolated Corgi trial: $stage"
echo 'Native shortcuts: Ctrl+B, then ? for help; Ctrl+B, then q to detach.'
printf 'Reconnect: %q %q\n' "$root/play.sh" "$stage"
printf 'Daemon log: %s/server.log\n' "$stage"
# Keep the daemon and panes alive after SSH disconnect or viewer detach.
exec "$root/dist/corgi" --no-update
