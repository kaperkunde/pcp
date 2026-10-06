"""PCP from inside a sandboxed program: call the owner's tools, read and
keep results. A Python program imports it; a shell program runs the `pcp`
command, which is this file:

    import pcp
    issues = pcp.call("github", "list_issues", {"repo": "pcp"})
    handle = pcp.keep("id,title\\n…", name="issues.csv", type="text/csv")
    text = pcp.read(handle)

    pcp call github list_issues '{"repo": "pcp"}' | jq '.[].number'
    pcp call github list_issues - --fields number,title < args.json
    pcp read '{"$result": "…"}'
    pcp keep --name issues.csv --type text/csv < issues.csv

Each request goes to the runner over the socket named in PCP_BRIDGE, and
from there to PCP, which decides it as it would the assistant's own call:
the token's tools at the token's levels. A refusal, or a tool's error, is
a PcpError (a message on stderr and status 1 for the command). A call to a
tool the owner has to allow first ends the program there.
"""

import json
import os
import socket
import sys

__all__ = ["PcpError", "call", "keep", "read"]


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


def read(handle):
    """The text of a kept result, by its handle or its id."""
    if isinstance(handle, dict):
        handle = handle.get("$result")
    return _ask("read", {"id": handle})


def keep(value, *, name=None, type=None):
    """Keeps a text (or a value, as JSON) as a result; returns its handle."""
    if isinstance(value, str):
        payload = {"value": value, "type": type or "text/plain"}
    else:
        payload = {"value": json.dumps(value), "type": type or "application/json"}
    if name is not None:
        payload["name"] = name
    return _ask("keep", payload)


USAGE = """usage:
  pcp call SERVER TOOL [ARGS_JSON | -] [--fields A,B] [--decode A] [--keep A]
  pcp read HANDLE_OR_ID
  pcp keep [--name NAME] [--type TYPE] [FILE]"""


def _options(argv, names):
    rest, options = [], {}
    index = 0
    while index < len(argv):
        word = argv[index]
        if word.startswith("--") and word[2:] in names:
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
            if len(argv) != 1:
                raise PcpError(USAGE)
            handle = argv[0]
            if handle.lstrip().startswith("{"):
                handle = json.loads(handle)
            sys.stdout.write(read(handle))
        elif command == "keep":
            rest, options = _options(argv, {"name", "type"})
            if len(rest) > 1:
                raise PcpError(USAGE)
            if rest and rest[0] != "-":
                with open(rest[0], encoding="utf-8") as source:
                    text = source.read()
            else:
                text = sys.stdin.read()
            handle = keep(text, name=options.get("name"), type=options.get("type"))
            sys.stdout.write(json.dumps(handle) + "\n")
        else:
            raise PcpError(USAGE)
    except PcpError as error:
        sys.stderr.write(f"pcp: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
