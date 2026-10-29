"""PCP from inside a sandboxed program: call the owner's tools, read and
keep results. A Python program imports it; a shell program runs the `pcp`
command, which is this file:

    import pcp
    issues = pcp.call("github", "list_issues", {"repo": "pcp"})
    handle = pcp.keep("id,title\\n…", name="issues.csv", type="text/csv")
    text = pcp.read(handle)
    pdf = pcp.read(attachment, as_="bytes")
    names = [tool["name"] for tool in pcp.tools("github")]
    schema = pcp.describe("github", "list_issues")["inputSchema"]

    pcp call github list_issues '{"repo": "pcp"}' | jq '.[].number'
    pcp call github list_issues - --fields number,title < args.json
    pcp read '{"$result": "…"}'
    pcp keep --name issues.csv --type text/csv < issues.csv
    pcp read --bytes '{"$result": "…"}' > file.pdf
    pcp keep --bytes --name page.png --type image/png page.png
    pcp tools github | jq -r '.[].name'
    pcp describe github list_issues | jq .inputSchema
    pcp image --max-width 1200 --grayscale '{"$result": "…"}'
    pcp frames --count 5 '{"$result": "…"}'

    small = pcp.image(screenshot, max_width=1200, grayscale=True)
    shots = pcp.frames(video, every=10)

`image` makes a smaller copy of a kept image, which PCP decodes itself;
`frames` takes frames from a kept video with ffmpeg, here in the sandbox,
and keeps each as a JPEG. Both hand back handles.

Each request goes to the runner over the socket named in PCP_BRIDGE, and
from there to PCP, which decides it as it would the assistant's own call:
the token's tools at the token's levels. A refusal, or a tool's error, is
a PcpError (a message on stderr and status 1 for the command). A call to a
tool the owner has to allow first ends the program there.
"""

import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile

__all__ = ["PcpError", "call", "describe", "frames", "image", "keep", "read", "tools"]

# Frames one `frames` takes at most: PCP's MAX_VIDEO_FRAMES
# (lib/core/code/limits.ts), and its defaults.
MAX_FRAMES = 30
DEFAULT_FRAMES = 5
DEFAULT_FRAME_WIDTH = 1280
# How long ffmpeg may take over one look at the video, in seconds.
FFMPEG_TIMEOUT = 60


class PcpError(Exception):
    """PCP refused a request, or the tool answered with an error.

    A call PCP's pacing refused (nothing was sent) has code "paced" and
    retry_after_ms, when the place it calls takes its next action; any
    other has code None.
    """

    def __init__(self, message, code=None, retry_after_ms=None):
        super().__init__(message)
        self.code = code
        self.retry_after_ms = retry_after_ms


def _ask(op, payload):
    path = os.environ.get("PCP_BRIDGE")
    if not path:
        raise PcpError("PCP_BRIDGE is not set: this runs only inside PCP's sandbox.")

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as bridge:
        bridge.connect(path)
        bridge.sendall(
            json.dumps({"op": op, "payload": payload}, ensure_ascii=False).encode()
            + b"\n"
        )
        chunks = []
        while True:
            chunk = bridge.recv(1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
            if chunk.endswith(b"\n"):
                break

    if not chunks:
        raise PcpError("The run is over: PCP did not answer.")

    reply = json.loads(b"".join(chunks))
    if reply.get("ok"):
        return reply.get("value")
    if reply.get("code") == "paced":
        wait = reply.get("retryAfterMs")
        raise PcpError(
            reply.get("error") or "PCP refused that.",
            code="paced",
            retry_after_ms=wait if isinstance(wait, int) and not isinstance(wait, bool) else 0,
        )
    raise PcpError(reply.get("error") or "PCP refused that.")


def _paths(value):
    if value is None:
        return None
    if isinstance(value, str):
        return [part for part in value.split(",") if part]
    return list(value)


def call(server, tool, args=None, *, fields=None, decode=None, keep=None):
    """Runs a tool and returns its answer: the parsed JSON, or the text."""
    payload = {"server": server, "tool": tool, "args": {} if args is None else args}
    for name, value in (("fields", fields), ("decode", decode), ("keep", keep)):
        if value is not None:
            payload[name] = _paths(value)
    return _ask("call", payload)


def read(handle, as_="text"):
    """A kept result, by its handle or its id: its text, or a file's bytes
    as base64 (as_="base64") or as bytes (as_="bytes")."""
    if isinstance(handle, dict):
        handle = handle.get("$result")
    if as_ == "bytes":
        return base64.b64decode(_ask("read", {"id": handle, "as": "base64"}))
    return _ask("read", {"id": handle, "as": as_})


def keep(value, *, name=None, type=None, encoding=None):
    """Keeps a text (or a value, as JSON), or bytes as a file, as a result;
    returns its handle. A text that is base64 is kept as the bytes it
    encodes with encoding="base64"."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        payload = {
            "value": base64.b64encode(bytes(value)).decode("ascii"),
            "encoding": "base64",
            "type": type or "application/octet-stream",
        }
    elif isinstance(value, str) and encoding == "base64":
        payload = {"value": value, "encoding": "base64"}
        if type is not None:
            payload["type"] = type
    elif isinstance(value, str):
        payload = {"value": value, "type": type or "text/plain"}
    else:
        payload = {"value": json.dumps(value), "type": type or "application/json"}
    if name is not None:
        payload["name"] = name
    return _ask("keep", payload)


def tools(server=None):
    """The servers this program may call, or with a server's name, its tools
    and whether each runs at once ("allowed") or asks the owner ("ask")."""
    return _ask("tools", {"server": server})


def describe(server, tool):
    """One tool as describe gives it, without a call_handle (call takes
    names): its inputSchema, the arguments call takes, what it returns,
    whether it runs at once ("allowed") or asks the owner ("ask"), and its
    annotations."""
    return _ask("describe", {"server": server, "tool": tool})


def _id(handle):
    return handle.get("$result") if isinstance(handle, dict) else handle


def image(handle, *, max_width=None, max_height=None, crop=None, grayscale=None,
          format=None, quality=None):
    """A smaller copy of a kept image (PNG, JPEG, WebP or GIF), made by PCP:
    crop=(x, y, width, height) first, then fit within max_width and
    max_height, grey, and encoded as format ("jpeg", "webp" or "png") at
    quality. Returns {"handle", "width", "height", "bytes", "type"}."""
    options = {}
    for name, value in (("maxWidth", max_width), ("maxHeight", max_height),
                        ("grayscale", grayscale), ("format", format),
                        ("quality", quality)):
        if value is not None:
            options[name] = value
    if crop is not None:
        if isinstance(crop, dict):
            options["crop"] = crop
        else:
            x, y, width, height = crop
            options["crop"] = {"x": x, "y": y, "width": width, "height": height}
    return _ask("media", {"kind": "image", "id": _id(handle), "options": options})


def _ffmpeg(arguments):
    # Files only: a video that names another file or an address (a playlist)
    # is not followed.
    try:
        return subprocess.run(
            [arguments[0], "-v", "error", "-protocol_whitelist", "file", *arguments[1:]],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=FFMPEG_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise PcpError(f"ffmpeg took longer than {FFMPEG_TIMEOUT} seconds.") from None


def _said(done):
    text = done.stderr.decode("utf-8", "replace").strip().splitlines()
    return text[-1][:300] if text else f"status {done.returncode}"


def frames(handle, *, at=None, every=None, count=None, max_width=None):
    """Frames of a kept video, taken with ffmpeg here and kept as JPEGs: at
    the times in at (seconds), every so many seconds, or count of them
    spread over the video (5 when none is named), each at most max_width
    pixels wide (1280). Returns {"duration", "width", "height",
    "frames": [{"t", "handle"}]}."""
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise PcpError("ffmpeg is not in this sandbox: update the sandbox's image.")
    if len([value for value in (at, every, count) if value is not None]) > 1:
        raise PcpError("Name one of at, every or count.")
    width_limit = int(max_width if max_width is not None else DEFAULT_FRAME_WIDTH)
    if not 16 <= width_limit <= 16384:
        raise PcpError("max_width is 16 to 16384 pixels.")

    data = read(handle, as_="bytes")
    work = tempfile.mkdtemp(prefix="frames-")
    try:
        video = os.path.join(work, "video")
        with open(video, "wb") as target:
            target.write(data)
        del data

        probed = _ffmpeg(["ffprobe", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height:format=duration", "-of", "json", video])
        if probed.returncode != 0:
            raise PcpError(f"ffmpeg cannot read that video: {_said(probed)}")
        info = json.loads(probed.stdout or b"{}")
        streams = info.get("streams") or []
        if not streams:
            raise PcpError("That file has no video in it.")
        try:
            duration = float((info.get("format") or {}).get("duration") or 0)
        except ValueError:
            duration = 0.0
        width = int(streams[0].get("width") or 0)
        height = int(streams[0].get("height") or 0)

        if at is not None:
            times = [float(time) for time in at]
        elif every is not None:
            step = float(every)
            if step <= 0:
                raise PcpError("every is a number of seconds, more than 0.")
            times, time = [], 0.0
            while time < max(duration, step / 2) and len(times) <= MAX_FRAMES:
                times.append(round(time, 3))
                time += step
        else:
            many = int(count if count is not None else DEFAULT_FRAMES)
            if not 1 <= many <= MAX_FRAMES:
                raise PcpError(f"count is 1 to {MAX_FRAMES} frames.")
            times = [round(duration * (index + 0.5) / many, 3) for index in range(many)]

        if not 1 <= len(times) <= MAX_FRAMES:
            raise PcpError(
                f"Take 1 to {MAX_FRAMES} frames at once (a longer every, or a count)."
            )
        if any(time < 0 or (duration > 0 and time >= duration) for time in times):
            raise PcpError(f"The video is {duration:.2f} seconds long: ask for times within it.")

        taken = []
        for index, time in enumerate(times):
            target = os.path.join(work, f"{index}.jpg")
            done = _ffmpeg(["ffmpeg", "-nostdin", "-threads", "1", "-ss", f"{time:.3f}",
                            "-i", video, "-frames:v", "1", "-an", "-sn", "-dn",
                            "-vf", f"scale='min(iw,{width_limit})':-2", "-q:v", "4",
                            "-f", "image2", "-c:v", "mjpeg", "-y", target])
            if done.returncode != 0 or not os.path.exists(target) or os.path.getsize(target) == 0:
                raise PcpError(f"ffmpeg took no frame at {time:g} seconds: {_said(done)}")
            with open(target, "rb") as source:
                frame = source.read()
            os.remove(target)
            taken.append({
                "t": int(time) if time.is_integer() else time,
                "handle": keep(frame, name=f"frame-{time:g}s.jpg", type="image/jpeg"),
            })

        return {"duration": duration, "width": width, "height": height, "frames": taken}
    finally:
        shutil.rmtree(work, ignore_errors=True)


USAGE = """usage:
  pcp call SERVER TOOL [ARGS_JSON | -] [--fields A,B] [--decode A] [--keep A]
  pcp read [--base64 | --bytes] HANDLE_OR_ID
  pcp keep [--name NAME] [--type TYPE] [--bytes] [FILE]
  pcp tools [SERVER]
  pcp describe SERVER TOOL
  pcp image [--max-width N] [--max-height N] [--crop X,Y,W,H] [--grayscale]
            [--format jpeg|webp|png] [--quality Q] HANDLE_OR_ID
  pcp frames [--at T,T,… | --every S | --count N] [--max-width N] HANDLE_OR_ID"""


def _handle(text):
    return json.loads(text) if text.lstrip().startswith("{") else text


def _number(text, name):
    try:
        value = float(text)
    except ValueError:
        raise PcpError(f"--{name} is a number.\n{USAGE}") from None
    return int(value) if value.is_integer() else value


def _options(argv, names, flags=()):
    rest, options = [], {}
    index = 0
    while index < len(argv):
        word = argv[index]
        if word.startswith("--") and word[2:] in flags:
            options[word[2:]] = True
            index += 1
        elif word.startswith("--") and word[2:] in names:
            if index + 1 >= len(argv):
                raise PcpError(f"{word} needs a value.\n{USAGE}")
            options[word[2:]] = argv[index + 1]
            index += 2
        else:
            rest.append(word)
            index += 1
    return rest, options


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if not argv:
            raise PcpError(USAGE)
        command, argv = argv[0], argv[1:]

        if command == "call":
            rest, options = _options(argv, {"fields", "decode", "keep"})
            if len(rest) not in (2, 3):
                raise PcpError(USAGE)
            text = rest[2] if len(rest) == 3 else "{}"
            if text == "-":
                text = sys.stdin.read()
            try:
                args = json.loads(text)
            except json.JSONDecodeError as error:
                raise PcpError(f"The arguments are not JSON: {error}") from None
            value = call(rest[0], rest[1], args, **options)
            sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        elif command == "read":
            rest, options = _options(argv, set(), {"base64", "bytes"})
            if len(rest) != 1 or len(options) > 1:
                raise PcpError(USAGE)
            handle = rest[0]
            if handle.lstrip().startswith("{"):
                handle = json.loads(handle)
            if options.get("bytes"):
                sys.stdout.flush()
                sys.stdout.buffer.write(read(handle, as_="bytes"))
            else:
                sys.stdout.write(read(handle, as_="base64" if options else "text"))
        elif command == "keep":
            rest, options = _options(argv, {"name", "type"}, {"bytes"})
            if len(rest) > 1:
                raise PcpError(USAGE)
            raw = options.get("bytes", False)
            if rest and rest[0] != "-":
                with open(rest[0], "rb" if raw else "r", **({} if raw else {"encoding": "utf-8"})) as source:
                    value = source.read()
            else:
                value = sys.stdin.buffer.read() if raw else sys.stdin.read()
            handle = keep(value, name=options.get("name"), type=options.get("type"))
            sys.stdout.write(json.dumps(handle) + "\n")
        elif command == "tools":
            if len(argv) > 1:
                raise PcpError(USAGE)
            value = tools(argv[0] if argv else None)
            sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        elif command == "describe":
            if len(argv) != 2:
                raise PcpError(USAGE)
            value = describe(argv[0], argv[1])
            sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        elif command == "image":
            rest, options = _options(
                argv, {"max-width", "max-height", "crop", "format", "quality"}, {"grayscale"}
            )
            if len(rest) != 1:
                raise PcpError(USAGE)
            crop = None
            if "crop" in options:
                parts = options["crop"].split(",")
                if len(parts) != 4:
                    raise PcpError(f"--crop is X,Y,WIDTH,HEIGHT.\n{USAGE}")
                crop = tuple(_number(part, "crop") for part in parts)
            value = image(
                _handle(rest[0]),
                max_width=_number(options["max-width"], "max-width") if "max-width" in options else None,
                max_height=_number(options["max-height"], "max-height") if "max-height" in options else None,
                crop=crop,
                grayscale=True if options.get("grayscale") else None,
                format=options.get("format"),
                quality=_number(options["quality"], "quality") if "quality" in options else None,
            )
            sys.stdout.write(json.dumps(value) + "\n")
        elif command == "frames":
            rest, options = _options(argv, {"at", "every", "count", "max-width"})
            if len(rest) != 1:
                raise PcpError(USAGE)
            value = frames(
                _handle(rest[0]),
                at=[_number(part, "at") for part in options["at"].split(",") if part]
                if "at" in options else None,
                every=_number(options["every"], "every") if "every" in options else None,
                count=_number(options["count"], "count") if "count" in options else None,
                max_width=_number(options["max-width"], "max-width") if "max-width" in options else None,
            )
            sys.stdout.write(json.dumps(value) + "\n")
        else:
            raise PcpError(USAGE)
    except PcpError as error:
        sys.stderr.write(f"pcp: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
