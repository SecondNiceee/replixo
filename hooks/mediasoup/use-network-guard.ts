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
// Two independent problems, two different fixes
// ---------------------------------------------
//   * Bad UPLINK  → our own camera producer is paused, so nobody sees us but
//     everybody still hears us.
//   * Bad DOWNLINK → the incoming video consumers are paused *server-side*, so
//     we stop receiving pictures but keep hearing everyone.
// They need separate metrics and separate remedies; a single "bad network" flag
// would pause the wrong direction half of the time.
//
// The health signal is AUDIO loss, not video loss
// -----------------------------------------------
// We judge the link by how much of the *voice* stream is being lost, because
// that is precisely the thing we are protecting. Video loss is a bad signal:
// video is lossy by nature and its own bitrate adaptation masks the problem
// until the link is already unusable.
// ---------------------------------------------------------------------------

export type NetworkQuality = "good" | "weak" | "bad"

/**
 * How video is currently governed.
 *  - `auto`        — the guard decides (default).
 *  - `audio-only`  — user forced video off in both directions (low-data mode).
 *  - `force-video` — user insists on video; the guard never auto-suppresses.
 */
export type VideoMode = "auto" | "audio-only" | "force-video"

interface Sample {
  /** Fraction of voice packets lost on this leg, 0..1. */
  loss: number
  /** Round-trip time in seconds, or 0 when unknown. */
  rtt: number
  /** Estimated available bitrate in bps, or 0 when unknown. */
  availableBps: number
  /** False when no stats could be read at all (nothing published/consumed). */
  measured: boolean
}

const EMPTY_SAMPLE: Sample = { loss: 0, rtt: 0, availableBps: 0, measured: false }

interface Counter {
  packetsLost: number
  packetsTotal: number
}

function classify(sample: Sample, badBps: number, weakBps: number): NetworkQuality {
  if (!sample.measured) return "good"
  const starved = sample.availableBps > 0 && sample.availableBps < badBps
  if (sample.loss >= NETWORK_GUARD.BAD_LOSS || starved || sample.rtt >= NETWORK_GUARD.BAD_RTT_S) {
    return "bad"
  }
  const tight = sample.availableBps > 0 && sample.availableBps < weakBps
  if (sample.loss >= NETWORK_GUARD.WEAK_LOSS || tight) return "weak"
  return "good"
}

/**
 * Turns cumulative packet counters into a per-interval loss ratio.
 *
 * Using the raw cumulative `packetsLost` would be useless: a burst of loss ten
 * minutes ago would keep the ratio high forever and video would never come back.
 */
function lossFromDelta(prev: Counter | undefined, next: Counter): number {
  if (!prev) return 0
  const lost = Math.max(0, next.packetsLost - prev.packetsLost)
  const total = Math.max(0, next.packetsTotal - prev.packetsTotal)
  const window = lost + total
  if (window < 20) return 0 // too few packets to draw any conclusion
  return lost / window
}

interface UseNetworkGuardParams {
  roomId: string
  peerIdRef: React.MutableRefObject<string>
  socketRef: React.MutableRefObject<Socket | null>
  sendTransportRef: React.MutableRefObject<Transport | null>
  audioProducerRef: React.MutableRefObject<Producer | null>
  videoProducerRef: React.MutableRefObject<Producer | null>
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
  audioProducerRef,
  videoProducerRef,
  localStreamRef,
  consumersRef,
  videoConsumersSuppressedRef,
  isCamOffRef,
  hasJoinedRef,
}: UseNetworkGuardParams) {
  const [uplinkQuality, setUplinkQuality] = useState<NetworkQuality>("good")
  const [downlinkQuality, setDownlinkQuality] = useState<NetworkQuality>("good")
  const [videoMode, setVideoModeState] = useState<VideoMode>("auto")
  // Video we stopped SENDING because our uplink couldn't carry it.
  const [uplinkVideoSuppressed, setUplinkVideoSuppressed] = useState(false)
  // Incoming video we stopped RECEIVING because our downlink couldn't carry it.
  const [downlinkVideoSuppressed, setDownlinkVideoSuppressed] = useState(false)

  const videoModeRef = useRef<VideoMode>("auto")
  videoModeRef.current = videoMode

  // Cumulative counters from the previous sample, keyed by stats source.
  const prevUplinkRef = useRef<Counter | undefined>(undefined)
  const prevDownlinkRef = useRef<Map<string, Counter>>(new Map())

  // Hysteresis state. Suppression needs a sustained bad streak; restoring needs
  // an even longer good streak, so the picture never flaps on and off.
  const uplinkBadStreakRef = useRef(0)
  const uplinkGoodStreakRef = useRef(0)
  const downlinkBadStreakRef = useRef(0)
  const downlinkGoodStreakRef = useRef(0)

  const uplinkSuppressedRef = useRef(false)
  const uplinkSuppressedAtRef = useRef(0)
  const uplinkRestoredAtRef = useRef(0)
  const uplinkHoldMsRef = useRef(NETWORK_GUARD.MIN_SUPPRESSION_MS)

  // Downlink degrades in two steps: camera video first (cheap to lose), then
  // screen share (usually the whole point of the meeting, so it goes last).
  const downlinkStageRef = useRef<0 | 1 | 2>(0)
  const downlinkSuppressedAtRef = useRef(0)
  const downlinkRestoredAtRef = useRef(0)
  const downlinkHoldMsRef = useRef(NETWORK_GUARD.MIN_SUPPRESSION_MS)

  const appliedVoiceBitrateRef = useRef(0)

  // -------------------------------------------------------------------------
  // Uplink sampling: how much of OUR voice is the server actually receiving?
  // -------------------------------------------------------------------------
  const sampleUplink = useCallback(async (): Promise<Sample> => {
    const producer = audioProducerRef.current
    const transport = sendTransportRef.current
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
          if (typeof report.roundTripTime === "number") rtt = Math.max(rtt, report.roundTripTime)
          const counter: Counter = {
            packetsLost: typeof report.packetsLost === "number" ? report.packetsLost : 0,
            packetsTotal: typeof report.packetsReceived === "number" ? report.packetsReceived : 0,
          }
          // Prefer the delta-based ratio; fall back to the browser-reported
          // `fractionLost` when packet counters aren't exposed.
          const delta = lossFromDelta(prevUplinkRef.current, counter)
          const fraction = typeof report.fractionLost === "number" ? report.fractionLost : 0
          loss = Math.max(loss, delta, fraction)
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
          if (typeof report.availableOutgoingBitrate === "number") {
            availableBps = Math.max(availableBps, report.availableOutgoingBitrate)
            measured = true
          }
          if (typeof report.currentRoundTripTime === "number") {
            rtt = Math.max(rtt, report.currentRoundTripTime)
          }
        })
      } catch {
        // Ignore.
      }
    }

    if (!measured) return EMPTY_SAMPLE
    return { loss, rtt, availableBps, measured }
  }, [audioProducerRef, sendTransportRef])

  // -------------------------------------------------------------------------
  // Downlink sampling: how much of THEIR voice are we losing on the way in?
  // -------------------------------------------------------------------------
  const sampleDownlink = useCallback(async (): Promise<Sample> => {
    const consumers = Array.from(consumersRef.current.values()).filter(
      (consumer) =>
        !consumer.closed &&
        !consumer.paused &&
        consumer.kind === "audio" &&
        (consumer.appData as Record<string, unknown>)?.source !== "screen",
    )
    if (consumers.length === 0) return EMPTY_SAMPLE

    let loss = 0
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
              packetsLost: typeof report.packetsLost === "number" ? report.packetsLost : 0,
              packetsTotal: typeof report.packetsReceived === "number" ? report.packetsReceived : 0,
            }
            seen.add(consumer.id)
            // Worst peer wins: if any single voice stream is falling apart, the
            // call is already unpleasant and video has to go.
            loss = Math.max(loss, lossFromDelta(prevDownlinkRef.current.get(consumer.id), counter))
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
      if (!seen.has(id)) prevDownlinkRef.current.delete(id)
    }

    if (!measured) return EMPTY_SAMPLE
    return { loss, rtt: 0, availableBps: 0, measured }
  }, [consumersRef])

  // -------------------------------------------------------------------------
  // Applying the uplink decision.
  //
  // Deliberately pause + disable the track rather than closing the producer:
  // closing would require a fresh getUserMedia (slow, may re-prompt, may fail)
  // to come back, whereas a paused producer resumes instantly. `track.enabled`
  // is cleared too so the encoder actually stops doing work.
  // -------------------------------------------------------------------------
  const applyUplink = useCallback(
    (suppressed: boolean) => {
      const producer = videoProducerRef.current
      const track = localStreamRef.current?.getVideoTracks()[0]
      // Never resume video the user themselves switched off.
      const wantsVideo = !suppressed && !isCamOffRef.current

      if (!producer || producer.closed) {
        if (track) track.enabled = wantsVideo || !isCamOffRef.current
        return
      }

      if (!wantsVideo) {
        if (track) track.enabled = false
        if (!producer.paused) {
          producer.pause()
          socketRef.current?.emit("pauseProducer", {
            roomId,
            peerId: peerIdRef.current,
            producerId: producer.id,
            paused: true,
          })
        }
        return
      }

      if (track) track.enabled = true
      if (producer.paused) {
        producer.resume()
        socketRef.current?.emit("pauseProducer", {
          roomId,
          peerId: peerIdRef.current,
          producerId: producer.id,
          paused: false,
        })
      }
    },
    [roomId, peerIdRef, socketRef, videoProducerRef, localStreamRef, isCamOffRef],
  )

  // -------------------------------------------------------------------------
  // Applying the downlink decision.
  //
  // The server-side pause is what frees bandwidth; the client-side pause just
  // stops the decoder. We do both. Re-running this every tick also catches
  // consumers that appeared after the decision was made.
  // -------------------------------------------------------------------------
  const applyDownlink = useCallback(
    (stage: 0 | 1 | 2) => {
      const socket = socketRef.current
      for (const consumer of consumersRef.current.values()) {
        if (consumer.closed || consumer.kind !== "video") continue
        const isScreen = (consumer.appData as Record<string, unknown>)?.source === "screen"
        const shouldPause = isScreen ? stage >= 2 : stage >= 1
        if (shouldPause === !!consumer.paused) continue

        if (shouldPause) consumer.pause()
        else consumer.resume()

        socket?.emit("pauseConsumer", {
          roomId,
          peerId: peerIdRef.current,
          consumerId: consumer.id,
          paused: shouldPause,
        })
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
      const target = NETWORK_GUARD.VOICE_BITRATE[quality]
      if (appliedVoiceBitrateRef.current === target) return
      const producer = audioProducerRef.current
      if (!producer || producer.closed) return
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
  // The monitoring loop
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (cancelled) return

      const mode = videoModeRef.current

      // Manual low-data mode: nothing to measure, just hold video off.
      if (mode === "audio-only") {
        uplinkSuppressedRef.current = true
        downlinkStageRef.current = 2
        videoConsumersSuppressedRef.current = true
        applyUplink(true)
        applyDownlink(2)
        setUplinkVideoSuppressed(true)
        setDownlinkVideoSuppressed(true)
        schedule()
        return
      }

      if (!hasJoinedRef.current) {
        schedule()
        return
      }

      const [uplink, downlink] = await Promise.all([sampleUplink(), sampleDownlink()])
      if (cancelled) return

      const uplinkClass = classify(uplink, NETWORK_GUARD.BAD_UPLINK_BPS, NETWORK_GUARD.WEAK_UPLINK_BPS)
      const downlinkClass = classify(downlink, 0, 0)
      setUplinkQuality(uplinkClass)
      setDownlinkQuality(downlinkClass)

      const worst: NetworkQuality =
        uplinkClass === "bad" || downlinkClass === "bad"
          ? "bad"
          : uplinkClass === "weak" || downlinkClass === "weak"
            ? "weak"
            : "good"
      void applyVoiceBitrate(worst)

      const now = Date.now()

      // ---- uplink decision -------------------------------------------------
      if (mode === "force-video") {
        // The user explicitly asked to keep sending video. Restore it if we had
        // suppressed it earlier, and stop deciding for them.
        if (uplinkSuppressedRef.current) {
          uplinkSuppressedRef.current = false
          uplinkRestoredAtRef.current = now
          setUplinkVideoSuppressed(false)
        }
        uplinkBadStreakRef.current = 0
        uplinkGoodStreakRef.current = 0
      } else if (uplinkClass === "bad") {
        uplinkGoodStreakRef.current = 0
        uplinkBadStreakRef.current += 1
        if (
          !uplinkSuppressedRef.current &&
          uplinkBadStreakRef.current >= NETWORK_GUARD.BAD_SAMPLES_TO_SUPPRESS &&
          videoProducerRef.current &&
          !isCamOffRef.current
        ) {
          // Re-suppressing soon after a restore means the link genuinely cannot
          // carry video: hold it off for twice as long this time.
          if (now - uplinkRestoredAtRef.current < NETWORK_GUARD.FLAP_WINDOW_MS) {
            uplinkHoldMsRef.current = Math.min(
              uplinkHoldMsRef.current * 2,
              NETWORK_GUARD.MAX_SUPPRESSION_MS,
            )
          }
          uplinkSuppressedRef.current = true
          uplinkSuppressedAtRef.current = now
          setUplinkVideoSuppressed(true)
          console.warn(
            `[media] Uplink video suppressed room=${roomId} peer=${peerIdRef.current} loss=${uplink.loss.toFixed(3)} avail=${uplink.availableBps} holdMs=${uplinkHoldMsRef.current}`,
          )
        }
      } else if (uplinkClass === "good") {
        uplinkBadStreakRef.current = 0
        uplinkGoodStreakRef.current += 1
        if (
          uplinkSuppressedRef.current &&
          uplinkGoodStreakRef.current >= NETWORK_GUARD.GOOD_SAMPLES_TO_RESTORE &&
          now - uplinkSuppressedAtRef.current >= uplinkHoldMsRef.current
        ) {
          uplinkSuppressedRef.current = false
          uplinkRestoredAtRef.current = now
          setUplinkVideoSuppressed(false)
          console.info(`[media] Uplink video restored room=${roomId} peer=${peerIdRef.current}`)
        }
      } else {
        // "weak" is a holding pattern: don't escalate, don't recover.
        uplinkBadStreakRef.current = 0
        uplinkGoodStreakRef.current = 0
      }

      // ---- downlink decision ----------------------------------------------
      if (mode === "force-video") {
        if (downlinkStageRef.current !== 0) {
          downlinkStageRef.current = 0
          downlinkRestoredAtRef.current = now
          setDownlinkVideoSuppressed(false)
        }
        downlinkBadStreakRef.current = 0
        downlinkGoodStreakRef.current = 0
      } else if (downlinkClass === "bad") {
        downlinkGoodStreakRef.current = 0
        downlinkBadStreakRef.current += 1
        if (
          downlinkBadStreakRef.current >= NETWORK_GUARD.BAD_SAMPLES_TO_SUPPRESS &&
          downlinkStageRef.current < 2
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
          // Step down one level at a time: cameras first, screen share only if
          // dropping the cameras wasn't enough.
          downlinkStageRef.current = (downlinkStageRef.current + 1) as 1 | 2
          downlinkSuppressedAtRef.current = now
          downlinkBadStreakRef.current = 0
          setDownlinkVideoSuppressed(true)
          console.warn(
            `[media] Downlink video suppressed room=${roomId} peer=${peerIdRef.current} stage=${downlinkStageRef.current} loss=${downlink.loss.toFixed(3)}`,
          )
        }
      } else if (downlinkClass === "good") {
        downlinkBadStreakRef.current = 0
        downlinkGoodStreakRef.current += 1
        if (
          downlinkStageRef.current > 0 &&
          downlinkGoodStreakRef.current >= NETWORK_GUARD.GOOD_SAMPLES_TO_RESTORE &&
          now - downlinkSuppressedAtRef.current >= downlinkHoldMsRef.current
        ) {
          downlinkStageRef.current = (downlinkStageRef.current - 1) as 0 | 1
          downlinkSuppressedAtRef.current = now
          downlinkGoodStreakRef.current = 0
          if (downlinkStageRef.current === 0) {
            downlinkRestoredAtRef.current = now
            setDownlinkVideoSuppressed(false)
          }
          console.info(
            `[media] Downlink video restored room=${roomId} peer=${peerIdRef.current} stage=${downlinkStageRef.current}`,
          )
        }
      } else {
        downlinkBadStreakRef.current = 0
        downlinkGoodStreakRef.current = 0
      }

      // Apply unconditionally: it's idempotent, and re-running it is how newly
      // created producers/consumers inherit the current decision.
      videoConsumersSuppressedRef.current = downlinkStageRef.current > 0
      applyUplink(uplinkSuppressedRef.current)
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
    videoProducerRef,
    videoConsumersSuppressedRef,
    sampleUplink,
    sampleDownlink,
    applyUplink,
    applyDownlink,
    applyVoiceBitrate,
  ])

  // -------------------------------------------------------------------------
  // Manual control
  // -------------------------------------------------------------------------
  const setVideoMode = useCallback(
    (mode: VideoMode) => {
      setVideoModeState(mode)
      // Act immediately instead of waiting for the next sample — a button that
      // takes two seconds to do anything feels broken.
      if (mode === "audio-only") {
        uplinkSuppressedRef.current = true
        downlinkStageRef.current = 2
        videoConsumersSuppressedRef.current = true
        setUplinkVideoSuppressed(true)
        setDownlinkVideoSuppressed(true)
        applyUplink(true)
        applyDownlink(2)
        return
      }
      if (mode === "force-video") {
        uplinkSuppressedRef.current = false
        downlinkStageRef.current = 0
        videoConsumersSuppressedRef.current = false
        uplinkRestoredAtRef.current = Date.now()
        downlinkRestoredAtRef.current = Date.now()
        setUplinkVideoSuppressed(false)
        setDownlinkVideoSuppressed(false)
        applyUplink(false)
        applyDownlink(0)
        return
      }
      // Back to auto: clear the streaks so the next decision is made from fresh
      // measurements rather than whatever was accumulated before the override.
      uplinkBadStreakRef.current = 0
      uplinkGoodStreakRef.current = 0
      downlinkBadStreakRef.current = 0
      downlinkGoodStreakRef.current = 0
    },
    [applyUplink, applyDownlink, videoConsumersSuppressedRef],
  )

  /**
   * Called when the user presses the camera button while the guard has video
   * suppressed. Two boolean flags ("user wants video" and "network took video
   * away") must stay independent, otherwise the camera button would appear
   * dead: the user turns the camera on, the guard immediately pauses it again,
   * and nothing visible happens. Treating the press as an explicit override
   * makes their intent win.
   */
  const noteUserWantsVideo = useCallback(() => {
    if (!uplinkSuppressedRef.current && downlinkStageRef.current === 0) return
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
    uplinkVideoSuppressed,
    downlinkVideoSuppressed,
  }
}
