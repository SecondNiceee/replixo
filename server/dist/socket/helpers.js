"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ack = ack;
exports.err = err;
exports.createRateLimiter = createRateLimiter;
// NOTE: `cb` is typed as required, but at runtime a Socket.io client can emit an
// event WITHOUT providing an acknowledgement callback. In that case `cb` is
// `undefined`, and calling it would throw `TypeError: cb is not a function`.
// Because ack()/err() are often called OUTSIDE the handler's try/catch (e.g. the
// early `return err(...)` guards), that throw is uncaught and crashes the whole
// Node process — taking down every room. Guarding with a typeof check makes a
// missing ack a harmless no-op instead of a fatal error.
function ack(cb, data) {
    if (typeof cb === 'function')
        cb(null, data);
}
function err(cb, message) {
    console.error(`[socket] Error: ${message}`);
    if (typeof cb === 'function')
        cb(message);
}
/**
 * Sliding-window rate limiter. Returns a function that yields `true` while the
 * caller stays under `limit` events per `windowMs`, `false` once exceeded.
 * Create one per socket + event so counters are scoped per connection.
 */
function createRateLimiter(limit, windowMs) {
    let count = 0;
    let windowStart = Date.now();
    return () => {
        const now = Date.now();
        if (now - windowStart > windowMs) {
            count = 0;
            windowStart = now;
        }
        return ++count <= limit;
    };
}
