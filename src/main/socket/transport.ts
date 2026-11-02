// The byte transport under the CLI socket: Unix domain sockets through `net`. Kept to two calls
// so the server (and the CLI, Task 13) never touch `net` paths directly; Windows named pipes
// (`\\.\pipe\...`) go through the same `net` API and can slot in here later.
//
// No Electron import: unit tests open real sockets in a temp dir with this file.
import { createConnection, createServer, type Server, type Socket } from 'node:net'

/**
 * Bind `path` and start accepting. Rejects on a bind error (EADDRINUSE, EACCES, ENAMETOOLONG...).
 *
 * The socket file is born 0600. connect() checks the file mode at connect time, and a connection
 * the kernel queues while the file is still group/other-writable is accepted and served later, so
 * a chmod after bind leaves a window (umask 0002 with a shared primary group lets group members
 * in). Instead the umask is 0177 for the bind itself: on the main thread `server.listen(path)`
 * binds synchronously (net.js listenInCluster -> _listen2 -> handle.bind; only the 'listening'
 * event is deferred), so no other JS runs under the narrowed umask. A libuv threadpool fs call
 * that lands in those microseconds gets a stricter mode, never a looser one.
 *
 * `allowHalfOpen`: a client may send its request and half-close (`socket.end(line)`, `nc -U`
 * fed from a pipe). With Node's default the server's side would be ended at once and a reply
 * that is not ready yet (an overlay waiting for the user) silently dropped; the server ends the
 * connection itself once every request on it has been answered.
 */
export function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer({ allowHalfOpen: true }, onConnection)
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    const onListening = (): void => {
      server.off('error', onError)
      resolve(server)
    }
    // process.umask(mask) throws in worker threads; main is not one. Windows ignores it.
    const umask = process.umask(0o177)
    try {
      server.listen(path, onListening)
    } finally {
      process.umask(umask)
    }
  })
}

/**
 * Connect to `path`. Rejects with the socket error (ENOENT: no file; ECONNREFUSED: a file nobody
 * listens on) or with an ETIMEDOUT error when nothing answers within `timeoutMs` (a hung owner,
 * or a peer that accepts but never completes).
 */
export function connect(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error(`connect ${path} timed out`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
    const onError = (err: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    socket.once('error', onError)
  })
}
