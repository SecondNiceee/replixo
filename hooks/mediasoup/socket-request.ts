import type { Socket } from "socket.io-client"

/** A request belongs to one connection. Never buffer it for a future socket. */
export function requestAck<T = void>(
  socket: Socket,
  event: string,
  payload: object,
  { signal, timeout = 10000 }: { signal?: AbortSignal; timeout?: number } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || !socket.connected) {
      reject(new Error(`${event}: connection interrupted`))
      return
    }
    let settled = false
    const finish = (error?: Error, data?: T) => {
      if (settled) return
      settled = true
      socket.off("disconnect", interrupted)
      signal?.removeEventListener("abort", interrupted)
      if (error) reject(error)
      else resolve(data as T)
    }
    const interrupted = () => finish(new Error(`${event}: connection interrupted`))
    socket.on("disconnect", interrupted)
    signal?.addEventListener("abort", interrupted, { once: true })
    try {
      // Socket.IO also removes its internal callback on timeout, so dropped
      // replies do not accumulate in long-lived rooms.
      socket.timeout(timeout).emit(event, payload, (transportError: Error | null, error: string | null, data?: T) => {
        finish(transportError ? new Error(`${event}: acknowledgement timeout`) : error ? new Error(error) : undefined, data)
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
