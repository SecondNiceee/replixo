"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import type { Socket } from "socket.io-client"
import { playScreenShareSound, playScreenShareStopSound } from "@/lib/sounds"
import {
  captureMic,
  releaseMicTrack,
  diagnoseMicTrack,
  isGatedMicTrack,
  // Used by watchMicTrack to listen on the real device track behind the noise
  // gate. This was missing, which made every watchMicTrack() call throw a
  // ReferenceError — see the note there.
  getRawMicTrack,
  type MicCapture,
} from "@/lib/mic-gate"
import { rememberProducerTransport, isProducerOnStaleTransport } from "./producer-transport"
import { SCREEN_QUALITY_PRESETS } from "./types"
import type { Transport, Producer, ScreenQuality } from "./types"
import type { Action } from "./reducer"
import { CAMERA_PRODUCE_OPTIONS } from "./types"

// When capturing screen/system audio we must exclude the audio that originates
// from THIS tab — i.e. our own WebRTC playback of the other participants. If we
// don't, sharing the screen "with system sound" re-captures everyone else's
// voices and streams them back, so a viewer ends up hearing their own voice
// echoed with a delay. `restrictOwnAudio` (Chrome 141+, desktop) is the
// purpose-built constraint for exactly this.
//
// We ALWAYS pass `restrictOwnAudio: true` rather than gating it behind
// `getSupportedConstraints().restrictOwnAudio`. Chromium is known to omit some
// newer screen-capture constraints from that dictionary even when the feature
// actually works, so the old feature-detection gate silently disabled the
// echo fix on machines where it would have applied. Passing an unknown
// constraint is harmless per the Media Capture spec: browsers that don't
// support `restrictOwnAudio` simply ignore the unrecognised member and still
// capture system audio, so there is no regression on older browsers.
//
// NOTE: we deliberately do NOT pass `suppressLocalAudioPlayback: true`.
// In Electron, screen audio is captured via `audio: "loopback"` (see
// electron/main.js). Combined with `suppressLocalAudioPlayback`, Chromium
// switches to a "loopback WITH mute" mode that silences local playback of the
// captured audio — and since the captured stream is the ENTIRE system mix, this
// mutes ALL sound on the sharer's machine, including the other participants'
// voices. The result: while sharing from desktop you can't hear anyone.
// Removing it restores incoming audio. Echo is addressed by `restrictOwnAudio`
// (below) and, ultimately, Variant A (native process-loopback).
function getScreenAudioConstraint(): boolean | MediaTrackConstraints {
  return {
    restrictOwnAudio: true,
  } as MediaTrackConstraints
}

// Single source of truth for the microphone producer options: the mic is
// published from three places (toggle, device switch, recovery) and they must
// not drift apart.
const MIC_CODEC_OPTIONS = {
  opusFec: true,
  opusDtx: true,
  opusMaxAverageBitrate: 64_000,
} as const

// `stopTracks: false` is not a detail — it is the second half of the recovery
// bug. mediasoup-client defaults to `stopTracks: true`, which makes
// `producer.close()` call `track.stop()` on OUR track. Recovery closes the stale
// producer and then republishes the SAME live track, so the default silently
// ended the microphone one line before `produce()` — exactly the
// "InvalidStateError: track ended" that showed up in the logs, after which the
// watchdog saw an ended track, re-captured, and the loop started over.
//
// Track lifetime is owned by this hook anyway (`releaseMicTrack` /
// `track.stop()` on toggle-off and on leaving the room), so nothing else relied
// on close() stopping tracks for us.
const MIC_PRODUCE_OPTIONS = {
  codecOptions: MIC_CODEC_OPTIONS,
  stopTracks: false,
} as const

interface UseMediaControlsParams {
  roomId: string
  peerIdRef: React.MutableRefObject<string>
  socketRef: React.MutableRefObject<Socket | null>
  sendTransportRef: React.MutableRefObject<Transport | null>
  localStreamRef: React.MutableRefObject<MediaStream | null>
  audioProducerRef: React.MutableRefObject<Producer | null>
  videoProducerRef: React.MutableRefObject<Producer | null>
  screenVideoProducerRef: React.MutableRefObject<Producer | null>
  screenAudioProducerRef: React.MutableRefObject<Producer | null>
  screenStreamRef: React.MutableRefObject<MediaStream | null>
  screenQualityRef: React.MutableRefObject<ScreenQuality>
  selectedMicIdRef: React.MutableRefObject<string | undefined>
  // Reflects the user's camera intent, so recovery can republish paused
  // instead of unexpectedly turning the camera back on.
  isCamOffRef?: React.MutableRefObject<boolean>
  // The user's mute intent, so mic recovery republishes paused instead of
  // unexpectedly opening a live microphone.
  isMicMutedRef?: React.MutableRefObject<boolean>
  // Guards against two microphone producers being created at once. The join /
  // rejoin catch-up publish in use-mediasoup shares this ref with `toggleMic`,
  // because `!audioProducerRef.current` alone is not a lock: `produce()` is
  // async, so a click during join used to create a second, orphaned producer
  // that no mute ever reached ("I'm muted but they still hear me").
  audioPublishInFlightRef?: React.MutableRefObject<boolean>
  /** True while we're in a room; the mic watchdog only runs then. */
  hasJoinedRef?: React.MutableRefObject<boolean>
  /**
   * Called when the user deliberately turns their camera ON. The weak-network
   * guard may have video suppressed at that moment, and without this signal it
   * would re-pause the freshly published producer within two seconds, making the
   * camera button look broken.
   */
  onUserWantsVideo?: () => void
  dispatch: (action: Action) => void
}

export function useMediaControls({
  roomId,
  peerIdRef,
  socketRef,
  sendTransportRef,
  localStreamRef,
  audioProducerRef,
  videoProducerRef,
  screenVideoProducerRef,
  screenAudioProducerRef,
  screenStreamRef,
  screenQualityRef,
  selectedMicIdRef,
  isCamOffRef,
  isMicMutedRef,
  audioPublishInFlightRef,
  hasJoinedRef,
  onUserWantsVideo,
  dispatch,
}: UseMediaControlsParams) {
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [screenQuality, setScreenQualityState] = useState<ScreenQuality>("auto")
  // True while the camera is being turned on (getUserMedia + publish can take a
  // few seconds). The UI shows a loader on the camera button during this window.
  const [isCamStarting, setIsCamStarting] = useState(false)
  const [activeMicId, setActiveMicId] = useState<string | null>(null)
  // Non-fatal microphone problems (publish failed, device vanished, recovery
  // gave up). Deliberately NOT dispatched as ERROR: that sets status="error" and
  // replaces the whole room UI, which is far too destructive for "your mic did
  // not come up" — and it also hides the fact that the call itself is fine.
  const [micNotice, setMicNotice] = useState<string | null>(null)
  const [isMicSwitching, setIsMicSwitching] = useState(false)
  const screenRecoveryInFlightRef = useRef(false)
  const camRecoveryInFlightRef = useRef(false)
  const micRecoveryInFlightRef = useRef(false)
  // Cooldown + failure budget for mic recovery. A device that is genuinely gone
  // (or hardware-muted) must not be re-acquired in a loop for the whole call.
  const lastMicRecoverAtRef = useRef(0)
  const micFailuresRef = useRef(0)
  // Fallback when the caller doesn't pass a shared publish lock.
  const localAudioPublishLockRef = useRef(false)
  const audioPublishLockRef = audioPublishInFlightRef ?? localAudioPublishLockRef
  // Indirection so the microphone watchdog can call recovery even though
  // recoverMic is declared further down.
  const recoverMicRef = useRef<(reason: string, force?: boolean) => Promise<boolean>>(async () => false)
  // RTP liveness probe state, keyed by producer id. `proven` is a one-way latch:
  // once packets have demonstrably reached the SFU, this producer is never
  // probed again, so a user who simply stops talking can never be mistaken for a
  // broken microphone.
  const rtpProbeRef = useRef<{ producerId: string | null; since: number; strikes: number; proven: boolean }>({
    producerId: null, since: 0, strikes: 0, proven: false,
  })
  const rtpRecoveryAttemptsRef = useRef(0)
  // Indirection so the camera track's "ended" watcher can call recovery even
  // though recoverCamera is declared further down.
  const recoverCameraRef = useRef<() => Promise<boolean>>(async () => false)
  const screenCaptureCleanupRef = useRef<(() => void) | null>(null)

  // Mirror of watchCameraTrack for audio: react the instant the OS/browser kills
  // the microphone (device unplugged, driver reset, exclusive-mode grab) instead
  // of waiting up to 3 s for the watchdog poll.
  //
  // The published track is usually the noise gate's destination track, which
  // NEVER fires "ended" — its device dying is invisible from the outside. So we
  // listen on the raw device track behind the gate as well.
  const watchMicTrack = useCallback((track: MediaStreamTrack) => {
    const onEnded = () => {
      // Only self-heal if this is still the track we're publishing.
      if (localStreamRef.current?.getAudioTracks()[0] !== track) return
      void recoverMicRef.current("track-ended")
    }
    track.addEventListener("ended", onEnded)
    // Attaching a watcher is pure hardening — it must never be able to fail the
    // publish that just succeeded. It previously could: `getRawMicTrack` wasn't
    // imported, so this line threw a ReferenceError *after* produce() had already
    // stored the producer, sending toggleMic into its rollback path. That killed
    // the live track and showed "не удалось включить микрофон" while leaving an
    // orphaned producer behind — a mic that was on, published, and silent.
    try {
      const raw = getRawMicTrack(track)
      if (raw && raw !== track) raw.addEventListener("ended", onEnded)
    } catch (err) {
      console.error("[media] Failed to watch raw mic track", err)
    }
  }, [localStreamRef])

  // ---------------------------------------------------------------------------
  // Wait for the send transport to be ready (user can click mic/cam before join)
  // ---------------------------------------------------------------------------
  const waitForSendTransport = useCallback((timeoutMs = 15000): Promise<Transport | null> => {
    return new Promise((resolve) => {
      if (sendTransportRef.current) { resolve(sendTransportRef.current); return }
      const started = Date.now()
      const id = setInterval(() => {
        if (sendTransportRef.current) { clearInterval(id); resolve(sendTransportRef.current); return }
        if (Date.now() - started >= timeoutMs) { clearInterval(id); resolve(null) }
      }, 200)
    })
  }, [sendTransportRef])

  // ---------------------------------------------------------------------------
  // Mic toggle
  // ---------------------------------------------------------------------------
  const toggleMic = useCallback(async () => {
    const stream = localStreamRef.current
    if (!stream) return
    const existing = stream.getAudioTracks()[0]

    if (!existing) {
      // Turning the mic ON. Two things used to go wrong here and both left the
      // user silent while the button showed "mic on":
      //   * the optimistic TOGGLE_MIC was dispatched BEFORE produce(), and a
      //     failed / timed-out publish was never rolled back;
      //   * nothing serialised concurrent publishes.
      if (audioPublishLockRef.current || micRecoveryInFlightRef.current) return
      audioPublishLockRef.current = true
    // A deliberate press is the user asking us to try again: give recovery a
    // fresh budget so a previously exhausted microphone can self-heal later.
    micFailuresRef.current = 0
    lastMicRecoverAtRef.current = 0
    // Same for the RTP probe, otherwise a mic that exhausted its republish budget
    // earlier in the call would never be re-verified after a manual retry.
    rtpRecoveryAttemptsRef.current = 0
      let capture: MicCapture | null = null
      try {
        capture = await captureMic(selectedMicIdRef.current)
        setPermissionError(null)
        setMicNotice(null)
        const track = capture.track
        stream.addTrack(track)
        const actualDeviceId = capture.deviceId ?? selectedMicIdRef.current ?? null
        selectedMicIdRef.current = actualDeviceId ?? undefined
        setActiveMicId(actualDeviceId)

        const transport = sendTransportRef.current ?? (await waitForSendTransport())
        if (!transport || transport.closed) throw new Error("send transport unavailable")
        if (track.readyState !== "live") throw new Error("microphone track is not live")
        if (!audioProducerRef.current) {
          const producer = await transport.produce({ track, ...MIC_PRODUCE_OPTIONS })
          rememberProducerTransport(producer, transport)
          audioProducerRef.current = producer
        }
        // Dispatched only now, once the microphone is genuinely published. The
        // optimistic dispatch that used to sit before produce() was exactly what
        // made a failed publish look like a working microphone.
        watchMicTrack(track)
        dispatch({ type: "TOGGLE_MIC", isMuted: false, hasMic: true })
      } catch (err) {
        // Roll the microphone back to a state that matches reality, so the user
        // sees a mic-off button they can press again instead of believing they
        // are live.
        const track = capture?.track
        if (track) {
          try { stream.removeTrack(track) } catch { /* ignore */ }
          releaseMicTrack(track)
        }
        setActiveMicId(null)
        dispatch({ type: "TOGGLE_MIC", isMuted: true, hasMic: false })
        const name = (err as { name?: string })?.name
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setPermissionError("mic")
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          // The remembered device is gone — forget it so the next attempt asks
          // for the system default instead of failing the same way forever.
          selectedMicIdRef.current = undefined
          setMicNotice("Микрофон не найден. Подключите устройство и нажмите кнопку микрофона снова.")
        } else {
          setMicNotice("Не удалось включить микрофон. Нажмите кнопку микрофона, чтобы попробовать снова.")
        }
      } finally {
        audioPublishLockRef.current = false
      }
      return
    }

    // Track exists — mute/unmute
    const nextEnabled = !existing.enabled
    existing.enabled = nextEnabled
    const producer = audioProducerRef.current
    const socket = socketRef.current
    if (producer) {
      nextEnabled ? producer.resume() : producer.pause()
      socket?.emit("pauseProducer", {
        roomId, peerId: peerIdRef.current, producerId: producer.id, paused: !nextEnabled,
      })
    }
    dispatch({ type: "TOGGLE_MIC", isMuted: !nextEnabled })
  }, [roomId, peerIdRef, socketRef, localStreamRef, sendTransportRef, audioProducerRef,
      selectedMicIdRef, dispatch, waitForSendTransport, watchMicTrack])

  // Switch microphone device mid-call. The old track stays live until mediasoup
  // has accepted the replacement, so a failed device never breaks working audio.
  const switchMic = useCallback(async (deviceId: string): Promise<boolean> => {
    const stream = localStreamRef.current
    if (!stream || isMicSwitching) return false
    // Share the publish lock with toggleMic / the join catch-up publish, so a
    // device switch can never race a second audio producer into existence.
    if (audioPublishLockRef.current) return false
    audioPublishLockRef.current = true

    setIsMicSwitching(true)
    let capture: MicCapture | null = null
    try {
      const oldTrack = stream.getAudioTracks()[0]
      const wasEnabled = oldTrack?.enabled ?? true
      // Goes through the gate as well — switching a device must never silently
      // drop noise suppression.
      capture = await captureMic(deviceId)
      const newTrack = capture.track
      if (newTrack.readyState !== "live") throw new Error("Microphone track is not live")

      newTrack.enabled = wasEnabled
      const producer = audioProducerRef.current
      const sendTransport = sendTransportRef.current
      if (producer) {
        await producer.replaceTrack({ track: newTrack })
      } else if (sendTransport) {
        const newProducer = await sendTransport.produce({
          track: newTrack,
          ...MIC_PRODUCE_OPTIONS,
        })
        rememberProducerTransport(newProducer, sendTransport)
        audioProducerRef.current = newProducer
        if (!wasEnabled) await newProducer.pause()
      }

      if (oldTrack) {
        stream.removeTrack(oldTrack)
        // Releases the hidden raw device track behind the gate too — stopping
        // the published track alone would keep the old microphone open.
        releaseMicTrack(oldTrack)
      }
      stream.addTrack(newTrack)
      watchMicTrack(newTrack)

      const actualDeviceId = capture.deviceId ?? deviceId
      selectedMicIdRef.current = actualDeviceId
      setActiveMicId(actualDeviceId)
      setMicNotice(null)
      dispatch({ type: "TOGGLE_MIC", isMuted: !wasEnabled, hasMic: true })
      return true
    } catch {
      releaseMicTrack(capture?.track)
      // The old track is still published and working, so this is a notice rather
      // than a room-level ERROR (which renders as a fatal connection failure).
      setMicNotice("Не удалось переключить микрофон. Прежнее устройство продолжает работать.")
      return false
    } finally {
      setIsMicSwitching(false)
      // Releasing this is not optional: the lock is shared with `toggleMic` and
      // the join catch-up publish, so leaking it here would make the microphone
      // button silently do nothing for the rest of the call.
      audioPublishLockRef.current = false
      micFailuresRef.current = 0
    }
  }, [localStreamRef, sendTransportRef, audioProducerRef, selectedMicIdRef, dispatch,
      isMicSwitching, watchMicTrack])

  // ---------------------------------------------------------------------------
  // Microphone recovery (the audio counterpart of recoverCamera)
  //
  // Audio used to be completely absent from the self-healing system: the session
  // assessment only looked at the transports, the camera and the screen share.
  // Every way of ending up with a dead microphone — a publish that timed out, a
  // producer orphaned by a transport rebuild, an OS-reclaimed device, a WebAudio
  // graph that turned out to be silent — therefore lasted until the user rejoined
  // the room, all the while showing them a cheerful "mic on" button.
  //
  // This re-acquires the device (when the current track cannot be carrying audio)
  // and re-publishes it on the CURRENT send transport, preserving the user's mute
  // intent so recovery never opens a microphone the user had muted.
  // ---------------------------------------------------------------------------
  // `force` republishes even when every local object looks healthy. The RTP
  // liveness probe needs this: a producer can be open, on the right transport,
  // with a live track, and still deliver zero packets to the SFU — which is
  // exactly the "video works, nobody hears me, rejoining fixes it" case. Without
  // `force` that call would return false right here and change nothing.
  const recoverMic = useCallback(async (reason: string, force = false): Promise<boolean> => {
    if (micRecoveryInFlightRef.current || audioPublishLockRef.current) return false
    const stream = localStreamRef.current
    if (!stream) return false

    const existing = stream.getAudioTracks()[0] ?? null
    const producer = audioProducerRef.current
    // The user deliberately has no microphone running — leave it that way.
    if (!existing && !producer) return false

    const diagnosis = diagnoseMicTrack(existing)
    const sendTransport = sendTransportRef.current
    const producerDead = !producer
      || producer.closed
      || isProducerOnStaleTransport(producer, sendTransport)
    if (!diagnosis && !producerDead && !force) return false

    const now = Date.now()
    if (now - lastMicRecoverAtRef.current < 5000) return false
    if (micFailuresRef.current >= 3) return false
    lastMicRecoverAtRef.current = now

    micRecoveryInFlightRef.current = true
    // Shared with toggleMic / switchMic / the join catch-up publish: recovery
    // must never race a second audio producer into existence.
    audioPublishLockRef.current = true
    console.warn(`[media] Mic recovery room=${roomId} peer=${peerIdRef.current} reason=${reason} diagnosis=${diagnosis ?? "producer-dead"} gated=${isGatedMicTrack(existing)}`)

    const closeStaleProducer = () => {
      const current = audioProducerRef.current
      if (!current) return
      if (!current.closed) {
        socketRef.current?.emit("closeProducer", {
          roomId, peerId: peerIdRef.current, producerId: current.id,
        })
        current.close()
      }
      audioProducerRef.current = null
    }

    try {
      let track = existing

      // Only re-acquire when the current track provably cannot carry audio;
      // a healthy track is reused so recovery stays as cheap as possible.
      if (diagnosis) {
        if (existing) {
          stream.removeTrack(existing)
          releaseMicTrack(existing)
        }
        try {
          const capture = await captureMic(selectedMicIdRef.current)
          track = capture.track
          selectedMicIdRef.current = capture.deviceId ?? undefined
          setActiveMicId(capture.deviceId ?? null)
          stream.addTrack(track)
          watchMicTrack(track)
        } catch {
          // The microphone is genuinely unavailable. Tell the truth in the UI
          // instead of pretending the user is live.
          closeStaleProducer()
          setActiveMicId(null)
          micFailuresRef.current += 1
          dispatch({ type: "TOGGLE_MIC", isMuted: true, hasMic: false })
          setMicNotice("Микрофон перестал работать. Нажмите кнопку микрофона, чтобы включить его снова.")
          return false
        }
      }

      if (!track || track.readyState !== "live") {
        micFailuresRef.current += 1
        return false
      }

      // The old producer points at a dead track (or a transport that no longer
      // exists) and can never resume by itself.
      closeStaleProducer()

      const transport = sendTransportRef.current ?? (await waitForSendTransport())
      if (!transport || transport.closed) {
        micFailuresRef.current += 1
        return false
      }

      // Re-check right before publishing: `closeStaleProducer()` and awaiting the
      // transport are both places where the device can die under us, and
      // `produce()` throws InvalidStateError on an ended track.
      if (track.readyState !== "live") {
        micFailuresRef.current += 1
        return false
      }

      const nextProducer = await transport.produce({ track, ...MIC_PRODUCE_OPTIONS })
      rememberProducerTransport(nextProducer, transport)
      audioProducerRef.current = nextProducer

      const muted = isMicMutedRef?.current ?? false
      track.enabled = !muted
      if (muted) {
        await nextProducer.pause()
        socketRef.current?.emit("pauseProducer", {
          roomId, peerId: peerIdRef.current, producerId: nextProducer.id, paused: true,
        })
        dispatch({ type: "TOGGLE_MIC", isMuted: true, hasMic: true })
      } else {
        dispatch({ type: "TOGGLE_MIC", isMuted: false, hasMic: true })
      }
      // Only a genuinely healthy result refills the budget. Re-acquiring a device
      // that comes back muted again (hardware mute switch, another app holding it)
      // must not loop forever, so it counts as a failed attempt.
      if (diagnoseMicTrack(track) === null) {
        micFailuresRef.current = 0
        setMicNotice(null)
      } else {
        micFailuresRef.current += 1
      }
      console.info(`[media] Mic recovered room=${roomId} peer=${peerIdRef.current} muted=${muted}`)
      return true
    } catch (error) {
      micFailuresRef.current += 1
      console.error(`[media] Mic recovery failed room=${roomId} peer=${peerIdRef.current}`, error)
      if (micFailuresRef.current >= 3) {
        setMicNotice("Не удалось восстановить микрофон. Нажмите кнопку микрофона, чтобы попробовать снова.")
      }
      return false
    } finally {
      micRecoveryInFlightRef.current = false
      audioPublishLockRef.current = false
    }
  }, [roomId, peerIdRef, socketRef, localStreamRef, sendTransportRef, audioProducerRef,
      selectedMicIdRef, isMicMutedRef, dispatch, waitForSendTransport, watchMicTrack])

  // Keep the indirection ref pointing at the latest recovery closure.
  recoverMicRef.current = recoverMic

  // ---------------------------------------------------------------------------
  // Microphone watchdog
  //
  // A published microphone track never "ends" on its own when it comes out of the
  // noise gate, and a producer orphaned by a rebuild throws nothing — so the only
  // way to notice a silent microphone is to look at it periodically.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // The problem must persist before we act. A device track is briefly `muted`
    // in perfectly normal situations (OS switching the default device, a headset
    // waking up), and re-acquiring the microphone every few seconds because of
    // that would be worse than the bug it fixes.
    const DWELL_MS: Record<string, number> = { "device-muted": 8000, "context-not-running": 6000 }
    let issue: { key: string; since: number } | null = null

    const timer = setInterval(() => {
      if (hasJoinedRef && !hasJoinedRef.current) return
      if (audioPublishLockRef.current || micRecoveryInFlightRef.current) return
      const stream = localStreamRef.current
      if (!stream) { issue = null; return }
      const track = stream.getAudioTracks()[0] ?? null
      const producer = audioProducerRef.current
      // Microphone intentionally off.
      if (!track && !producer) { issue = null; return }
      const diagnosis = diagnoseMicTrack(track)
      const sendTransport = sendTransportRef.current
      const producerDead = !producer
        || producer.closed
        || isProducerOnStaleTransport(producer, sendTransport)
      if (!diagnosis && !producerDead) { issue = null; return }

      const key = diagnosis ?? "producer-dead"
      const now = Date.now()
      if (issue?.key !== key) issue = { key, since: now }
      if (now - issue.since < (DWELL_MS[key] ?? 0)) return
      issue = null
      void recoverMicRef.current(`watchdog:${key}`)
    }, 3000)
    return () => clearInterval(timer)
  }, [hasJoinedRef, localStreamRef, audioProducerRef, sendTransportRef])

  // ---------------------------------------------------------------------------
  // Outbound audio RTP liveness probe
  //
  // Every other mic check inspects local object *state*: track.readyState,
  // producer.closed, producer.transport. All of those can look perfect while not
  // a single packet reaches the SFU (half-broken transport, ICE that came up but
  // carries nothing, a producer the server never wired to consumers). That is the
  // last remaining shape of "video is fine, nobody hears me, rejoining fixes it".
  //
  // The danger here is the opposite failure: the noise gate outputs exact zeros
  // when closed (gain → 0) and `opusDtx` then legitimately stops sending, so a
  // silent *person* looks identical to a silent *microphone* if you measure rate.
  // So this never measures rate — it asks a one-shot question: has audio EVER
  // reached the server on this producer? A real device always carries a noise
  // floor and the gate starts open, so any working mic proves itself within
  // seconds and latches `proven` forever. Staying at exactly zero is breakage.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Long enough for ICE/DTLS plus the first RTCP receiver report to arrive.
    const GRACE_MS = 6000
    // Two consecutive zero samples before acting, so one late RTCP report or a
    // momentary stats gap can never kill a working microphone.
    const STRIKES_TO_ACT = 2
    const MAX_RTP_RECOVERIES = 2
    let checking = false

    const timer = setInterval(() => {
      if (checking) return
      if (hasJoinedRef && !hasJoinedRef.current) return
      if (audioPublishLockRef.current || micRecoveryInFlightRef.current) return

      const producer = audioProducerRef.current
      const probe = rtpProbeRef.current

      if (!producer || producer.closed) {
        if (probe.producerId !== null) {
          rtpProbeRef.current = { producerId: null, since: 0, strikes: 0, proven: false }
        }
        return
      }
      // A new producer starts a fresh grace window and a fresh verdict.
      if (probe.producerId !== producer.id) {
        rtpProbeRef.current = { producerId: producer.id, since: Date.now(), strikes: 0, proven: false }
        return
      }
      if (probe.proven) return
      // Muted: zero packets is the correct behaviour, and the grace window has to
      // restart from the moment the user unmutes.
      if (producer.paused || isMicMutedRef?.current) {
        probe.since = Date.now()
        probe.strikes = 0
        return
      }
      if (Date.now() - probe.since < GRACE_MS) return

      checking = true
      void (async () => {
        try {
          let remoteReports = 0
          let reportsReceived = 0
          let packetsLost = 0
          let packetsReceived = 0
          // `packetsReceived` on remote-inbound-rtp is spec'd but NOT implemented
          // by Chromium — it is simply absent there. Reading it as `|| 0` made a
          // perfectly working microphone look like it delivered zero packets,
          // which is why the "звук не уходит на сервер" notice appeared in calls
          // everyone could hear. So track whether the field exists at all and
          // only trust it when it does.
          let hasPacketsReceivedField = false
          let packetsSent = 0
          const stats: RTCStatsReport = await producer.getStats()
          stats.forEach((report: Record<string, unknown>) => {
            if (report.type === "remote-inbound-rtp") {
              remoteReports += 1
              reportsReceived += Number(report.reportsReceived) || 0
              packetsLost += Math.max(0, Number(report.packetsLost) || 0)
              if (typeof report.packetsReceived === "number") {
                hasPacketsReceivedField = true
                packetsReceived += report.packetsReceived
              }
            } else if (report.type === "outbound-rtp") {
              packetsSent += Number(report.packetsSent) || 0
            }
          })

          // Still the producer we sampled, and still unmuted? Otherwise discard.
          if (audioProducerRef.current !== producer) return
          if (producer.paused || isMicMutedRef?.current) return

          const prove = () => {
            probe.proven = true
            probe.strikes = 0
            rtpRecoveryAttemptsRef.current = 0
          }

          // Audio provably reached the SFU — latch and never probe again.
          if (hasPacketsReceivedField && packetsReceived > 0) {
            prove()
            return
          }
          // Browsers without that field: an RTCP receiver report for our stream
          // only exists because the SFU is actually receiving this RTP stream, so
          // any report (or any packet the SFU did not report as lost) is proof.
          if (remoteReports > 0 && (reportsReceived > 0 || packetsSent > packetsLost)) {
            prove()
            return
          }
          // No receiver report yet but packets are leaving: unmeasured, not broken.
          // Waiting is the safe verdict here.
          if (remoteReports === 0 && packetsSent > 0) return

          probe.strikes += 1
          if (probe.strikes < STRIKES_TO_ACT) return
          probe.strikes = 0
          probe.since = Date.now()

          if (rtpRecoveryAttemptsRef.current >= MAX_RTP_RECOVERIES) {
            // Republishing is not helping; stop looping and tell the truth.
            probe.proven = true
            setMicNotice("Звук не уходит на сервер. Нажмите кнопку микрофона или перезайдите в комнату.")
            return
          }
          rtpRecoveryAttemptsRef.current += 1
          console.warn(
            `[media] Outbound audio silent room=${roomId} peer=${peerIdRef.current} producer=${producer.id} sent=${packetsSent} received=${packetsReceived} reports=${remoteReports}`,
          )
          await recoverMicRef.current("rtp-silent", true)
        } catch {
          // Stats are unavailable mid ICE restart — treat as unmeasured.
        } finally {
          checking = false
        }
      })()
    }, 2000)
    return () => clearInterval(timer)
  }, [hasJoinedRef, audioProducerRef, isMicMutedRef, roomId, peerIdRef])

  // Watch a camera track so we notice the moment the OS/browser kills it
  // (network drop, device sleep, driver reset). Without this the tile silently
  // freezes on a black frame until the user toggles the camera manually.
  const watchCameraTrack = useCallback((track: MediaStreamTrack) => {
    track.addEventListener("ended", () => {
      // Only self-heal if this is still the track we're publishing.
      if (localStreamRef.current?.getVideoTracks()[0] !== track) return
      void recoverCameraRef.current()
    })
  }, [localStreamRef])

  // ---------------------------------------------------------------------------
  // Camera toggle
  // ---------------------------------------------------------------------------
  const toggleCam = useCallback(async () => {
    const stream = localStreamRef.current
    if (!stream) return
    const existing = stream.getVideoTracks()[0]

    if (!existing) {
      // Turning the camera ON — this can take a few seconds (permission prompt,
      // device warm-up, publishing). Surface a loader on the button meanwhile.
      setIsCamStarting(true)
      // Tell the network guard the user wants video *before* publishing, so the
      // new producer is never born into a suppressed state.
      onUserWantsVideo?.()
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true })
        setPermissionError(null)
        const track = camStream.getVideoTracks()[0]
        stream.addTrack(track)
        watchCameraTrack(track)
        dispatch({ type: "TOGGLE_CAM", isOff: false, hasCam: true })
        const transport = sendTransportRef.current ?? (await waitForSendTransport())
        if (transport && !videoProducerRef.current && track.readyState === "live") {
          const producer = await transport.produce({ track, ...CAMERA_PRODUCE_OPTIONS, stopTracks: false })
          rememberProducerTransport(producer, transport)
          videoProducerRef.current = producer
        }
      } catch (err) {
        const name = (err as { name?: string })?.name
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setPermissionError("cam")
        } else {
          dispatch({ type: "ERROR", error: "Нет доступа к камере" })
        }
      } finally {
        setIsCamStarting(false)
      }
      return
    }

    // Track exists — turn off camera and close producer
    existing.stop()
    stream.removeTrack(existing)
    const producer = videoProducerRef.current
    if (producer) {
      socketRef.current?.emit("closeProducer", {
        roomId, peerId: peerIdRef.current, producerId: producer.id,
      })
      producer.close()
      videoProducerRef.current = null
    }
    dispatch({ type: "TOGGLE_CAM", isOff: true })
  }, [roomId, peerIdRef, socketRef, localStreamRef, sendTransportRef, videoProducerRef,
      dispatch, waitForSendTransport, watchCameraTrack, onUserWantsVideo])

  // ---------------------------------------------------------------------------
  // Camera recovery after a network blip / device sleep
  //
  // A short outage frequently ends the camera capture track while leaving the
  // mic alive. An ended video track keeps rendering as a frozen black frame
  // locally and stops producing frames for everyone else, and because nothing
  // throws, the failure is silent. The ICE-restart recovery path reuses the
  // existing transport, so nothing would otherwise re-check the track — this
  // re-acquires the camera and re-publishes it without any user interaction.
  // ---------------------------------------------------------------------------
  const recoverCamera = useCallback(async () => {
    if (camRecoveryInFlightRef.current) return false
    const stream = localStreamRef.current
    if (!stream) return false

    const existingTrack = stream.getVideoTracks()[0]
    const producer = videoProducerRef.current
    const trackDead = !existingTrack || existingTrack.readyState === "ended"
    const producerDead = !producer || producer.closed

    // Nothing to do while the track is live and the producer is still attached
    // to the current send transport.
    if (!trackDead && !producerDead && !isProducerOnStaleTransport(producer, sendTransportRef.current)) return false
    // The user intentionally has no camera running — leave it that way.
    if (!existingTrack && !producer) return false

    camRecoveryInFlightRef.current = true
    try {
      let track = existingTrack

      if (trackDead) {
        if (existingTrack) {
          existingTrack.stop()
          stream.removeTrack(existingTrack)
        }
        try {
          const camStream = await navigator.mediaDevices.getUserMedia({ video: true })
          track = camStream.getVideoTracks()[0]
          if (track) {
            stream.addTrack(track)
            watchCameraTrack(track)
          }
        } catch {
          // Camera unplugged or permission revoked — surface it as "cam off"
          // so the UI stops showing a dead tile.
          if (producer) {
            socketRef.current?.emit("closeProducer", {
              roomId, peerId: peerIdRef.current, producerId: producer.id,
            })
            producer.close()
            videoProducerRef.current = null
          }
          dispatch({ type: "TOGGLE_CAM", isOff: true })
          return false
        }
      }

      if (!track || track.readyState !== "live") return false

      // Drop the stale producer: it references the dead track (or a transport
      // that no longer exists) and can never resume on its own.
      if (producer) {
        if (!producer.closed) {
          socketRef.current?.emit("closeProducer", {
            roomId, peerId: peerIdRef.current, producerId: producer.id,
          })
          producer.close()
        }
        videoProducerRef.current = null
      }

      const transport = sendTransportRef.current ?? (await waitForSendTransport())
      if (!transport || transport.closed) return false

      if (track.readyState !== "live") return false
      const nextProducer = await transport.produce({ track, ...CAMERA_PRODUCE_OPTIONS, stopTracks: false })
      rememberProducerTransport(nextProducer, transport)
      videoProducerRef.current = nextProducer

      // Preserve the user's intent: if the camera was toggled off, republish
      // paused rather than surprising them with a live feed.
      if (isCamOffRef?.current) {
        track.enabled = false
        nextProducer.pause()
      } else {
        track.enabled = true
        dispatch({ type: "TOGGLE_CAM", isOff: false, hasCam: true })
      }
      return true
    } catch {
      return false
    } finally {
      camRecoveryInFlightRef.current = false
    }
  }, [roomId, peerIdRef, socketRef, localStreamRef, sendTransportRef, videoProducerRef,
      isCamOffRef, dispatch, waitForSendTransport, watchCameraTrack])

  // Keep the indirection ref pointing at the latest recovery closure.
  recoverCameraRef.current = recoverCamera

  // ---------------------------------------------------------------------------
  // Screen share
  // ---------------------------------------------------------------------------
  const publishCapturedScreen = useCallback(async (
    transport: Transport,
    displayStream: MediaStream,
  ) => {
    const preset = SCREEN_QUALITY_PRESETS[screenQualityRef.current]
    const videoTrack = displayStream.getVideoTracks()[0]
    const audioTrack = displayStream.getAudioTracks()[0]

    if (videoTrack?.readyState === "live" && !screenVideoProducerRef.current) {
      if ("contentHint" in videoTrack) videoTrack.contentHint = "detail"
      const encoding: RTCRtpEncodingParameters = preset.maxBitrate
        ? { maxBitrate: preset.maxBitrate, scaleResolutionDownBy: 1, networkPriority: "high", priority: "high" }
        : { maxBitrate: 4_000_000, scaleResolutionDownBy: 1, networkPriority: "high", priority: "high" }
      const producer = await transport.produce({
        track: videoTrack,
        encodings: [encoding],
        codecOptions: {
          videoGoogleStartBitrate: preset.maxBitrate ? 2500 : 2000,
          videoGoogleMaxBitrate: preset.maxBitrate ? Math.round(preset.maxBitrate / 1000) : 4000,
          videoGoogleMinBitrate: 600,
        },
        appData: { source: "screen" },
        // Same reason as the microphone: screen recovery closes the stale
        // producer and republishes the SAME live capture track.
        stopTracks: false,
      })
      rememberProducerTransport(producer, transport)
      screenVideoProducerRef.current = producer
      try {
        const sender = producer.rtpSender
        if (sender) {
          const params = sender.getParameters()
          params.degradationPreference = "maintain-resolution"
          await sender.setParameters(params)
        }
      } catch { /* not all browsers support degradationPreference */ }
    }

    if (audioTrack?.readyState === "live" && !screenAudioProducerRef.current) {
      const audioProducer = await transport.produce({
        track: audioTrack,
        codecOptions: {
          opusStereo: true,
          opusDtx: false,
          opusFec: true,
          opusMaxPlaybackRate: 48_000,
          opusMaxAverageBitrate: 192_000,
        },
        appData: { source: "screen" },
        stopTracks: false,
      })
      rememberProducerTransport(audioProducer, transport)
      screenAudioProducerRef.current = audioProducer
    }
  }, [screenQualityRef, screenVideoProducerRef, screenAudioProducerRef])

  const stopScreenShare = useCallback((options?: { silent?: boolean }) => {
    const stream = screenStreamRef.current
    const wasSharing = !!stream || !!screenVideoProducerRef.current || !!screenAudioProducerRef.current

    screenCaptureCleanupRef.current?.()
    screenCaptureCleanupRef.current = null

    for (const producer of [screenVideoProducerRef.current, screenAudioProducerRef.current]) {
      if (!producer) continue
      socketRef.current?.emit("closeProducer", {
        roomId, peerId: peerIdRef.current, producerId: producer.id,
      })
      producer.close()
    }
    screenVideoProducerRef.current = null
    screenAudioProducerRef.current = null
    screenStreamRef.current = null
    stream?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    dispatch({ type: "SET_SCREEN_SHARING", isSharing: false })
    if (wasSharing && !options?.silent) playScreenShareStopSound()
  }, [roomId, peerIdRef, socketRef, screenVideoProducerRef, screenAudioProducerRef,
      screenStreamRef, dispatch])

  const recoverScreenShare = useCallback(async () => {
    if (screenRecoveryInFlightRef.current) return false
    const stream = screenStreamRef.current
    const videoTrack = stream?.getVideoTracks()[0]
    if (!stream || !videoTrack || videoTrack.readyState !== "live") {
      // The capture itself is genuinely gone (user pressed "Stop sharing", the
      // window closed). Only then do we tear the share down.
      stopScreenShare({ silent: true })
      return false
    }

    // Already healthy: live capture track published through a producer that
    // belongs to the current send transport. Republishing here would interrupt
    // an ongoing presentation for every viewer, so bail out untouched.
    const liveProducer = screenVideoProducerRef.current
    if (liveProducer && !liveProducer.closed && !isProducerOnStaleTransport(liveProducer, sendTransportRef.current)) {
      return true
    }

    screenRecoveryInFlightRef.current = true
    try {
      const transport = await waitForSendTransport()
      if (!transport || transport.closed) return false

      const currentVideo = screenVideoProducerRef.current
      const currentAudio = screenAudioProducerRef.current
      if (currentVideo && (currentVideo.closed || isProducerOnStaleTransport(currentVideo, transport))) {
        currentVideo.close()
        screenVideoProducerRef.current = null
      }
      if (currentAudio && (currentAudio.closed || isProducerOnStaleTransport(currentAudio, transport))) {
        currentAudio.close()
        screenAudioProducerRef.current = null
      }

      await publishCapturedScreen(transport, stream)
      const recovered = !!screenVideoProducerRef.current && !screenVideoProducerRef.current.closed
      dispatch({ type: "SET_SCREEN_SHARING", isSharing: recovered })
      console.info(`[media] Screen share recovery room=${roomId} peer=${peerIdRef.current} recovered=${recovered} audio=${!!screenAudioProducerRef.current}`)
      return recovered
    } catch (error) {
      console.error(`[media] Screen share recovery failed room=${roomId} peer=${peerIdRef.current}`, error)
      return false
    } finally {
      screenRecoveryInFlightRef.current = false
    }
  }, [roomId, peerIdRef, screenStreamRef, screenVideoProducerRef, screenAudioProducerRef,
      sendTransportRef, publishCapturedScreen, dispatch, waitForSendTransport, stopScreenShare])

  const startScreenShare = useCallback(async (options?: { silent?: boolean }) => {
    const sendTransport = sendTransportRef.current
    if (!sendTransport) return

    try {
      const preset = SCREEN_QUALITY_PRESETS[screenQualityRef.current]
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: preset.video,
        audio: getScreenAudioConstraint(),
      })
      screenStreamRef.current = displayStream

      const videoTrack = displayStream.getVideoTracks()[0]
      const audioTrack = displayStream.getAudioTracks()[0]

      await publishCapturedScreen(sendTransport, displayStream)

      if (audioTrack) {
        const replaceScreenAudio = async () => {
          const currentProducer = screenAudioProducerRef.current
          if (!currentProducer || currentProducer.closed || !screenVideoProducerRef.current) return
          try {
            const freshStream = await navigator.mediaDevices.getDisplayMedia({ audio: getScreenAudioConstraint(), video: false })
            const freshAudio = freshStream.getAudioTracks()[0]
            if (!freshAudio) { freshStream.getTracks().forEach((t) => t.stop()); return }
            await currentProducer.replaceTrack({ track: freshAudio })
            const prevTrack = screenStreamRef.current?.getAudioTracks()[0]
            if (prevTrack && prevTrack !== freshAudio) {
              prevTrack.onended = null
              prevTrack.stop()
              screenStreamRef.current?.removeTrack(prevTrack)
            }
            screenStreamRef.current?.addTrack(freshAudio)
            freshAudio.onended = replaceScreenAudio
          } catch { /* user cancelled — existing stream continues */ }
        }

        audioTrack.onended = replaceScreenAudio

        const onDeviceChange = async () => {
          const currentAudio = screenStreamRef.current?.getAudioTracks()[0]
          if (!screenAudioProducerRef.current || screenAudioProducerRef.current.closed) {
            navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
            return
          }
          if (!currentAudio || currentAudio.readyState === "ended") {
            navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
            await replaceScreenAudio()
          }
        }
        navigator.mediaDevices.addEventListener("devicechange", onDeviceChange)
        screenCaptureCleanupRef.current = () => {
          navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
          displayStream.removeEventListener("inactive", handleCaptureEnded)
        }
      } else {
        screenCaptureCleanupRef.current = () => {
          displayStream.removeEventListener("inactive", handleCaptureEnded)
        }
      }

      function handleCaptureEnded() {
        stopScreenShare()
      }
      displayStream.addEventListener("inactive", handleCaptureEnded)
      if (videoTrack) videoTrack.onended = handleCaptureEnded

      dispatch({ type: "SET_SCREEN_SHARING", isSharing: true })
      if (!options?.silent) playScreenShareSound()
    } catch { /* user cancelled or permission denied */ }
  }, [sendTransportRef, screenQualityRef, screenStreamRef, screenVideoProducerRef,
      screenAudioProducerRef, dispatch, stopScreenShare, publishCapturedScreen])

  const toggleScreenShare = useCallback(async () => {
    const hasScreenSession = !!screenStreamRef.current
      || !!screenVideoProducerRef.current
      || !!screenAudioProducerRef.current
    if (hasScreenSession) stopScreenShare()
    else await startScreenShare()
  }, [screenStreamRef, screenVideoProducerRef, screenAudioProducerRef, startScreenShare, stopScreenShare])

  const setScreenQuality = useCallback(
    async (quality: ScreenQuality) => {
      screenQualityRef.current = quality
      setScreenQualityState(quality)
      if (screenVideoProducerRef.current) {
        stopScreenShare({ silent: true })
        await startScreenShare({ silent: true })
      }
    },
    [screenQualityRef, screenVideoProducerRef, startScreenShare, stopScreenShare],
  )

  return {
    permissionError,
    clearPermissionError: () => setPermissionError(null),
    micNotice,
    clearMicNotice: () => setMicNotice(null),
    recoverMic,
    // Exposed so the join catch-up publish in use-mediasoup.ts can reuse the
    // exact same track watching / transport readiness logic as toggleMic and
    // recoverMic, instead of publishing the mic through an unguarded path.
    watchMicTrack,
    waitForSendTransport,
    screenQuality,
    isCamStarting,
    activeMicId,
    isMicSwitching,
    toggleMic,
    switchMic,
    toggleCam,
    recoverCamera,
    toggleScreenShare,
    startScreenShare,
    stopScreenShare,
    recoverScreenShare,
    setScreenQuality,
  }
}
