#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
usage() {
    cat <<'EOF'
Usage: ./go.sh [--temp | --env NAME] [--reload | --restart] [COMMAND ...]

  --temp       Fresh isolated Corgi environment on every launch
  --env NAME   Reuse a named environment with its own setup and saved state
  --reload     Rebuild and reload the selected runtime without stopping panes
  --restart    Confirm before stopping and restarting the selected runtime

With no command, start or attach. Use "onboard" to reopen onboarding.
Launching the main environment stops all other Corgi daemons owned by you.
Temporary runtimes keep running after detach; shutdown still asks for confirmation.
EOF
}
fail() {
    printf 'corgi: %s\n' "$1" >&2
    exit 1
}
environment=
environment_name=
runtime_action=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --temp)
            [ -z "$environment" ] || fail 'choose either --temp or --env NAME, once'
            environment=temp
            shift
            ;;
        --env)
            [ -z "$environment" ] || fail 'choose either --temp or --env NAME, once'
            [ "$#" -ge 2 ] || fail '--env requires a name'
            environment=named
            environment_name=$2
            case "$environment_name" in
                ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_-]*)
                    fail 'environment names must start with a letter or digit and contain only letters, digits, _ or -'
                    ;;
            esac
            [ "${#environment_name}" -le 32 ] || fail 'environment names must be at most 32 characters'
            shift 2
            ;;
        --reload|--restart)
            [ -z "$runtime_action" ] || fail 'choose either --reload or --restart, once'
            runtime_action=$1
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        *) break ;;
    esac
done

if [ -n "$environment" ]; then
    # Retain the original state root in child shells so selecting another named
    # environment never nests it inside the current environment's XDG root.
    CORGI_ENV_BASE=${CORGI_ENV_BASE:-${XDG_STATE_HOME:-$HOME/.local/state}}
    case "$CORGI_ENV_BASE" in
        /*) ;;
        *) CORGI_ENV_BASE=$PWD/$CORGI_ENV_BASE ;;
    esac
    if [ "$environment" = temp ]; then
        [ -z "${CORGI_PANE:-}" ] || fail 'launch a fresh environment from a terminal outside Corgi'
        CORGI_ENV_DIR=$(mktemp -d "/tmp/corgi-temp-$(id -u).XXXXXX")
        environment_socket=$CORGI_ENV_DIR/control.sock
    else
        CORGI_ENV_DIR=$CORGI_ENV_BASE/corgi/environments/$environment_name
        # Keep AF_UNIX paths short even when the state directory is long. Include
        # the full state path so different state roots cannot share a runtime.
        if command -v shasum >/dev/null 2>&1; then
            environment_hash=$(printf '%s' "$CORGI_ENV_DIR" | shasum -a 256)
        elif command -v sha256sum >/dev/null 2>&1; then
            environment_hash=$(printf '%s' "$CORGI_ENV_DIR" | sha256sum)
        else
            fail '--env requires shasum or sha256sum'
        fi
        environment_hash=$(printf '%.32s' "$environment_hash")
        environment_socket=/tmp/corgi-env-$(id -u)-$environment_hash/control.sock
        if [ -n "${CORGI_PANE:-}" ] && [ "${CORGI_SOCKET:-}" != "$environment_socket" ]; then
            fail 'launch a different environment from a terminal outside Corgi'
        fi
    fi
    # Only newly created directories get the private umask; do not change the
    # permissions of the user's existing state directories or child shells.
    (umask 077; mkdir -p "$CORGI_ENV_DIR/state" "$(dirname -- "$environment_socket")")
    CORGI_SOCKET=$environment_socket
    XDG_STATE_HOME=$CORGI_ENV_DIR/state
    export CORGI_SOCKET XDG_STATE_HOME CORGI_ENV_BASE CORGI_ENV_DIR
    if [ "$environment" = temp ]; then
        printf 'corgi: temporary environment %s\n' "$CORGI_ENV_DIR" >&2
        printf 'corgi: reconnect: CORGI_ENV_DIR=%s CORGI_SOCKET=%s XDG_STATE_HOME=%s ./go.sh\n' \
            "$CORGI_ENV_DIR" "$CORGI_SOCKET" "$XDG_STATE_HOME" >&2
    else
        printf 'corgi: environment %s (%s)\n' "$environment_name" "$CORGI_ENV_DIR" >&2
    fi
fi

confirm_shutdown() {
    printf '%s\n' 'corgi: this will terminate all subterminals and their running processes.' >&2
    if [ ! -t 0 ]; then
        echo 'corgi: confirmation requires an interactive terminal; cancelled.' >&2
        exit 1
    fi
    printf 'Terminate them? Type yes to confirm [no]: ' >&2
    answer=
    if ! IFS= read -r answer || [ "$answer" != yes ]; then
        echo 'corgi: cancelled; subterminals were left running.' >&2
        exit 1
    fi
}
# Local development retains the signing identity without needing Apple's timestamp service.
"$root/scripts/zig" build -Doptimize=ReleaseSafe -Dsigning-timestamp=false
main_socket=/tmp/corgi-$(id -u)/control.sock
if [ -z "$environment" ] && [ "${CORGI_SOCKET:-$main_socket}" = "$main_socket" ]; then
    bun "$root/scripts/stop-other-daemons.ts"
fi
if [ "$runtime_action" = "--reload" ]; then
    "$root/zig-out/bin/corgi" reload
    if [ "$#" -eq 0 ]; then exit 0; fi
fi
if [ "$runtime_action" = "--restart" ]; then
    binary="$root/zig-out/bin/corgi"
    if "$binary" ping >/dev/null 2>&1; then
        confirm_shutdown
        "$binary" shutdown >/dev/null
        socket=${CORGI_SOCKET:-/tmp/corgi-$(id -u)/control.sock}
        attempts=0
        # Shutdown acknowledges before cleanup finishes. Wait for the old
        # socket to disappear so startup cannot reattach to the exiting server.
        while [ -S "$socket" ]; do
            attempts=$((attempts + 1))
            if [ "$attempts" -ge 100 ]; then
                echo 'corgi: runtime did not stop within 5 seconds' >&2
                exit 1
            fi
            sleep 0.05
        done
    fi
fi
if [ "${1:-}" = shutdown ]; then
    confirm_shutdown
fi
if [ "$#" -eq 0 ]; then
    set -- dev
fi
exec "$root/zig-out/bin/corgi" "$@"
