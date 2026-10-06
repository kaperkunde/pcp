"""PCP's sandbox runner: runs run_code's shell and Python programs.

It runs in a container with no network, beside PCP, and reaches PCP only
through the Unix socket PCP listens on in a volume they share
(PCP_SANDBOX_SOCKET). It says hello with the languages it has, then runs
one program at a time as PCP asks (lib/core/code/sandbox.ts has the
protocol):

- the program runs as its own user (launcher.py), never as the runner's,
  in a directory of its own, with the `pcp` command on its PATH and the
  `pcp` module on its PYTHONPATH;
- its only way to PCP is a socket the runner makes for that program alone
  (PCP_BRIDGE): each request the program sends there is passed on to PCP
  under the program's job, and PCP's reply is passed back; the socket PCP
  listens on is out of the program's reach;
- what it prints (stdout and stderr together) is kept up to the size PCP
  gives, and the rest counted;
- when it ends, is stopped by PCP or runs out of time, every process of the
  program's user is killed and everything it left is removed.

Only the Python standard library is used.
"""

import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time

SOCKET = os.environ.get("PCP_SANDBOX_SOCKET", "/run/pcp/sandbox.sock")
WORK = os.environ.get("PCP_SANDBOX_WORK", "/work")
HERE = os.path.dirname(os.path.realpath(__file__))
LAUNCHER = os.path.join(HERE, "launcher.py")
PROTOCOL = 1
LANGUAGES = ["bash", "python"]
# The least a message from PCP, and a request from a program, may be; PCP
# names larger ones with each run, from the owner's resource settings, up to
# the most these take.
MAX_MESSAGE_BYTES = 24 * 1024 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024
LARGEST_MESSAGE_BYTES = 4 * 1024 * 1024 * 1024
RETRY_SECONDS = 2


def log(message):
    sys.stderr.write(f"[sandbox] {message}\n")
    sys.stderr.flush()


def read_line(sock, limit):
    """One line from a socket, without its newline; None at the end."""
    chunks, size = [], 0
    while True:
        chunk = sock.recv(1 << 16)
        if not chunk:
            return None if not chunks else b"".join(chunks)
        at = chunk.find(b"\n")
        if at != -1:
            chunks.append(chunk[:at])
            return b"".join(chunks)
        chunks.append(chunk)
        size += len(chunk)
        if size > limit:
            raise ValueError("line too long")


class Lines:
    """Lines from PCP's socket, which may arrive several to a read."""

    def __init__(self, sock):
        self.sock = sock
        self.buffer = b""
        self.limit = MAX_MESSAGE_BYTES

    def __iter__(self):
        while True:
            at = self.buffer.find(b"\n")
            while at == -1:
                chunk = self.sock.recv(1 << 20)
                if not chunk:
                    return
                self.buffer += chunk
                if len(self.buffer) > self.limit:
                    raise ValueError("message too long")
                at = self.buffer.find(b"\n")
            line, self.buffer = self.buffer[:at], self.buffer[at + 1 :]
            yield line


class Pcp:
    """The connection to PCP; writes from any thread."""

    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()

    def send(self, message):
        data = json.dumps(message, ensure_ascii=False).encode() + b"\n"
        with self.lock:
            try:
                self.sock.sendall(data)
            except OSError:
                pass


class Job:
    def __init__(self, pcp, message):
        self.pcp = pcp
        self.id = message["job"]
        self.language = message["language"]
        self.code = message["code"]
        self.timeout = max(1.0, min(float(message.get("timeoutMs", 180000)) / 1000, 600))
        self.max_output = int(message.get("maxOutput", 1000000))
        self.max_request = bounded(message.get("maxRequest"), MAX_REQUEST_BYTES)
        name = secrets.token_hex(8)
        self.dir = os.path.join(WORK, f"job-{name}")
        # The bridge socket is the runner's: the program can connect to it,
        # not remove or replace it.
        self.bridge_dir = os.path.join(WORK, f".bridge-{name}")
        self.bridge_path = os.path.join(self.bridge_dir, "bridge.sock")
        self.output = []
        self.kept = 0
        self.dropped = 0
        self.reason = None
        self.lock = threading.Lock()
        self.seq = 0
        self.waiting = {}
        self.over = threading.Event()
        self.process = None

    # The bridge: one request per connection from the program.

    def serve_bridge(self, server):
        while not self.over.is_set():
            try:
                connection, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=self.relay, args=(connection,), daemon=True).start()

    def relay(self, connection):
        with connection:
            try:
                line = read_line(connection, self.max_request)
                request = json.loads(line) if line else None
            except (ValueError, OSError):
                request = None
            if not isinstance(request, dict) or not isinstance(request.get("op"), str):
                self.answer(connection, {"ok": False, "error": "That request is not one PCP takes."})
                return

            with self.lock:
                if self.over.is_set():
                    return
                self.seq += 1
                seq = self.seq
                waiter = {"event": threading.Event(), "reply": None}
                self.waiting[seq] = waiter

            self.pcp.send(
                {
                    "type": "request",
                    "job": self.id,
                    "seq": seq,
                    "op": request["op"],
                    "payload": request.get("payload"),
                }
            )
            waiter["event"].wait()
            if waiter["reply"] is not None:
                self.answer(connection, waiter["reply"])

    def answer(self, connection, reply):
        try:
            connection.sendall(json.dumps(reply, ensure_ascii=False).encode() + b"\n")
        except OSError:
            pass

    def replied(self, seq, reply):
        with self.lock:
            waiter = self.waiting.pop(seq, None)
        if waiter:
            waiter["reply"] = reply
            waiter["event"].set()

    # The program.

    def collect(self, stream):
        while True:
            chunk = stream.read1(1 << 16) if hasattr(stream, "read1") else stream.read(1 << 16)
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace")
            room = self.max_output - self.kept
            if room > 0:
                part = text[:room]
                self.output.append(part)
                self.kept += len(part)
                self.dropped += len(text) - len(part)
            else:
                self.dropped += len(text)

    def stop(self, reason):
        if self.reason is None:
            self.reason = reason
        self.kill()

    def kill(self):
        # The program's session first, which is all of it in development
        # mode (the runner's own user); then, as the program's user, every
        # process it has and every file it left.
        if self.process and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, 9)
            except OSError:
                pass
        subprocess.run(
            [sys.executable, LAUNCHER, "clean", self.dir],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

    def environment(self):
        return {
            "PATH": f"{os.path.join(HERE, 'bin')}:/usr/local/bin:/usr/bin:/bin",
            "HOME": self.dir,
            "TMPDIR": self.dir,
            "LANG": "C.UTF-8",
            "PYTHONPATH": HERE,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PCP_BRIDGE": self.bridge_path,
            **{
                key: os.environ[key]
                for key in ("PCP_SANDBOX_UID", "PCP_SANDBOX_SAME_USER", "PCP_SANDBOX_WORK")
                if key in os.environ
            },
        }

    def run(self):
        error = None
        exit_code = None
        server = None
        try:
            os.makedirs(self.bridge_dir, mode=0o711)
            os.chmod(self.bridge_dir, 0o711)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(self.bridge_path)
            os.chmod(self.bridge_path, 0o666)
            server.listen(16)
            threading.Thread(target=self.serve_bridge, args=(server,), daemon=True).start()

            self.process = subprocess.Popen(
                [sys.executable, LAUNCHER, "run", self.language, self.dir],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=self.environment(),
                start_new_session=True,
            )
            self.process.stdin.write(self.code.encode())
            self.process.stdin.close()
            reader = threading.Thread(target=self.collect, args=(self.process.stdout,), daemon=True)
            reader.start()

            try:
                exit_code = self.process.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                self.stop("timeout")
                exit_code = self.process.wait()
            reader.join(timeout=5)
        except Exception as failure:  # noqa: BLE001 - said to PCP, not raised
            error = f"The sandbox could not run the program: {failure}"
        finally:
            self.over.set()
            self.kill()
            with self.lock:
                for waiter in self.waiting.values():
                    waiter["event"].set()
                self.waiting.clear()
            if server:
                server.close()
            for path in (self.bridge_path, self.bridge_dir):
                try:
                    os.rmdir(path) if path == self.bridge_dir else os.unlink(path)
                except OSError:
                    pass

        message = {
            "type": "done",
            "job": self.id,
            "exit": exit_code,
            "output": "".join(self.output),
            "dropped": self.dropped,
            "reason": self.reason,
        }
        if error:
            message["error"] = error
        self.pcp.send(message)


def bounded(value, least):
    """A size PCP named, no less than the least and no more than the most."""
    if not isinstance(value, int) or isinstance(value, bool):
        return least
    return max(least, min(value, LARGEST_MESSAGE_BYTES))


def serve(sock):
    pcp = Pcp(sock)
    pcp.send({"type": "hello", "protocol": PROTOCOL, "languages": LANGUAGES})
    current = None
    lines = Lines(sock)

    for line in lines:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict):
            continue
        kind = message.get("type")

        if kind == "run":
            if current and not current.over.is_set():
                pcp.send(
                    {
                        "type": "done",
                        "job": message.get("job"),
                        "exit": None,
                        "output": "",
                        "dropped": 0,
                        "error": "The sandbox is running another program.",
                    }
                )
                continue
            if message.get("language") not in LANGUAGES or not isinstance(message.get("code"), str):
                continue
            lines.limit = bounded(message.get("maxMessage"), MAX_MESSAGE_BYTES)
            current = Job(pcp, message)
            threading.Thread(target=current.run, daemon=True).start()
        elif kind == "reply" and current and message.get("job") == current.id:
            reply = message.get("reply")
            if isinstance(reply, dict):
                current.replied(message.get("seq"), reply)
        elif kind == "stop" and current and message.get("job") == current.id:
            threading.Thread(target=current.stop, args=("stopped",), daemon=True).start()

    # PCP went away: nothing runs without it.
    if current and not current.over.is_set():
        current.stop("stopped")


def main():
    os.makedirs(WORK, exist_ok=True)
    waiting_said = False
    while True:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.connect(SOCKET)
        except OSError:
            sock.close()
            if not waiting_said:
                log(f"waiting for PCP on {SOCKET}")
                waiting_said = True
            time.sleep(RETRY_SECONDS)
            continue
        log(f"connected to PCP on {SOCKET}")
        waiting_said = False
        try:
            serve(sock)
        except (OSError, ValueError) as failure:
            log(f"connection lost: {failure}")
        finally:
            sock.close()
        log("PCP went away")
        time.sleep(RETRY_SECONDS)


if __name__ == "__main__":
    main()
