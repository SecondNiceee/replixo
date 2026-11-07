import type { IncomingHttpHeaders } from 'http'
import { TRUST_PROXY } from './config'

/** Real client IP: X-Real-IP set by the balancer, or the raw socket address. */
export function clientIp(headers: IncomingHttpHeaders, remoteAddress: string | undefined): string {
  if (TRUST_PROXY) {
    const realIp = headers['x-real-ip']
    const value = Array.isArray(realIp) ? realIp[0] : realIp
    if (value && value.trim()) return value.trim()
  }
  return remoteAddress ?? 'unknown'
}

/**
 * Fixed-window rate limiter keyed by an arbitrary string (usually an IP).
 * Returns `true` while `key` stays under `limit` hits per `windowMs`.
 */
export function createKeyedRateLimiter(limit: number, windowMs: number): (key: string) => boolean {
  const windows = new Map<string, { start: number; count: number }>()
  let lastPrune = Date.now()

  return (key: string) => {
    const now = Date.now()
    if (now - lastPrune > windowMs) {
      for (const [k, w] of windows) {
        if (now - w.start > windowMs) windows.delete(k)
      }
      lastPrune = now
    }
    const current = windows.get(key)
    if (!current || now - current.start > windowMs) {
      windows.set(key, { start: now, count: 1 })
      return true
    }
    current.count++
    return current.count <= limit
  }
}
