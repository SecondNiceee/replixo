import type { Server, Socket } from 'socket.io'

// ---------------------------------------------------------------------------
// Shared helpers for all socket handler modules
// ---------------------------------------------------------------------------

export type Callback<T = void> = (err: string | null, data?: T) => void

// NOTE: `cb` is typed as required, but at runtime a Socket.io client can emit an
// event WITHOUT providing an acknowledgement callback. In that case `cb` is
// `undefined`, and calling it would throw `TypeError: cb is not a function`.
// Because ack()/err() are often called OUTSIDE the handler's try/catch (e.g. the
// early `return err(...)` guards), that throw is uncaught and crashes the whole
// Node process — taking down every room. Guarding with a typeof check makes a
// missing ack a harmless no-op instead of a fatal error.
export function ack<T>(cb: Callback<T> | undefined, data: T): void {
  if (typeof cb === 'function') cb(null, data)
}

export function err(cb: Callback<never> | undefined, message: string): void {
  console.error(`[socket] Error: ${message}`)
  if (typeof cb === 'function') cb(message)
}

/**
 * Sliding-window rate limiter. Returns a function that yields `true` while the
 * caller stays under `limit` events per `windowMs`, `false` once exceeded.
 * Create one per socket + event so counters are scoped per connection.
 */
export function createRateLimiter(limit: number, windowMs: number): () => boolean {
  let count = 0
  let windowStart = Date.now()
  return () => {
    const now = Date.now()
    if (now - windowStart > windowMs) {
      count = 0
      windowStart = now
    }
    return ++count <= limit
  }
}

/**
 * Mutable per-connection session. Shared by reference between handler modules
 * so joinRoom / rejoinProbe / leave can all read & update the same state.
 */
export interface SocketSession {
  roomId: string | null
  peerId: string | null
}

/** Everything a handler module needs to register its events. */
export interface HandlerContext {
  io: Server
  socket: Socket
  session: SocketSession
}
