"""PCP from inside a sandboxed program: call the owner's tools, read and
keep results. A Python program imports it; a shell program runs the `pcp`
command, which is this file:

    import pcp
    issues = pcp.call("github", "list_issues", {"repo": "pcp"})
    handle = pcp.keep("id,title\\n…", name="issues.csv", type="text/csv")
    text = pcp.read(handle)
    pdf = pcp.read(attachment, as_="bytes")
    names = [tool["name"] for tool in pcp.tools("github")]

    pcp call github list_issues '{"repo": "pcp"}' | jq '.[].number'
    pcp call github list_issues - --fields number,title < args.json
    pcp read '{"$result": "…"}'
    pcp keep --name issues.csv --type text/csv < issues.csv
    pcp read --bytes '{"$result": "…"}' > file.pdf
    pcp keep --bytes --name page.png --type image/png page.png
    pcp tools github | jq -r '.[].name'

Each request goes to the runner over the socket named in PCP_BRIDGE, and
from there to PCP, which decides it as it would the assistant's own call:
the token's tools at the token's levels. A refusal, or a tool's error, is
a PcpError (a message on stderr and status 1 for the command). A call to a
tool the owner has to allow first ends the program there.
"""

import base64
import json
import os
import socket
import sys

__all__ = ["PcpError", "call", "keep", "read", "tools"]


class PcpError(Exception):
    """PCP refused a request, or the tool answered with an error."""


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


USAGE = """usage:
  pcp call SERVER TOOL [ARGS_JSON | -] [--fields A,B] [--decode A] [--keep A]
  pcp read [--base64 | --bytes] HANDLE_OR_ID
  pcp keep [--name NAME] [--type TYPE] [--bytes] [FILE]
  pcp tools [SERVER]"""


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
        else:
            raise PcpError(USAGE)
    except PcpError as error:
        sys.stderr.write(f"pcp: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
