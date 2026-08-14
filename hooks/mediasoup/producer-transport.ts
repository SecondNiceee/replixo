"use client"

// ---------------------------------------------------------------------------
// Which send transport a producer was published on.
//
// The health checks all over the media layer ask "does this producer still
// belong to the CURRENT send transport?", because a transport rebuild leaves
// orphaned producers behind that can never resume. They used to ask it as
// `producer.transport !== sendTransportRef.current`.
//
// mediasoup-client's Producer has NO `transport` property (see
// node_modules/mediasoup-client/lib/Producer.d.ts — only id/localId/kind/track/
// rtpSender/paused/closed/appData). Our local `Producer` type is `any`, so that
// comparison compiled happily and evaluated to `undefined !== transport`, i.e.
// ALWAYS TRUE. Every perfectly healthy producer was therefore diagnosed as
// "producer-dead" on every watchdog tick, which is what turned mic recovery into
// an endless republish loop that killed the microphone every few seconds.
//
// So we remember the transport ourselves, at the only place that knows it: the
// call to `transport.produce()`.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProducer = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTransport = any

const producerTransports = new WeakMap<object, object>()

/** Record the transport a freshly created producer was published on. */
export function rememberProducerTransport(producer: AnyProducer, transport: AnyTransport): void {
  if (!producer || !transport) return
  producerTransports.set(producer as object, transport as object)
}

/**
 * True when `producer` is known to have been published on a transport that is no
 * longer the current one — i.e. it is orphaned and must be republished.
 *
 * Deliberately conservative: an unknown producer (never registered) or a missing
 * current transport returns FALSE. Guessing "stale" here is destructive — it
 * tears down a working microphone — while guessing "fine" merely means we rely on
 * the other, direct health signals (closed producer, ended track, RTP probe).
 */
export function isProducerOnStaleTransport(producer: AnyProducer, currentTransport: AnyTransport): boolean {
  if (!producer || !currentTransport) return false
  const known = producerTransports.get(producer as object)
  if (!known) return false
  return known !== currentTransport
}
