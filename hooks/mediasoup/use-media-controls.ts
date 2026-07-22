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
      dispatch, waitForSendTransport])

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

  const recoverScreenShare = useCallback(async () => {
    if (screenRecoveryInFlightRef.current) return false
    const transport = sendTransportRef.current
    const stream = screenStreamRef.current
    const videoTrack = stream?.getVideoTracks()[0]
    if (!transport || transport.closed || !stream || !videoTrack || videoTrack.readyState !== "live") {
      return false
    }

    screenRecoveryInFlightRef.current = true
    try {
      if (screenVideoProducerRef.current?.closed) screenVideoProducerRef.current = null
      if (screenAudioProducerRef.current?.closed) screenAudioProducerRef.current = null
      await publishCapturedScreen(transport, stream)
      dispatch({ type: "SET_SCREEN_SHARING", isSharing: true })
      return !!screenVideoProducerRef.current
    } catch {
      return false
    } finally {
      screenRecoveryInFlightRef.current = false
    }
  }, [sendTransportRef, screenStreamRef, screenVideoProducerRef, publishCapturedScreen, dispatch])

  const stopScreenShare = useCallback((options?: { silent?: boolean }) => {
    const wasSharing = !!screenVideoProducerRef.current
    for (const producer of [screenVideoProducerRef.current, screenAudioProducerRef.current]) {
      if (!producer) continue
      socketRef.current?.emit("closeProducer", {
        roomId, peerId: peerIdRef.current, producerId: producer.id,
      })
      producer.close()
    }
    screenVideoProducerRef.current = null
    screenAudioProducerRef.current = null
    screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    screenStreamRef.current = null
    dispatch({ type: "SET_SCREEN_SHARING", isSharing: false })
    if (wasSharing && !options?.silent) playScreenShareStopSound()
  }, [roomId, peerIdRef, socketRef, screenVideoProducerRef, screenAudioProducerRef,
      screenStreamRef, dispatch])

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

      if (videoTrack) {
        videoTrack.onended = () => stopScreenShare()
      }

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

        if (videoTrack) {
          const prevOnEnded = videoTrack.onended
          videoTrack.onended = () => {
            navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
            if (typeof prevOnEnded === "function") prevOnEnded.call(videoTrack, new Event("ended"))
            else stopScreenShare()
          }
        }
      }

      dispatch({ type: "SET_SCREEN_SHARING", isSharing: true })
      if (!options?.silent) playScreenShareSound()
    } catch { /* user cancelled or permission denied */ }
  }, [sendTransportRef, screenQualityRef, screenStreamRef, screenVideoProducerRef,
      screenAudioProducerRef, dispatch, stopScreenShare, publishCapturedScreen])

  const toggleScreenShare = useCallback(async () => {
    if (screenVideoProducerRef.current) stopScreenShare()
    else await startScreenShare()
  }, [screenVideoProducerRef, startScreenShare, stopScreenShare])

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
    toggleScreenShare,
    startScreenShare,
    stopScreenShare,
    recoverScreenShare,
    setScreenQuality,
  }
}
