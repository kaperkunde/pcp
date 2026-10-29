import net from "node:net"

/**
 * An exit container's proxy for tests: HTTP CONNECT (gluetun's) or SOCKS5
 * with a user name and password (RFC 1928 and 1929, wireproxy's), on
 * loopback, behind the test SSH server's forwarding. It records each
 * destination it was asked for and the login it got, and connects a
 * destination to a server of the test's own (`connectTo`), or refuses it.
 * Never used outside tests.
 */

export type FakeProxyOptions = {
  protocol: "http" | "socks5"
  /** The login it takes; none: it asks for none. */
  auth?: () => { username: string; password: string } | null
  /**
   * Where a destination really goes. "accept" answers yes and closes the
   * tunnel at once (enough for a health check); null refuses it.
   */
  connectTo: (
    host: string,
    port: number,
  ) => { host: string; port: number } | "accept" | null
}

export type FakeProxy = {
  port: number
  /** Destinations asked for, as host:port, in order. */
  asked: string[]
  /** The logins it was given, as user:password. */
  logins: string[]
  close: () => Promise<void>
}

function readMore(socket: net.Socket, buffered: { data: Buffer }) {
  return new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffered.data = Buffer.concat([buffered.data, chunk])
      done()
      resolve()
    }
    const onEnd = () => {
      done()
      reject(new Error("closed"))
    }
    const done = () => {
      socket.off("data", onData)
      socket.off("end", onEnd)
      socket.off("error", onEnd)
    }
    socket.on("data", onData)
    socket.once("end", onEnd)
    socket.once("error", onEnd)
  })
}

async function take(
  socket: net.Socket,
  buffered: { data: Buffer },
  count: number,
): Promise<Buffer> {
  while (buffered.data.length < count) {
    await readMore(socket, buffered)
  }

  const head = buffered.data.subarray(0, count)
  buffered.data = buffered.data.subarray(count)
  return head
}

function pipeTo(
  client: net.Socket,
  target: { host: string; port: number },
  rest: Buffer,
  onOpen: () => void,
  onFail: () => void,
) {
  const far = net.connect(target.port, target.host)
  far.once("connect", () => {
    onOpen()
    if (rest.length > 0) far.write(rest)
    client.pipe(far)
    far.pipe(client)
  })
  far.once("error", () => {
    onFail()
    client.destroy()
  })
  client.once("close", () => far.destroy())
}

export async function startFakeProxy(
  options: FakeProxyOptions,
): Promise<FakeProxy> {
  const asked: string[] = []
  const logins: string[] = []
  const sockets = new Set<net.Socket>()

  const http = async (client: net.Socket) => {
    const buffered = { data: Buffer.alloc(0) }

    while (!buffered.data.includes("\r\n\r\n")) {
      await readMore(client, buffered)
    }

    const end = buffered.data.indexOf("\r\n\r\n")
    const head = buffered.data.subarray(0, end).toString("latin1")
    const rest = buffered.data.subarray(end + 4)
    const [line, ...headers] = head.split("\r\n")
    const target = /^CONNECT (\[[^\]]+\]|[^:]+):(\d+) HTTP\/1\.1$/.exec(
      line ?? "",
    )

    if (!target) {
      client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n")
      return
    }

    const host = target[1]!.replace(/^\[|\]$/g, "")
    const port = Number(target[2])
    asked.push(`${host}:${port}`)
    const authorization = headers
      .find((header) => /^proxy-authorization:/i.test(header))
      ?.replace(/^proxy-authorization:\s*basic\s+/i, "")
    const given = authorization
      ? Buffer.from(authorization, "base64").toString("utf8")
      : null

    if (given) logins.push(given)
    const wanted = options.auth?.()

    if (wanted && given !== `${wanted.username}:${wanted.password}`) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
      return
    }

    const to = options.connectTo(host, port)

    if (to === null) {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      return
    }

    if (to === "accept") {
      client.end("HTTP/1.1 200 Connection established\r\n\r\n")
      return
    }

    pipeTo(
      client,
      to,
      rest,
      () => client.write("HTTP/1.1 200 Connection established\r\n\r\n"),
      () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
    )
  }

  const socks5 = async (client: net.Socket) => {
    const buffered = { data: Buffer.alloc(0) }
    const [version, count] = await take(client, buffered, 2)
    const methods = [...(await take(client, buffered, count!))]
    const wanted = options.auth?.()

    if (version !== 5) {
      client.destroy()
      return
    }

    // Asked for a login while it wants none: it takes any (and records it).
    if (wanted || methods.includes(2)) {
      if (!methods.includes(2)) {
        client.end(Buffer.from([5, 0xff]))
        return
      }

      client.write(Buffer.from([5, 2]))
      const [, userLength] = await take(client, buffered, 2)
      const user = (await take(client, buffered, userLength!)).toString()
      const [passwordLength] = await take(client, buffered, 1)
      const password = (
        await take(client, buffered, passwordLength!)
      ).toString()
      logins.push(`${user}:${password}`)

      if (
        wanted &&
        (user !== wanted.username || password !== wanted.password)
      ) {
        client.end(Buffer.from([1, 1]))
        return
      }

      client.write(Buffer.from([1, 0]))
    } else {
      client.write(Buffer.from([5, 0]))
    }

    const [, command, , type] = await take(client, buffered, 4)
    let host: string

    if (type === 1) {
      host = [...(await take(client, buffered, 4))].join(".")
    } else if (type === 4) {
      const bytes = await take(client, buffered, 16)
      host = net.SocketAddress.parse(
        `[${(bytes.toString("hex").match(/.{4}/g) ?? []).join(":")}]:1`,
      )!.address
    } else {
      const [length] = await take(client, buffered, 1)
      host = (await take(client, buffered, length!)).toString()
    }

    const port = (await take(client, buffered, 2)).readUInt16BE(0)
    asked.push(`${host}:${port}`)
    const reply = (code: number) =>
      Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])

    if (command !== 1) {
      client.end(reply(7))
      return
    }

    const to = options.connectTo(host, port)

    if (to === null) {
      client.end(reply(5))
      return
    }

    if (to === "accept") {
      client.end(reply(0))
      return
    }

    pipeTo(
      client,
      to,
      buffered.data,
      () => client.write(reply(0)),
      () => client.end(reply(5)),
    )
  }

  const server = net.createServer((client) => {
    sockets.add(client)
    client.once("close", () => sockets.delete(client))
    client.on("error", () => {})
    void (options.protocol === "http" ? http(client) : socks5(client)).catch(
      () => client.destroy(),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  return {
    port: (server.address() as net.AddressInfo).port,
    asked,
    logins,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
