#!/bin/sh
# Run the Corgi viewer in a browser. The viewer attaches only to a terminal,
# so ttyd supplies one on localhost. Set CORGI_TUNNEL_MAIL and cloudflared
# publishes that page; Cloudflare sends a one-time PIN to that address.
set -eu

port=${CORGI_WEB_PORT:-7681}
state=${CORGI_WEB_STATE:-${HOME}/.local/state/corgi-web}
run=${state}/run

if [ -n "${CORGI_BIN:-}" ]; then
  corgi=$CORGI_BIN
else
  corgi=$(command -v corgi) || {
    echo "corgi: corgi is not on PATH" >&2
    exit 1
  }
fi
if [ -n "${TTYD:-}" ]; then
  ttyd=$TTYD
else
  ttyd=$(command -v ttyd) || {
    echo "corgi: ttyd is not on PATH" >&2
    exit 1
  }
fi

mkdir -p "$state"
mkdir -p -m 700 "$run"
chmod 700 "$run"
if stat -c %a "$run" >/dev/null 2>&1; then
  mode=$(stat -c %a "$run")
else
  mode=$(stat -f %Lp "$run")
fi
case $mode in
  700) ;;
  *)
    echo "corgi: $run is mode $mode. The socket directory has to be private (700) on a normal filesystem." >&2
    exit 1
    ;;
esac

export XDG_STATE_HOME="$state"
export CORGI_SOCKET="$run/control.sock"
export TERM=${TERM:-xterm-256color}
export COLORTERM=${COLORTERM:-truecolor}

echo "corgi: viewer at http://127.0.0.1:${port}/" >&2
set -- "$ttyd" -i 127.0.0.1 -p "$port" -W -m 2 -T xterm-256color -- "$corgi"
if [ -z "${CORGI_TUNNEL_MAIL:-}" ]; then
  exec "$@"
fi

command -v cloudflared >/dev/null || {
  echo "corgi: cloudflared is not on PATH" >&2
  exit 1
}
command -v curl >/dev/null || {
  echo "corgi: curl is not on PATH" >&2
  exit 1
}

"$@" &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT INT TERM
i=0
while [ "$i" -lt 50 ]; do
  if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:${port}/"; then
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "corgi: ttyd exited before it listened" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.1
done
if ! curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:${port}/"; then
  echo "corgi: ttyd did not accept connections on ${port}" >&2
  exit 1
fi

exec cloudflared tunnel --no-autoupdate --allowed-mail "$CORGI_TUNNEL_MAIL" --url "http://127.0.0.1:${port}"
