#!/usr/bin/env python3
"""Independent TCP payload-rate check; no application or SSH protocol involved."""
import json
import socket
import sys
import time

if sys.argv[1] == "server":
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", 3333))
    listener.listen()
    while True:
        conn, _ = listener.accept()
        with conn:
            conn.recv(1)
            conn.sendall(b"x" * (128 * 1024))
else:
    with socket.create_connection(("10.203.1.2", 3333)) as conn:
        conn.sendall(b"B")
        start = time.monotonic()
        received, half = 0, None
        while data := conn.recv(4096):
            received += len(data)
            if received >= 64 * 1024 and half is None:
                half = time.monotonic()
        end = time.monotonic()
        print(json.dumps({"bytes": received, "seconds": end - start,
                          "tail64_kbit_s": 64 * 1024 * 8 / (end - half) / 1000}))
