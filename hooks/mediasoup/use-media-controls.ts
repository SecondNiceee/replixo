"use client"

import { useState, useCallback, useRef } from "react"
import type { Socket } from "socket.io-client"
import { playScreenShareSound, playScreenShareStopSound } from "@/lib/sounds"
import { getVoiceAudioConstraints } from "@/lib/media-constraints"
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
  dispatch,
}: UseMediaControlsParams) {
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [screenQuality, setScreenQualityState] = useState<ScreenQuality>("auto")
  // True while the camera is being turned on (getUserMedia + publish can take a
  // few seconds). The UI shows a loader on the camera button during this window.
  const [isCamStarting, setIsCamStarting] = useState(false)
  const [activeMicId, setActiveMicId] = useState<string | null>(null)
  const [isMicSwitching, setIsMicSwitching] = useState(false)
  const screenRecoveryInFlightRef = useRef(false)
  const camRecoveryInFlightRef = useRef(false)
  // Indirection so the camera track's "ended" watcher can call recovery even
  // though recoverCamera is declared further down.
  const recoverCameraRef = useRef<() => Promise<boolean>>(async () => false)
  const screenCaptureCleanupRef = useRef<(() => void) | null>(null)

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
      try {
        const constraints: MediaStreamConstraints = {
          audio: getVoiceAudioConstraints(selectedMicIdRef.current),
        }
        const micStream = await navigator.mediaDevices.getUserMedia(constraints)
        setPermissionError(null)
        const track = micStream.getAudioTracks()[0]
        stream.addTrack(track)
        const actualDeviceId = track.getSettings().deviceId ?? selectedMicIdRef.current ?? null
        selectedMicIdRef.current = actualDeviceId ?? undefined
        setActiveMicId(actualDeviceId)
        dispatch({ type: "TOGGLE_MIC", isMuted: false, hasMic: true })
        const transport = sendTransportRef.current ?? (await waitForSendTransport())
        if (transport && !audioProducerRef.current && track.readyState === "live") {
          const producer = await transport.produce({
            track,
            codecOptions: { opusFec: true, opusDtx: true, opusMaxAverageBitrate: 64_000 },
          })
          audioProducerRef.current = producer
        }
      } catch (err) {
        const name = (err as { name?: string })?.name
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setPermissionError("mic")
        } else {
          dispatch({ type: "ERROR", error: "Нет доступа к микрофону" })
        }
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
      selectedMicIdRef, dispatch, waitForSendTransport])

  // Switch microphone device mid-call. The old track stays live until mediasoup
  // has accepted the replacement, so a failed device never breaks working audio.
  const switchMic = useCallback(async (deviceId: string): Promise<boolean> => {
    const stream = localStreamRef.current
    if (!stream || isMicSwitching) return false

    setIsMicSwitching(true)
    let micStream: MediaStream | null = null
    try {
      const oldTrack = stream.getAudioTracks()[0]
      const wasEnabled = oldTrack?.enabled ?? true
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: getVoiceAudioConstraints(deviceId),
      })
      const newTrack = micStream.getAudioTracks()[0]
      if (!newTrack || newTrack.readyState !== "live") throw new Error("Microphone track is not live")

      newTrack.enabled = wasEnabled
      const producer = audioProducerRef.current
      const sendTransport = sendTransportRef.current
      if (producer) {
        await producer.replaceTrack({ track: newTrack })
      } else if (sendTransport) {
        const newProducer = await sendTransport.produce({
          track: newTrack,
          codecOptions: { opusFec: true, opusDtx: true, opusMaxAverageBitrate: 64_000 },
        })
        audioProducerRef.current = newProducer
        if (!wasEnabled) await newProducer.pause()
      }

      if (oldTrack) {
        stream.removeTrack(oldTrack)
        oldTrack.stop()
      }
      stream.addTrack(newTrack)

      const actualDeviceId = newTrack.getSettings().deviceId ?? deviceId
      selectedMicIdRef.current = actualDeviceId
      setActiveMicId(actualDeviceId)
      dispatch({ type: "TOGGLE_MIC", isMuted: !wasEnabled, hasMic: true })
      return true
    } catch {
      micStream?.getTracks().forEach((track) => track.stop())
      dispatch({ type: "ERROR", error: "Не удалось переключить микрофон" })
      return false
    } finally {
      setIsMicSwitching(false)
    }
  }, [localStreamRef, sendTransportRef, audioProducerRef, selectedMicIdRef, dispatch, isMicSwitching])

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
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true })
        setPermissionError(null)
        const track = camStream.getVideoTracks()[0]
        stream.addTrack(track)
        watchCameraTrack(track)
        dispatch({ type: "TOGGLE_CAM", isOff: false, hasCam: true })
        const transport = sendTransportRef.current ?? (await waitForSendTransport())
        if (transport && !videoProducerRef.current && track.readyState === "live") {
          const producer = await transport.produce({ track, ...CAMERA_PRODUCE_OPTIONS })
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
      dispatch, waitForSendTransport, watchCameraTrack])

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
    if (!trackDead && !producerDead && producer.transport === sendTransportRef.current) return false
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

      const nextProducer = await transport.produce({ track, ...CAMERA_PRODUCE_OPTIONS })
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
      })
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
      screenAudioProducerRef.current = await transport.produce({
        track: audioTrack,
        codecOptions: {
          opusStereo: true,
          opusDtx: false,
          opusFec: true,
          opusMaxPlaybackRate: 48_000,
          opusMaxAverageBitrate: 192_000,
        },
        appData: { source: "screen" },
      })
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
      stopScreenShare({ silent: true })
      return false
    }

    screenRecoveryInFlightRef.current = true
    try {
      const transport = await waitForSendTransport()
      if (!transport || transport.closed) return false

      const currentVideo = screenVideoProducerRef.current
      const currentAudio = screenAudioProducerRef.current
      if (currentVideo && (currentVideo.closed || currentVideo.transport !== transport)) {
        currentVideo.close()
        screenVideoProducerRef.current = null
      }
      if (currentAudio && (currentAudio.closed || currentAudio.transport !== transport)) {
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
      publishCapturedScreen, dispatch, waitForSendTransport, stopScreenShare])

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
