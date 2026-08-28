okay #!/usr/bin/env python3
"""
Lightweight robot audio transport tester (standard library only).

GUI:
    python robot_audio_transport_test.py

Command line:
    python robot_audio_transport_test.py --cli --destination robot \
        --url ws://192.168.1.199:8765
    python robot_audio_transport_test.py --cli --destination local

The robot test sends a generated tone as 16 kHz, mono, signed 16-bit
little-endian PCM. Audio is split into 20 ms chunks and sent in real time:

    {"audio":{"type":"pcm","sample":"16","seq":1,"data":"..."}}

No third-party Python packages are required. Local playback uses winsound on
Windows, afplay on macOS, and aplay/paplay/ffplay (first available) on Linux.
"""

from __future__ import print_function

import argparse
import base64
import hashlib
import hmac
import json
import math
import os
import queue
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from urllib.parse import urlsplit


DEFAULT_URL = "ws://192.168.1.199:8765"
AUDIO_RATE = 16000
AUDIO_CHANNELS = 1
AUDIO_SAMPLE_WIDTH = 2
AUDIO_CHUNK_MS = 20
DEFAULT_DURATION_S = 2.0
DEFAULT_FREQUENCY_HZ = 440.0
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class TestError(Exception):
    """A user-facing test failure."""


def make_sine_pcm(duration_s=DEFAULT_DURATION_S, rate=AUDIO_RATE,
                  frequency_hz=DEFAULT_FREQUENCY_HZ):
    """Return mono S16_LE PCM with a short fade to avoid speaker clicks."""
    if not 0.1 <= duration_s <= 30.0:
        raise TestError("Duration must be between 0.1 and 30 seconds.")
    if not 20.0 <= frequency_hz <= 4000.0:
        raise TestError("Frequency must be between 20 and 4000 Hz.")

    sample_count = int(rate * duration_s)
    pcm = bytearray(sample_count * AUDIO_SAMPLE_WIDTH)
    amplitude = int(32767 * 0.25)
    fade_samples = min(int(rate * 0.01), max(sample_count // 2, 1))

    for index in range(sample_count):
        gain = 1.0
        if index < fade_samples:
            gain = index / float(fade_samples)
        elif index >= sample_count - fade_samples:
            gain = (sample_count - index - 1) / float(fade_samples)
        sample = int(
            amplitude
            * max(gain, 0.0)
            * math.sin(2.0 * math.pi * frequency_hz * index / rate)
        )
        struct.pack_into("<h", pcm, index * AUDIO_SAMPLE_WIDTH, sample)

    return bytes(pcm)


class SimpleWebSocket:
    """Minimal RFC 6455 client for sending masked text frames over ws/wss."""

    def __init__(self, url, timeout=5.0):
        self.url = url
        self.timeout = timeout
        self.sock = None

    def connect(self):
        parsed = urlsplit(self.url)
        if parsed.scheme not in ("ws", "wss"):
            raise TestError("WebSocket URL must start with ws:// or wss://")
        if not parsed.hostname:
            raise TestError("WebSocket URL is missing a host name or IP address.")

        secure = parsed.scheme == "wss"
        port = parsed.port or (443 if secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        try:
            raw_sock = socket.create_connection(
                (parsed.hostname, port), timeout=self.timeout
            )
            raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            if secure:
                context = ssl.create_default_context()
                raw_sock = context.wrap_socket(
                    raw_sock, server_hostname=parsed.hostname
                )
            self.sock = raw_sock
            self._handshake(parsed.hostname, port, secure, path)
        except TestError:
            self.close(send_close=False)
            raise
        except Exception as exc:
            self.close(send_close=False)
            raise TestError("WebSocket connection failed: %s" % exc)

    def _handshake(self, hostname, port, secure, path):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        default_port = 443 if secure else 80
        host_text = "[%s]" % hostname if ":" in hostname else hostname
        host_header = host_text if port == default_port else "%s:%d" % (host_text, port)
        request = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ) % (path, host_header, key)
        self.sock.sendall(request.encode("ascii"))

        response = bytearray()
        while b"\r\n\r\n" not in response:
            block = self.sock.recv(4096)
            if not block:
                raise TestError("WebSocket server closed during the handshake.")
            response.extend(block)
            if len(response) > 65536:
                raise TestError("WebSocket handshake response was unexpectedly large.")

        header_bytes = bytes(response).split(b"\r\n\r\n", 1)[0]
        try:
            lines = header_bytes.decode("iso-8859-1").split("\r\n")
        except UnicodeDecodeError:
            raise TestError("WebSocket server returned an invalid HTTP response.")

        status_parts = lines[0].split(" ", 2)
        if len(status_parts) < 2 or status_parts[1] != "101":
            raise TestError("WebSocket handshake was rejected: %s" % lines[0])

        headers = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()

        expected = base64.b64encode(
            hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()
        ).decode("ascii")
        actual = headers.get("sec-websocket-accept", "")
        if not hmac.compare_digest(actual, expected):
            raise TestError("WebSocket server returned an invalid accept key.")

    def send_text(self, text):
        if self.sock is None:
            raise TestError("WebSocket is not connected.")
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode, payload):
        # RFC 6455 requires every client-to-server frame to be masked.
        payload_length = len(payload)
        header = bytearray([0x80 | opcode])
        if payload_length <= 125:
            header.append(0x80 | payload_length)
        elif payload_length <= 65535:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", payload_length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", payload_length))

        mask = os.urandom(4)
        masked = bytes(
            value ^ mask[index & 3] for index, value in enumerate(payload)
        )
        try:
            self.sock.sendall(bytes(header) + mask + masked)
        except Exception as exc:
            raise TestError("WebSocket send failed: %s" % exc)

    def close(self, send_close=True):
        sock = self.sock
        self.sock = None
        if sock is None:
            return
        if send_close:
            try:
                self.sock = sock
                self._send_frame(0x8, struct.pack("!H", 1000))
            except Exception:
                pass
            finally:
                self.sock = None
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass


def send_pcm_to_robot(url, pcm, stop_event=None, status=None,
                      rate=AUDIO_RATE, chunk_ms=AUDIO_CHUNK_MS):
    """Send PCM in real-time 20 ms JSON frames. A fresh run starts seq at 1."""
    stop_event = stop_event or threading.Event()
    status = status or (lambda _message: None)
    chunk_bytes = int(rate * AUDIO_SAMPLE_WIDTH * chunk_ms / 1000.0)
    chunk_bytes -= chunk_bytes % AUDIO_SAMPLE_WIDTH
    if chunk_bytes <= 0:
        raise TestError("Calculated PCM chunk size is invalid.")

    frame_count = (len(pcm) + chunk_bytes - 1) // chunk_bytes
    ws = SimpleWebSocket(url)
    status("Connecting to %s ..." % url)
    ws.connect()
    status(
        "Connected. Sending %d frames (%d raw bytes per 20 ms frame)."
        % (frame_count, chunk_bytes)
    )

    sent = 0
    next_deadline = time.monotonic()
    try:
        for offset in range(0, len(pcm), chunk_bytes):
            if stop_event.is_set():
                break

            chunk = pcm[offset:offset + chunk_bytes]
            payload = json.dumps(
                {
                    "audio": {
                        "type": "pcm",
                        "sample": "16",
                        "seq": sent + 1,
                        "data": base64.b64encode(chunk).decode("ascii"),
                    }
                },
                separators=(",", ":"),
                ensure_ascii=True,
            )
            ws.send_text(payload)
            sent += 1

            if sent == 1 or sent % 50 == 0 or sent == frame_count:
                status("Sent %d/%d frames." % (sent, frame_count))

            # Do not pre-send the whole clip. Staying close to real time keeps
            # future stop/duck operations responsive on the robot.
            next_deadline += chunk_ms / 1000.0
            while not stop_event.is_set():
                remaining = next_deadline - time.monotonic()
                if remaining <= 0:
                    break
                stop_event.wait(min(remaining, 0.05))

            if time.monotonic() - next_deadline > 0.2:
                # Avoid a catch-up burst after a long OS scheduling pause.
                next_deadline = time.monotonic()
    finally:
        ws.close()

    return {
        "sent_frames": sent,
        "total_frames": frame_count,
        "stopped": stop_event.is_set(),
    }


def _write_temp_wav(pcm):
    handle, path = tempfile.mkstemp(prefix="robot-audio-test-", suffix=".wav")
    os.close(handle)
    with wave.open(path, "wb") as wav_file:
        wav_file.setnchannels(AUDIO_CHANNELS)
        wav_file.setsampwidth(AUDIO_SAMPLE_WIDTH)
        wav_file.setframerate(AUDIO_RATE)
        wav_file.writeframes(pcm)
    return path


class LocalPlayback:
    """Small cross-platform local WAV player used only by the test UI."""

    def __init__(self):
        self.process = None
        self._lock = threading.Lock()

    def play(self, pcm, stop_event=None, status=None):
        stop_event = stop_event or threading.Event()
        status = status or (lambda _message: None)
        wav_path = _write_temp_wav(pcm)
        try:
            if sys.platform == "win32":
                status("Playing through this computer with Windows winsound.")
                import winsound
                winsound.PlaySound(wav_path, winsound.SND_FILENAME)
            else:
                if sys.platform == "darwin":
                    candidates = [("afplay", ["afplay", wav_path])]
                else:
                    candidates = [
                        ("aplay", ["aplay", "-q", wav_path]),
                        ("paplay", ["paplay", wav_path]),
                        (
                            "ffplay",
                            [
                                "ffplay", "-nodisp", "-autoexit",
                                "-loglevel", "error", wav_path,
                            ],
                        ),
                    ]
                command = next(
                    (cmd for name, cmd in candidates if shutil.which(name)), None
                )
                if command is None:
                    raise TestError(
                        "No local WAV player was found (tried aplay, paplay, ffplay)."
                    )

                status("Playing through this computer with %s." % command[0])
                with self._lock:
                    self.process = subprocess.Popen(
                        command,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                while self.process.poll() is None:
                    if stop_event.wait(0.05):
                        self.process.terminate()
                        break
                return_code = self.process.wait()
                stderr = self.process.stderr.read().decode("utf-8", "replace").strip()
                with self._lock:
                    self.process = None
                if return_code != 0 and not stop_event.is_set():
                    raise TestError(
                        "Local audio player failed: %s"
                        % (stderr or "exit code %d" % return_code)
                    )
        finally:
            try:
                os.unlink(wav_path)
            except OSError:
                pass

        return {"stopped": stop_event.is_set()}

    def stop(self):
        if sys.platform == "win32":
            try:
                import winsound
                winsound.PlaySound(None, winsound.SND_PURGE)
            except Exception:
                pass
        with self._lock:
            if self.process is not None and self.process.poll() is None:
                try:
                    self.process.terminate()
                except Exception:
                    pass


def run_gui():
    try:
        import tkinter as tk
        from tkinter import messagebox, ttk
    except ImportError:
        raise TestError(
            "Tkinter is unavailable. Use --cli, or install Python with Tk support."
        )

    class AudioTestApp:
        def __init__(self, root):
            self.root = root
            self.root.title("Robot Audio Transport Test / 机器人音频传输测试")
            self.root.resizable(False, False)
            self.stop_event = threading.Event()
            self.worker = None
            self.local_playback = LocalPlayback()
            self.events = queue.Queue()
            self.closing = False

            self.destination = tk.StringVar(value="robot")
            self.url = tk.StringVar(value=DEFAULT_URL)
            self.duration = tk.StringVar(value=str(DEFAULT_DURATION_S))
            self.frequency = tk.StringVar(value=str(DEFAULT_FREQUENCY_HZ))
            self.status_text = tk.StringVar(value="Ready / 就绪")

            frame = ttk.Frame(root, padding=16)
            frame.grid(row=0, column=0, sticky="nsew")

            ttk.Label(
                frame,
                text="Playback destination / 播放设备",
                font=("TkDefaultFont", 11, "bold"),
            ).grid(row=0, column=0, columnspan=2, sticky="w")

            ttk.Radiobutton(
                frame,
                text="This computer / 本机扬声器（现有方式）",
                variable=self.destination,
                value="local",
                command=self._destination_changed,
            ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(8, 2))

            ttk.Radiobutton(
                frame,
                text="Robot speaker / 机器人扬声器（WebSocket 传输）",
                variable=self.destination,
                value="robot",
                command=self._destination_changed,
            ).grid(row=2, column=0, columnspan=2, sticky="w", pady=2)

            ttk.Separator(frame).grid(
                row=3, column=0, columnspan=2, sticky="ew", pady=12
            )

            ttk.Label(frame, text="Robot WebSocket URL").grid(
                row=4, column=0, sticky="w", padx=(0, 12)
            )
            self.url_entry = ttk.Entry(frame, textvariable=self.url, width=36)
            self.url_entry.grid(row=4, column=1, sticky="ew")

            ttk.Label(frame, text="Tone duration / 时长（秒）").grid(
                row=5, column=0, sticky="w", pady=(8, 0), padx=(0, 12)
            )
            ttk.Entry(frame, textvariable=self.duration, width=12).grid(
                row=5, column=1, sticky="w", pady=(8, 0)
            )

            ttk.Label(frame, text="Tone frequency / 频率（Hz）").grid(
                row=6, column=0, sticky="w", pady=(8, 0), padx=(0, 12)
            )
            ttk.Entry(frame, textvariable=self.frequency, width=12).grid(
                row=6, column=1, sticky="w", pady=(8, 0)
            )

            note = (
                "Robot mode: 16 kHz · mono · PCM S16_LE · 20 ms frames\n"
                "机器人模式：16 kHz · 单声道 · 16位小端 PCM · 20 ms 分片"
            )
            ttk.Label(frame, text=note, foreground="#555555").grid(
                row=7, column=0, columnspan=2, sticky="w", pady=(12, 0)
            )

            ttk.Label(
                frame,
                textvariable=self.status_text,
                wraplength=430,
                foreground="#1f4e79",
            ).grid(row=8, column=0, columnspan=2, sticky="w", pady=(12, 0))

            buttons = ttk.Frame(frame)
            buttons.grid(row=9, column=0, columnspan=2, sticky="e", pady=(16, 0))
            self.stop_button = ttk.Button(
                buttons, text="Stop / 停止", command=self.stop, state="disabled"
            )
            self.stop_button.grid(row=0, column=0, padx=(0, 8))
            self.run_button = ttk.Button(
                buttons, text="Run audio test / 开始音频测试", command=self.run
            )
            self.run_button.grid(row=0, column=1)

            self.root.protocol("WM_DELETE_WINDOW", self.close)
            self._destination_changed()
            self.root.after(50, self._drain_events)

        def _destination_changed(self):
            state = "normal" if self.destination.get() == "robot" else "disabled"
            self.url_entry.configure(state=state)

        def _set_status(self, message):
            self.events.put(("status", message))

        def _drain_events(self):
            try:
                while True:
                    event_type, value = self.events.get_nowait()
                    if event_type == "status":
                        self.status_text.set(value)
                    elif event_type == "finished":
                        self._finished()
            except queue.Empty:
                pass
            if not self.closing:
                self.root.after(50, self._drain_events)

        def run(self):
            if self.worker is not None and self.worker.is_alive():
                return
            try:
                duration = float(self.duration.get())
                frequency = float(self.frequency.get())
                pcm = make_sine_pcm(duration, AUDIO_RATE, frequency)
                url = self.url.get().strip()
                destination = self.destination.get()
                if destination == "robot" and not url:
                    raise TestError("Enter the robot WebSocket URL.")
            except (ValueError, TestError) as exc:
                messagebox.showerror("Invalid settings / 设置错误", str(exc))
                return

            self.stop_event = threading.Event()
            self.run_button.configure(state="disabled")
            self.stop_button.configure(state="normal")
            self.status_text.set("Starting test / 正在开始测试...")

            def work():
                try:
                    if destination == "robot":
                        result = send_pcm_to_robot(
                            url, pcm, self.stop_event, self._set_status
                        )
                        if result["stopped"]:
                            final = "Stopped after %d frames / 已停止" % result["sent_frames"]
                        else:
                            final = (
                                "Robot test complete: %d frames sent / "
                                "机器人测试完成：已发送 %d 帧"
                            ) % (result["sent_frames"], result["sent_frames"])
                    else:
                        result = self.local_playback.play(
                            pcm, self.stop_event, self._set_status
                        )
                        final = (
                            "Stopped / 已停止"
                            if result and result.get("stopped")
                            else "Local playback complete / 本机播放完成"
                        )
                    self._set_status(final)
                except Exception as exc:
                    self._set_status("Test failed / 测试失败: %s" % exc)
                finally:
                    self.events.put(("finished", None))

            self.worker = threading.Thread(target=work, daemon=True)
            self.worker.start()

        def stop(self):
            self.stop_event.set()
            self.local_playback.stop()
            self.status_text.set("Stopping / 正在停止...")

        def _finished(self):
            self.run_button.configure(state="normal")
            self.stop_button.configure(state="disabled")

        def close(self):
            self.closing = True
            self.stop()
            self.root.destroy()

    root = tk.Tk()
    AudioTestApp(root)
    root.mainloop()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Test local or robot WebSocket audio output with a 16 kHz tone."
    )
    parser.add_argument(
        "--cli", action="store_true", help="run without the graphical interface"
    )
    parser.add_argument(
        "--destination",
        choices=("local", "robot"),
        default="robot",
        help="audio destination in CLI mode (default: robot)",
    )
    parser.add_argument(
        "--url", default=DEFAULT_URL, help="robot WebSocket URL"
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=DEFAULT_DURATION_S,
        help="tone duration in seconds (default: 2)",
    )
    parser.add_argument(
        "--frequency",
        type=float,
        default=DEFAULT_FREQUENCY_HZ,
        help="tone frequency in Hz (default: 440)",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.cli:
        try:
            run_gui()
            return 0
        except Exception as exc:
            print("Unable to start GUI:", exc, file=sys.stderr)
            print("Use --cli to run without the graphical interface.", file=sys.stderr)
            return 1

    stop_event = threading.Event()
    try:
        pcm = make_sine_pcm(args.duration, AUDIO_RATE, args.frequency)
        print(
            "Generated %.2fs %.1fHz tone: %dHz mono PCM S16_LE"
            % (args.duration, args.frequency, AUDIO_RATE)
        )
        if args.destination == "robot":
            result = send_pcm_to_robot(
                args.url, pcm, stop_event, lambda message: print(message)
            )
            print(
                "Robot test complete: %d/%d frames sent."
                % (result["sent_frames"], result["total_frames"])
            )
        else:
            LocalPlayback().play(
                pcm, stop_event, lambda message: print(message)
            )
            print("Local playback complete.")
        return 0
    except KeyboardInterrupt:
        stop_event.set()
        print("Stopped by user.")
        return 130
    except Exception as exc:
        print("Test failed:", exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
