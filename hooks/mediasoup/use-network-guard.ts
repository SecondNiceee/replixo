"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Socket } from "socket.io-client"
import { NETWORK_GUARD } from "./types"
import type { Consumer, Producer, Transport } from "./types"

// ---------------------------------------------------------------------------
// Weak-network guard: keep the voice alive by sacrificing video.
//
// Why this exists
// ---------------
// Audio and video share ONE WebRTC transport, one ICE/DTLS path, one congestion
// controller. Opus needs ~24-40 kbps and shrugs off packet loss thanks to FEC
// and DTX; 720p camera video needs 1-2.5 Mbps and any loss costs a keyframe.
// So on a congested link video is what destroys the call: it fills the queue,
// and the voice packets that get dropped in that queue are the ones people
// actually care about.
//
// mediasoup already degrades video on its own via simulcast — but only down to
// the lowest layer, which still asks for 100 kbps and will not go lower. On a
// link that has ~60 kbps left, that floor is exactly what starves the mic.
// Explicitly stopping video is the only way to actually free the bandwidth.
//
// Degradation is a ladder, not a switch
// -------------------------------------
// Cutting straight from 720p to "no video" is jarring and usually unnecessary,
// so each direction walks through four stages and only ever moves one step per
// decision:
//
//   0  full quality
//   1  shrunk   — video pinned to the lowest simulcast layer, bitrate and frame
//                 rate capped. Frees ~800 kbps while keeping a picture.
//   2  no camera — camera video stopped; screen share (if any) survives.
//   3  no video  — screen share stopped too. Voice only.
//
// Two independent problems, two different fixes
// ---------------------------------------------
//   * Bad UPLINK  → our own camera producer is shrunk, then paused, so nobody
//     sees us but everybody still hears us.
//   * Bad DOWNLINK → incoming video is pinned to its lowest layer, then paused
//     *server-side*, so we stop receiving pictures but keep hearing everyone.
// They need separate metrics and separate remedies; a single "bad network" flag
// would pause the wrong direction half of the time.
//
// The health signal is AUDIO, not video
// -------------------------------------
// We judge the link by what is happening to the *voice* stream, because that is
// precisely the thing we are protecting. Video loss is a bad signal: video is
// lossy by nature and its own bitrate adaptation masks the problem until the
// link is already unusable.
// ---------------------------------------------------------------------------

export type NetworkQuality = "good" | "weak" | "bad"

/** 0 = full video, 1 = shrunk, 2 = camera off, 3 = all video off. */
export type DegradeStage = 0 | 1 | 2 | 3

/**
 * How video is currently governed.
 *  - `auto`        — the guard decides (default).
 *  - `audio-only`  — user forced video off in both directions (low-data mode).
 *  - `force-video` — user insists on video; the guard stands down temporarily.
 */
export type VideoMode = "auto" | "audio-only" | "force-video"

interface Sample {
  /** Fraction of voice packets lost on this leg, 0..1. */
  loss: number
  /**
   * Fraction of voice playout that had to be concealed (invented) because
   * packets were missing or arrived too late, 0..1. Downlink only.
   */
  concealment: number
  /** Round-trip time in seconds, or 0 when unknown. */
  rtt: number
  /** Estimated available bitrate in bps, or 0 when unknown. */
  availableBps: number
  /** False when no stats could be read at all (nothing published/consumed). */
  measured: boolean
  /** The ICE transport itself is disconnected/failed — the path is gone. */
  stalled: boolean
}

const EMPTY_SAMPLE: Sample = {
  loss: 0,
  concealment: 0,
  rtt: 0,
  availableBps: 0,
  measured: false,
  stalled: false,
}

interface Counter {
  packetsLost: number
  packetsTotal: number
  concealedSamples: number
  totalSamples: number
}

/** True when the ICE path is known to be down rather than merely congested. */
function transportStalled(transport: Transport | null): boolean {
  if (!transport || transport.closed) return false
  const state = transport.connectionState
  return state === "disconnected" || state === "failed"
}

function classify(sample: Sample, badBps: number, weakBps: number): NetworkQuality {
  // A dead ICE path used to be reported as "good" simply because no stats could
  // be read. It is the worst possible state, so say so.
  if (sample.stalled) return "bad"
  if (!sample.measured) return "good"

  const starved = badBps > 0 && sample.availableBps > 0 && sample.availableBps < badBps
  if (
    sample.loss >= NETWORK_GUARD.BAD_LOSS ||
    sample.concealment >= NETWORK_GUARD.BAD_CONCEALMENT ||
    starved ||
    sample.rtt >= NETWORK_GUARD.BAD_RTT_S
  ) {
    return "bad"
  }

  const tight = weakBps > 0 && sample.availableBps > 0 && sample.availableBps < weakBps
  if (
    sample.loss >= NETWORK_GUARD.WEAK_LOSS ||
    sample.concealment >= NETWORK_GUARD.WEAK_CONCEALMENT ||
    tight
  ) {
    return "weak"
  }
  return "good"
}

/**
 * Turns cumulative packet counters into a per-interval loss ratio.
 *
 * Using the raw cumulative `packetsLost` would be useless: a burst of loss ten
 * minutes ago would keep the ratio high forever and video would never come back.
 *
 * `carry` accumulates windows that were too small to judge on their own instead
 * of throwing them away. With DTX and 40 ms packets a silent speaker sends only
 * a handful of packets per tick, and discarding those ticks is how the guard
 * ended up blind on exactly the quiet, congested calls it exists for.
 */
function lossFromDelta(prev: Counter | undefined, next: Counter, carry: Counter): number {
  if (!prev) return 0
  carry.packetsLost += Math.max(0, next.packetsLost - prev.packetsLost)
  carry.packetsTotal += Math.max(0, next.packetsTotal - prev.packetsTotal)
  const window = carry.packetsLost + carry.packetsTotal
  if (window < NETWORK_GUARD.MIN_LOSS_WINDOW_PACKETS) return 0
  const ratio = carry.packetsLost / window
  carry.packetsLost = 0
  carry.packetsTotal = 0
  return ratio
}

/** Same idea for concealed audio samples, which keep counting during silence. */
function concealmentFromDelta(prev: Counter | undefined, next: Counter): number {
  if (!prev) return 0
  const concealed = Math.max(0, next.concealedSamples - prev.concealedSamples)
  const total = Math.max(0, next.totalSamples - prev.totalSamples)
  if (total < 1_000) return 0 // < ~20 ms of audio: meaningless
  return Math.min(1, concealed / total)
}

function emptyCarry(): Counter {
  return { packetsLost: 0, packetsTotal: 0, concealedSamples: 0, totalSamples: 0 }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

interface UseNetworkGuardParams {
  roomId: string
  peerIdRef: React.MutableRefObject<string>
  socketRef: React.MutableRefObject<Socket | null>
  sendTransportRef: React.MutableRefObject<Transport | null>
  recvTransportRef: React.MutableRefObject<Transport | null>
  audioProducerRef: React.MutableRefObject<Producer | null>
  videoProducerRef: React.MutableRefObject<Producer | null>
  screenVideoProducerRef: React.MutableRefObject<Producer | null>
  localStreamRef: React.MutableRefObject<MediaStream | null>
  consumersRef: React.MutableRefObject<Map<string, Consumer>>
  /**
   * Mirrors the downlink decision for `useTransports`, which must not resume a
   * freshly created video consumer while video is suppressed.
   */
  videoConsumersSuppressedRef: React.MutableRefObject<boolean>
  /** The user's camera intent — we never resume video they turned off. */
  isCamOffRef: React.MutableRefObject<boolean>
  /** True once the room has actually been joined; no point sampling before. */
  hasJoinedRef: React.MutableRefObject<boolean>
}

export function useNetworkGuard({
  roomId,
  peerIdRef,
  socketRef,
  sendTransportRef,
  recvTransportRef,
  audioProducerRef,
  videoProducerRef,
  screenVideoProducerRef,
  localStreamRef,
  consumersRef,
  videoConsumersSuppressedRef,
  isCamOffRef,
  hasJoinedRef,
}: UseNetworkGuardParams) {
  const [uplinkQuality, setUplinkQuality] = useState<NetworkQuality>("good")
  const [downlinkQuality, setDownlinkQuality] = useState<NetworkQuality>("good")
  const [videoMode, setVideoModeState] = useState<VideoMode>("auto")
  // How far each direction has been degraded, exposed so the UI can explain
  // itself ("video paused to keep audio stable") instead of looking broken.
  const [uplinkStage, setUplinkStage] = useState<DegradeStage>(0)
  const [downlinkStage, setDownlinkStage] = useState<DegradeStage>(0)

  const videoModeRef = useRef<VideoMode>("auto")
  videoModeRef.current = videoMode
  const forceVideoUntilRef = useRef(0)

  // Cumulative counters from the previous sample, keyed by stats source.
  const prevUplinkRef = useRef<Counter | undefined>(undefined)
  const uplinkCarryRef = useRef<Counter>(emptyCarry())
  const prevDownlinkRef = useRef<Map<string, Counter>>(new Map())
  const downlinkCarryRef = useRef<Map<string, Counter>>(new Map())

  // Hysteresis state. Escalating needs a sustained bad streak; recovering needs
  // an even longer good streak, so the picture never flaps on and off.
  const uplinkBadStreakRef = useRef(0)
  const uplinkGoodStreakRef = useRef(0)
  const downlinkBadStreakRef = useRef(0)
  const downlinkGoodStreakRef = useRef(0)

  const uplinkStageRef = useRef<DegradeStage>(0)
  const uplinkChangedAtRef = useRef(0)
  const uplinkRestoredAtRef = useRef(0)
  const uplinkHoldMsRef = useRef(NETWORK_GUARD.MIN_SUPPRESSION_MS)

  const downlinkStageRef = useRef<DegradeStage>(0)
  const downlinkChangedAtRef = useRef(0)
  const downlinkRestoredAtRef = useRef(0)
  const downlinkHoldMsRef = useRef(NETWORK_GUARD.MIN_SUPPRESSION_MS)

  const appliedVoiceBitrateRef = useRef(0)
  // Which producer that bitrate was applied to. A mic switch or a session
  // rebuild creates a brand new producer at the default 64 kbps, and without
  // this the guard would believe 24 kbps was still in force and never re-apply.
  const appliedVoiceProducerRef = useRef<string | null>(null)

  // Original encodings per producer id, so caps can be lifted exactly.
  const originalEncodingsRef = useRef<Map<string, Array<{ maxBitrate?: number; maxFramerate?: number }>>>(
    new Map(),
  )
  const appliedCapRef = useRef<Map<string, string>>(new Map())
  const appliedLayersRef = useRef<Map<string, number | null>>(new Map())

  // -------------------------------------------------------------------------
  // Uplink sampling: how much of OUR voice is the server actually receiving?
  // -------------------------------------------------------------------------
  const sampleUplink = useCallback(async (): Promise<Sample> => {
    const producer = audioProducerRef.current
    const transport = sendTransportRef.current
    const stalled = transportStalled(transport)
    let loss = 0
    let rtt = 0
    let availableBps = 0
    let measured = false

    // `remote-inbound-rtp` is the receiver report coming back from the SFU — it
    // is the only place that tells us what actually arrived, as opposed to what
    // we tried to send.
    if (producer && !producer.closed && !producer.paused) {
      try {
        const stats: RTCStatsReport = await producer.getStats()
        stats.forEach((report: Record<string, unknown>) => {
          if (report.type !== "remote-inbound-rtp") return
          measured = true
          rtt = Math.max(rtt, num(report.roundTripTime))
          const counter: Counter = {
            packetsLost: num(report.packetsLost),
            packetsTotal: num(report.packetsReceived),
            concealedSamples: 0,
            totalSamples: 0,
          }
          // Prefer the delta-based ratio; fall back to the browser-reported
          // `fractionLost` when packet counters aren't exposed.
          const delta = lossFromDelta(prevUplinkRef.current, counter, uplinkCarryRef.current)
          loss = Math.max(loss, delta, num(report.fractionLost))
          prevUplinkRef.current = counter
        })
      } catch {
        // Stats are unavailable while ICE is restarting — treat as unmeasured.
      }
    }

    if (transport && !transport.closed) {
      try {
        const stats: RTCStatsReport = await transport.getStats()
        stats.forEach((report: Record<string, unknown>) => {
          if (report.type !== "candidate-pair") return
          if (report.state !== "succeeded" && report.nominated !== true) return
          const outgoing = num(report.availableOutgoingBitrate)
          if (outgoing > 0) {
            availableBps = Math.max(availableBps, outgoing)
            measured = true
          }
          rtt = Math.max(rtt, num(report.currentRoundTripTime))
        })
      } catch {
        // Ignore.
      }
    }

    if (!measured && !stalled) return EMPTY_SAMPLE
    return { loss, concealment: 0, rtt, availableBps, measured, stalled }
  }, [audioProducerRef, sendTransportRef])

  // -------------------------------------------------------------------------
  // Downlink sampling: how much of THEIR voice are we losing on the way in?
  // -------------------------------------------------------------------------
  const sampleDownlink = useCallback(async (): Promise<Sample> => {
    const transport = recvTransportRef.current
    const stalled = transportStalled(transport)

    const consumers = Array.from(consumersRef.current.values()).filter(
      (consumer) =>
        !consumer.closed &&
        !consumer.paused &&
        consumer.kind === "audio" &&
        (consumer.appData as Record<string, unknown>)?.source !== "screen",
    )

    let loss = 0
    let concealment = 0
    let rtt = 0
    let availableBps = 0
    let measured = false
    const seen = new Set<string>()

    await Promise.all(
      consumers.map(async (consumer) => {
        try {
          const stats: RTCStatsReport = await consumer.getStats()
          stats.forEach((report: Record<string, unknown>) => {
            if (report.type !== "inbound-rtp") return
            measured = true
            const counter: Counter = {
              packetsLost: num(report.packetsLost),
              packetsTotal: num(report.packetsReceived),
              concealedSamples: num(report.concealedSamples),
              totalSamples: num(report.totalSamplesReceived),
            }
            seen.add(consumer.id)
            let carry = downlinkCarryRef.current.get(consumer.id)
            if (!carry) {
              carry = emptyCarry()
              downlinkCarryRef.current.set(consumer.id, carry)
            }
            const prev = prevDownlinkRef.current.get(consumer.id)
            // Worst peer wins: if any single voice stream is falling apart, the
            // call is already unpleasant and video has to give way.
            loss = Math.max(loss, lossFromDelta(prev, counter, carry))
            concealment = Math.max(concealment, concealmentFromDelta(prev, counter))
            prevDownlinkRef.current.set(consumer.id, counter)
          })
        } catch {
          // Ignore this consumer for the current sample.
        }
      }),
    )

    // Drop counters of consumers that went away, so their stale cumulative
    // values can't produce a bogus negative/huge delta if the id is reused.
    for (const id of prevDownlinkRef.current.keys()) {
      if (!seen.has(id)) {
        prevDownlinkRef.current.delete(id)
        downlinkCarryRef.current.delete(id)
      }
    }

    // The receive-side congestion estimate. Previously the downlink was judged
    // on audio loss alone, so a link whose incoming capacity had collapsed was
    // still called "good" as long as the few Opus packets that fit through
    // arrived intact.
    if (transport && !transport.closed) {
      try {
        const stats: RTCStatsReport = await transport.getStats()
        stats.forEach((report: Record<string, unknown>) => {
          if (report.type !== "candidate-pair") return
          if (report.state !== "succeeded" && report.nominated !== true) return
          const incoming = num(report.availableIncomingBitrate)
          if (incoming > 0) {
            availableBps = Math.max(availableBps, incoming)
            measured = true
          }
          rtt = Math.max(rtt, num(report.currentRoundTripTime))
        })
      } catch {
        // Ignore.
      }
    }

    if (!measured && !stalled) return EMPTY_SAMPLE
    return { loss, concealment, rtt, availableBps, measured, stalled }
  }, [consumersRef, recvTransportRef])

  // -------------------------------------------------------------------------
  // Encoder caps (the "shrink" step of the uplink ladder).
  //
  // `setMaxSpatialLayer` alone is not enough: it picks a simulcast layer but
  // leaves that layer's own bitrate/frame-rate budget untouched. Capping the
  // sender parameters is what actually bounds what leaves the machine.
  // -------------------------------------------------------------------------
  const capProducer = useCallback(
    async (producer: Producer | null, caps: { maxBitrate: number; maxFramerate: number } | null) => {
      if (!producer || producer.closed) return
      const signature = caps ? `${caps.maxBitrate}/${caps.maxFramerate}` : "none"
      if (appliedCapRef.current.get(producer.id) === signature) return

      const sender = producer.rtpSender
      if (!sender) return
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) return

        if (!originalEncodingsRef.current.has(producer.id)) {
          originalEncodingsRef.current.set(
            producer.id,
            params.encodings.map((encoding: RTCRtpEncodingParameters) => ({
              maxBitrate: encoding.maxBitrate,
              maxFramerate: encoding.maxFramerate,
            })),
          )
        }
        const original = originalEncodingsRef.current.get(producer.id) ?? []

        params.encodings.forEach((encoding: RTCRtpEncodingParameters, index: number) => {
          if (caps) {
            const ceiling = original[index]?.maxBitrate
            encoding.maxBitrate = ceiling ? Math.min(caps.maxBitrate, ceiling) : caps.maxBitrate
            encoding.maxFramerate = caps.maxFramerate
          } else {
            encoding.maxBitrate = original[index]?.maxBitrate
            encoding.maxFramerate = original[index]?.maxFramerate
          }
        })
        await sender.setParameters(params)
        appliedCapRef.current.set(producer.id, signature)
      } catch {
        // Some browsers refuse mid-call encoding changes — the layer pin below
        // still applies, so this is a soft failure.
      }
    },
    [],
  )

  // -------------------------------------------------------------------------
  // Applying the uplink decision.
  //
  // Deliberately pause + disable the track rather than closing the producer:
  // closing would require a fresh getUserMedia (slow, may re-prompt, may fail)
  // to come back, whereas a paused producer resumes instantly. `track.enabled`
  // is cleared too so the encoder actually stops doing work.
  // -------------------------------------------------------------------------
  const applyUplink = useCallback(
    (stage: DegradeStage) => {
      const producer = videoProducerRef.current
      const screen = screenVideoProducerRef.current
      const track = localStreamRef.current?.getVideoTracks()[0]
      const socket = socketRef.current
      const cameraPaused = stage >= 2
      // Never resume video the user themselves switched off.
      const wantsCamera = !cameraPaused && !isCamOffRef.current

      if (!producer || producer.closed) {
        if (track) track.enabled = !isCamOffRef.current
      } else if (!wantsCamera) {
        if (track) track.enabled = false
        if (!producer.paused) {
          producer.pause()
          socket?.emit("pauseProducer", {
            roomId,
            peerId: peerIdRef.current,
            producerId: producer.id,
            paused: true,
          })
        }
      } else {
        if (track) track.enabled = true
        if (producer.paused) {
          producer.resume()
          socket?.emit("pauseProducer", {
            roomId,
            peerId: peerIdRef.current,
            producerId: producer.id,
            paused: false,
          })
        }
        // Stage 1: keep sending, but only the smallest layer, slowly.
        void producer
          .setMaxSpatialLayer(stage >= 1 ? NETWORK_GUARD.LOW_SPATIAL_LAYER : 2)
          .catch(() => {})
        void capProducer(
          producer,
          stage >= 1
            ? { maxBitrate: NETWORK_GUARD.LOW_CAMERA_BPS, maxFramerate: NETWORK_GUARD.LOW_CAMERA_FPS }
            : null,
        )
      }

      // A 2.5 Mbps screen share drowns the microphone long before the camera
      // does, so it has to be part of the ladder — it just goes last, because
      // it is usually the reason the meeting exists.
      if (screen && !screen.closed) {
        if (stage >= 3) {
          if (!screen.paused) {
            screen.pause()
            socket?.emit("pauseProducer", {
              roomId,
              peerId: peerIdRef.current,
              producerId: screen.id,
              paused: true,
            })
          }
        } else {
          if (screen.paused) {
            screen.resume()
            socket?.emit("pauseProducer", {
              roomId,
              peerId: peerIdRef.current,
              producerId: screen.id,
              paused: false,
            })
          }
          void capProducer(
            screen,
            stage >= 1
              ? { maxBitrate: NETWORK_GUARD.LOW_SCREEN_BPS, maxFramerate: NETWORK_GUARD.LOW_SCREEN_FPS }
              : null,
          )
        }
      }
    },
    [
      roomId,
      peerIdRef,
      socketRef,
      videoProducerRef,
      screenVideoProducerRef,
      localStreamRef,
      isCamOffRef,
      capProducer,
    ],
  )

  // -------------------------------------------------------------------------
  // Applying the downlink decision.
  //
  // The server-side pause / layer pin is what frees bandwidth; the client-side
  // pause just stops the decoder. We do both. Re-running this every tick also
  // catches consumers that appeared after the decision was made.
  // -------------------------------------------------------------------------
  const applyDownlink = useCallback(
    (stage: DegradeStage) => {
      const socket = socketRef.current
      const alive = new Set<string>()

      for (const consumer of consumersRef.current.values()) {
        if (consumer.closed || consumer.kind !== "video") continue
        alive.add(consumer.id)
        const isScreen = (consumer.appData as Record<string, unknown>)?.source === "screen"
        const shouldPause = isScreen ? stage >= 3 : stage >= 2

        if (shouldPause !== !!consumer.paused) {
          if (shouldPause) consumer.pause()
          else consumer.resume()
          socket?.emit("pauseConsumer", {
            roomId,
            peerId: peerIdRef.current,
            consumerId: consumer.id,
            paused: shouldPause,
          })
        }
        if (shouldPause) continue

        // Not paused → decide how much of it we want. Pinning to layer 0 cuts
        // the incoming bitrate ~9× while keeping a visible picture.
        const wanted = stage >= 1 ? NETWORK_GUARD.LOW_SPATIAL_LAYER : null
        if (appliedLayersRef.current.get(consumer.id) === wanted) continue
        appliedLayersRef.current.set(consumer.id, wanted)
        socket?.emit("setConsumerLayers", {
          roomId,
          peerId: peerIdRef.current,
          consumerId: consumer.id,
          spatialLayer: wanted,
          temporalLayer: wanted === null ? null : NETWORK_GUARD.LOW_TEMPORAL_LAYER,
        })
      }

      for (const id of appliedLayersRef.current.keys()) {
        if (!alive.has(id)) appliedLayersRef.current.delete(id)
      }
    },
    [roomId, peerIdRef, socketRef, consumersRef],
  )

  // -------------------------------------------------------------------------
  // Voice bitrate follows the link quality. Opus at 24 kbps is still perfectly
  // intelligible, and the ~40 kbps we give back is often exactly what the
  // congested uplink needed.
  // -------------------------------------------------------------------------
  const applyVoiceBitrate = useCallback(
    async (quality: NetworkQuality) => {
      const producer = audioProducerRef.current
      if (!producer || producer.closed) return
      // A new producer starts from the codec defaults, so forget what we think
      // we applied to the old one.
      if (appliedVoiceProducerRef.current !== producer.id) {
        appliedVoiceProducerRef.current = producer.id
        appliedVoiceBitrateRef.current = 0
      }
      const target = NETWORK_GUARD.VOICE_BITRATE[quality]
      if (appliedVoiceBitrateRef.current === target) return
      try {
        const sender = producer.rtpSender
        if (!sender) return
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) return
        params.encodings[0].maxBitrate = target
        await sender.setParameters(params)
        appliedVoiceBitrateRef.current = target
      } catch {
        // Not every browser lets us renegotiate the audio encoding — harmless.
      }
    },
    [audioProducerRef],
  )

  // -------------------------------------------------------------------------
  // Stage transitions
  //
  // One step at a time in both directions. Escalation is capped at "camera off"
  // unless a screen share is actually running, so we never advertise stage 3
  // (and never wait out its hold timer) for nothing.
  // -------------------------------------------------------------------------
  const maxUplinkStage = useCallback((): DegradeStage => {
    const screen = screenVideoProducerRef.current
    return screen && !screen.closed ? 3 : 2
  }, [screenVideoProducerRef])

  const maxDownlinkStage = useCallback((): DegradeStage => {
    for (const consumer of consumersRef.current.values()) {
      if (consumer.closed || consumer.kind !== "video") continue
      if ((consumer.appData as Record<string, unknown>)?.source === "screen") return 3
    }
    return 2
  }, [consumersRef])

  // -------------------------------------------------------------------------
  // The monitoring loop
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (cancelled) return
      const now = Date.now()

      // Manual low-data mode: nothing to measure, just hold video off.
      if (videoModeRef.current === "audio-only") {
        uplinkStageRef.current = 3
        downlinkStageRef.current = 3
        videoConsumersSuppressedRef.current = true
        applyUplink(3)
        applyDownlink(3)
        setUplinkStage(3)
        setDownlinkStage(3)
        schedule()
        return
      }

      // A manual "keep my video" override is temporary. Left permanent (as it
      // was), a single camera-button press disabled the protection for the whole
      // call and the person ended up unintelligible instead of just invisible.
      if (videoModeRef.current === "force-video" && now >= forceVideoUntilRef.current) {
        setVideoModeState("auto")
        videoModeRef.current = "auto"
        uplinkBadStreakRef.current = 0
        uplinkGoodStreakRef.current = 0
        downlinkBadStreakRef.current = 0
        downlinkGoodStreakRef.current = 0
      }
      const mode = videoModeRef.current

      if (!hasJoinedRef.current) {
        schedule()
        return
      }

      const [uplink, downlink] = await Promise.all([sampleUplink(), sampleDownlink()])
      if (cancelled) return

      const uplinkClass = classify(uplink, NETWORK_GUARD.BAD_UPLINK_BPS, NETWORK_GUARD.WEAK_UPLINK_BPS)
      const downlinkClass = classify(
        downlink,
        NETWORK_GUARD.BAD_DOWNLINK_BPS,
        NETWORK_GUARD.WEAK_DOWNLINK_BPS,
      )
      setUplinkQuality(uplinkClass)
      setDownlinkQuality(downlinkClass)

      const worst: NetworkQuality =
        uplinkClass === "bad" || downlinkClass === "bad"
          ? "bad"
          : uplinkClass === "weak" || downlinkClass === "weak"
            ? "weak"
            : "good"
      void applyVoiceBitrate(worst)

      // ---- uplink decision -------------------------------------------------
      if (mode === "force-video") {
        if (uplinkStageRef.current !== 0) {
          uplinkStageRef.current = 0
          uplinkRestoredAtRef.current = now
          setUplinkStage(0)
        }
        uplinkBadStreakRef.current = 0
        uplinkGoodStreakRef.current = 0
      } else if (uplinkClass === "good") {
        uplinkBadStreakRef.current = 0
        uplinkGoodStreakRef.current += 1
        if (
          uplinkStageRef.current > 0 &&
          uplinkGoodStreakRef.current >= NETWORK_GUARD.GOOD_SAMPLES_TO_RESTORE &&
          now - uplinkChangedAtRef.current >= uplinkHoldMsRef.current
        ) {
          uplinkStageRef.current = (uplinkStageRef.current - 1) as DegradeStage
          uplinkChangedAtRef.current = now
          uplinkGoodStreakRef.current = 0
          if (uplinkStageRef.current === 0) uplinkRestoredAtRef.current = now
          setUplinkStage(uplinkStageRef.current)
          console.info(
            `[media] Uplink video restored room=${roomId} peer=${peerIdRef.current} stage=${uplinkStageRef.current}`,
          )
        }
      } else {
        // "weak" now escalates too — it is the whole point of the shrink stage.
        // It just cannot go past stage 1: a merely tight link keeps its picture.
        const ceiling = uplinkClass === "bad" ? maxUplinkStage() : 1
        uplinkGoodStreakRef.current = 0
        uplinkBadStreakRef.current += 1
        if (
          uplinkBadStreakRef.current >= NETWORK_GUARD.BAD_SAMPLES_TO_SUPPRESS &&
          uplinkStageRef.current < ceiling &&
          !(uplinkStageRef.current === 0 && isCamOffRef.current && !screenVideoProducerRef.current)
        ) {
          // Re-degrading soon after a full restore means the link genuinely
          // cannot carry video: hold it back twice as long this time.
          if (
            uplinkStageRef.current === 0 &&
            now - uplinkRestoredAtRef.current < NETWORK_GUARD.FLAP_WINDOW_MS
          ) {
            uplinkHoldMsRef.current = Math.min(
              uplinkHoldMsRef.current * 2,
              NETWORK_GUARD.MAX_SUPPRESSION_MS,
            )
          }
          uplinkStageRef.current = (uplinkStageRef.current + 1) as DegradeStage
          uplinkChangedAtRef.current = now
          uplinkBadStreakRef.current = 0
          setUplinkStage(uplinkStageRef.current)
          console.warn(
            `[media] Uplink video degraded room=${roomId} peer=${peerIdRef.current} stage=${uplinkStageRef.current} class=${uplinkClass} loss=${uplink.loss.toFixed(3)} avail=${uplink.availableBps} holdMs=${uplinkHoldMsRef.current}`,
          )
        }
      }

      // ---- downlink decision ----------------------------------------------
      if (mode === "force-video") {
        if (downlinkStageRef.current !== 0) {
          downlinkStageRef.current = 0
          downlinkRestoredAtRef.current = now
          setDownlinkStage(0)
        }
        downlinkBadStreakRef.current = 0
        downlinkGoodStreakRef.current = 0
      } else if (downlinkClass === "good") {
        downlinkBadStreakRef.current = 0
        downlinkGoodStreakRef.current += 1
        if (
          downlinkStageRef.current > 0 &&
          downlinkGoodStreakRef.current >= NETWORK_GUARD.GOOD_SAMPLES_TO_RESTORE &&
          now - downlinkChangedAtRef.current >= downlinkHoldMsRef.current
        ) {
          downlinkStageRef.current = (downlinkStageRef.current - 1) as DegradeStage
          downlinkChangedAtRef.current = now
          downlinkGoodStreakRef.current = 0
          if (downlinkStageRef.current === 0) downlinkRestoredAtRef.current = now
          setDownlinkStage(downlinkStageRef.current)
          console.info(
            `[media] Downlink video restored room=${roomId} peer=${peerIdRef.current} stage=${downlinkStageRef.current}`,
          )
        }
      } else {
        const ceiling = downlinkClass === "bad" ? maxDownlinkStage() : 1
        downlinkGoodStreakRef.current = 0
        downlinkBadStreakRef.current += 1
        if (
          downlinkBadStreakRef.current >= NETWORK_GUARD.BAD_SAMPLES_TO_SUPPRESS &&
          downlinkStageRef.current < ceiling
        ) {
          if (
            downlinkStageRef.current === 0 &&
            now - downlinkRestoredAtRef.current < NETWORK_GUARD.FLAP_WINDOW_MS
          ) {
            downlinkHoldMsRef.current = Math.min(
              downlinkHoldMsRef.current * 2,
              NETWORK_GUARD.MAX_SUPPRESSION_MS,
            )
          }
          // Step down one level at a time: shrink, then cameras, then screen.
          downlinkStageRef.current = (downlinkStageRef.current + 1) as DegradeStage
          downlinkChangedAtRef.current = now
          downlinkBadStreakRef.current = 0
          setDownlinkStage(downlinkStageRef.current)
          console.warn(
            `[media] Downlink video degraded room=${roomId} peer=${peerIdRef.current} stage=${downlinkStageRef.current} class=${downlinkClass} loss=${downlink.loss.toFixed(3)} conceal=${downlink.concealment.toFixed(3)} avail=${downlink.availableBps}`,
          )
        }
      }

      // Apply unconditionally: it's idempotent, and re-running it is how newly
      // created producers/consumers inherit the current decision.
      videoConsumersSuppressedRef.current = downlinkStageRef.current >= 2
      applyUplink(uplinkStageRef.current)
      applyDownlink(downlinkStageRef.current)

      schedule()
    }

    function schedule() {
      if (cancelled) return
      timer = setTimeout(() => void tick(), NETWORK_GUARD.SAMPLE_INTERVAL_MS)
    }

    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [
    roomId,
    peerIdRef,
    hasJoinedRef,
    isCamOffRef,
    screenVideoProducerRef,
    videoConsumersSuppressedRef,
    sampleUplink,
    sampleDownlink,
    applyUplink,
    applyDownlink,
    applyVoiceBitrate,
    maxUplinkStage,
    maxDownlinkStage,
  ])

  // -------------------------------------------------------------------------
  // Manual control
  // -------------------------------------------------------------------------
  const setVideoMode = useCallback(
    (mode: VideoMode) => {
      setVideoModeState(mode)
      videoModeRef.current = mode
      // Act immediately instead of waiting for the next sample — a button that
      // takes two seconds to do anything feels broken.
      if (mode === "audio-only") {
        uplinkStageRef.current = 3
        downlinkStageRef.current = 3
        videoConsumersSuppressedRef.current = true
        setUplinkStage(3)
        setDownlinkStage(3)
        applyUplink(3)
        applyDownlink(3)
        return
      }
      if (mode === "force-video") {
        forceVideoUntilRef.current = Date.now() + NETWORK_GUARD.FORCE_VIDEO_TTL_MS
        uplinkStageRef.current = 0
        downlinkStageRef.current = 0
        videoConsumersSuppressedRef.current = false
        uplinkRestoredAtRef.current = Date.now()
        downlinkRestoredAtRef.current = Date.now()
        setUplinkStage(0)
        setDownlinkStage(0)
        applyUplink(0)
        applyDownlink(0)
        return
      }
      // Back to auto: clear the streaks so the next decision is made from fresh
      // measurements rather than whatever was accumulated before the override.
      forceVideoUntilRef.current = 0
      uplinkBadStreakRef.current = 0
      uplinkGoodStreakRef.current = 0
      downlinkBadStreakRef.current = 0
      downlinkGoodStreakRef.current = 0
    },
    [applyUplink, applyDownlink, videoConsumersSuppressedRef],
  )

  /**
   * Called when the user presses the camera button while the guard has video
   * degraded. Two boolean flags ("user wants video" and "network took video
   * away") must stay independent, otherwise the camera button would appear
   * dead: the user turns the camera on, the guard immediately pauses it again,
   * and nothing visible happens. Treating the press as an explicit — but
   * time-limited — override makes their intent win.
   */
  const noteUserWantsVideo = useCallback(() => {
    if (uplinkStageRef.current === 0 && downlinkStageRef.current === 0) return
    setVideoMode("force-video")
  }, [setVideoMode])

  return {
    uplinkQuality,
    downlinkQuality,
    /** Worst of the two directions — what the UI indicator should show. */
    networkQuality: (uplinkQuality === "bad" || downlinkQuality === "bad"
      ? "bad"
      : uplinkQuality === "weak" || downlinkQuality === "weak"
        ? "weak"
        : "good") as NetworkQuality,
    videoMode,
    setVideoMode,
    noteUserWantsVideo,
    uplinkStage,
    downlinkStage,
    /** Our camera is off because of the network, not because the user asked. */
    uplinkVideoSuppressed: uplinkStage >= 2,
    /** Incoming camera video is off because of our downlink. */
    downlinkVideoSuppressed: downlinkStage >= 2,
    /** Video is still flowing, just deliberately small and choppy. */
    videoDegraded: uplinkStage === 1 || downlinkStage === 1,
  }
}
