"""Stand-in for Woodshed Amp's WebSocket side, for testing the website without an audio interface.

Speaks the same protocol (hello/presets/devices/status JSON + WSA1 audio frames) on 127.0.0.1:47800 and streams a
plucked-string test tone (A2 = 110 Hz then E3 = 164.8 Hz, alternating every second) as the "dry guitar".
Usage: python -I tests/fake_amp.py   (Ctrl+C to stop). Standard library only.
"""
import base64
import hashlib
import json
import math
import socket
import struct
import threading
import time

SR = 48000
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PRESETS = ["clean", "jazz", "breakup", "crunch", "rock_lead", "high_gain", "metal", "fuzz", "acoustic", "bass"]


def frame(payload: bytes, opcode: int) -> bytes:
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack(">H", n)
    else:
        head += bytes([127]) + struct.pack(">Q", n)
    return head + payload


def read_frame(sock):
    h = sock.recv(2)
    if len(h) < 2:
        return None, None
    op = h[0] & 0x0F
    n = h[1] & 0x7F
    if n == 126:
        n = struct.unpack(">H", sock.recv(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", sock.recv(8))[0]
    mask = sock.recv(4)
    data = b""
    while len(data) < n:
        data += sock.recv(n - len(data))
    return op, bytes(b ^ mask[i % 4] for i, b in enumerate(data))


def tone():
    """Endless plucked-string-like tone: decaying harmonics, new pluck every second, alternating notes."""
    i = 0
    while True:
        f = 110.0 if (i // SR) % 2 == 0 else 164.81
        t = (i % SR) / SR
        env = math.exp(-3.0 * t)
        s = sum(a * math.sin(2 * math.pi * f * k * t) for k, a in ((1, 0.6), (2, 0.5), (3, 0.3), (4, 0.15)))
        yield max(-1.0, min(1.0, 0.5 * env * s))
        i += 1


def client(conn):
    req = b""
    while b"\r\n\r\n" not in req:
        chunk = conn.recv(4096)
        if not chunk:
            return
        req += chunk
    key = [l.split(":", 1)[1].strip() for l in req.decode().split("\r\n") if l.lower().startswith("sec-websocket-key")][0]
    acc = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {acc}\r\n\r\n").encode())
    state = {"stream": False, "preset": "crunch", "alive": True}
    lock = threading.Lock()

    def send_json(o):
        with lock:
            conn.sendall(frame(json.dumps(o).encode(), 1))

    def status():
        return {"type": "status", "running": True, "device": "Fake Amp", "sampleRate": SR, "bufferFrames": 64,
                "inputMs": 2.0, "outputMs": 2.5, "roundTripMs": 4.5, "inPeakDb": -12, "outPeakDb": -8, "clip": False,
                "cpu": 0.05, "xruns": 0, "bypass": False, "mute": False, "preset": state["preset"],
                "streamDrops": 0, "inputChannel": 0}

    def pump():
        gen = tone()
        idx = 0
        nxt = time.perf_counter()
        last_status = 0
        while state["alive"]:
            nxt += 0.005
            if state["stream"]:
                samples = [next(gen) for _ in range(240)]
                body = struct.pack("<4sIII", b"WSA1", SR, idx, 240) + struct.pack("<240h", *(int(s * 32767) for s in samples))
                idx += 240
                with lock:
                    conn.sendall(frame(body, 2))
            if time.perf_counter() - last_status > 0.25:
                last_status = time.perf_counter()
                send_json(status())
            time.sleep(max(0, nxt - time.perf_counter()))

    threading.Thread(target=pump, daemon=True).start()
    try:
        while True:
            op, data = read_frame(conn)
            if op is None or op == 8:
                break
            if op != 1:
                continue
            m = json.loads(data)
            print("<-", m)
            t = m.get("type")
            if t == "hello":
                send_json({"type": "hello", "app": "woodshed-amp", "version": "fake", "protocol": 1})
                send_json({"type": "presets", "current": state["preset"],
                           "list": [{"id": p, "name": p.replace("_", " ").title(), "nam": None, "namIncludesCab": False,
                                     "ir": None, "params": {"gain": 5}} for p in PRESETS]})
                send_json({"type": "devices", "list": ["Fake Amp"], "current": "Fake Amp"})
            elif t == "stream":
                state["stream"] = bool(m.get("on"))
            elif t == "preset":
                state["preset"] = m.get("id")
    finally:
        state["alive"] = False
        conn.close()


def main():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 47800))
    srv.listen()
    print("fake amp on 127.0.0.1:47800")
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=client, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
