#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
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
"$root/scripts/zig" build -Doptimize=ReleaseSafe
if [ "${1:-}" = "--reload" ]; then
    shift
    "$root/zig-out/bin/corgi" reload
    if [ "$#" -eq 0 ]; then exit 0; fi
fi
if [ "${1:-}" = "--restart" ]; then
    shift
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
