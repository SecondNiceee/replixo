"use client"

import { useState, useCallback, useRef } from "react"
import type { Socket } from "socket.io-client"
import { playScreenShareSound, playScreenShareStopSound } from "@/lib/sounds"
import { SCREEN_QUALITY_PRESETS } from "./types"
import type { Transport, Producer, ScreenQuality } from "./types"
import type { Action } from "./reducer"
import { CAMERA_PRODUCE_OPTIONS } from "./types"

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
          audio: selectedMicIdRef.current ? { deviceId: { exact: selectedMicIdRef.current } } : true,
        }
        const micStream = await navigator.mediaDevices.getUserMedia(constraints)
        setPermissionError(null)
        const track = micStream.getAudioTracks()[0]
        stream.addTrack(track)
        dispatch({ type: "TOGGLE_MIC", isMuted: false, hasMic: true })
        const transport = sendTransportRef.current ?? (await waitForSendTransport())
        if (transport && !audioProducerRef.current && track.readyState === "live") {
          const producer = await transport.produce({
            track,
            codecOptions: { opusFec: true, opusDtx: true },
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

  // Switch microphone device mid-call
  const switchMic = useCallback(async (deviceId: string) => {
    selectedMicIdRef.current = deviceId
    const stream = localStreamRef.current
    if (!stream) return
    try {
      const oldTrack = stream.getAudioTracks()[0]
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      })
      const newTrack = micStream.getAudioTracks()[0]
      if (oldTrack) { oldTrack.stop(); stream.removeTrack(oldTrack) }
      stream.addTrack(newTrack)
      const producer = audioProducerRef.current
      const sendTransport = sendTransportRef.current
      if (producer && sendTransport) {
        await producer.replaceTrack({ track: newTrack })
      } else if (!producer && sendTransport) {
        const newProducer = await sendTransport.produce({ track: newTrack })
        audioProducerRef.current = newProducer
        dispatch({ type: "TOGGLE_MIC", isMuted: false, hasMic: true })
      }
    } catch {
      dispatch({ type: "ERROR", error: "Не удалось переключить микрофон" })
    }
  }, [localStreamRef, sendTransportRef, audioProducerRef, selectedMicIdRef, dispatch])

  // ---------------------------------------------------------------------------
  // Camera toggle
  // ---------------------------------------------------------------------------
  const toggleCam = useCallback(async () => {
    const stream = localStreamRef.current
    if (!stream) return
    const existing = stream.getVideoTracks()[0]

    if (!existing) {
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
        audio: true,
      })
      screenStreamRef.current = displayStream

      const videoTrack = displayStream.getVideoTracks()[0]
      const audioTrack = displayStream.getAudioTracks()[0]

      if (videoTrack) {
        if ("contentHint" in videoTrack) videoTrack.contentHint = "detail"
        const encoding: RTCRtpEncodingParameters = preset.maxBitrate
          ? { maxBitrate: preset.maxBitrate, scaleResolutionDownBy: 1, networkPriority: "high", priority: "high" }
          : { maxBitrate: 4_000_000, scaleResolutionDownBy: 1, networkPriority: "high", priority: "high" }

        const producer = await sendTransport.produce({
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

        // Prefer resolution over framerate for screen content
        try {
          const sender = producer.rtpSender
          if (sender) {
            const params = sender.getParameters()
            params.degradationPreference = "maintain-resolution"
            await sender.setParameters(params)
          }
        } catch { /* not all browsers support degradationPreference */ }

        videoTrack.onended = () => stopScreenShare()
      }

      if (audioTrack) {
        const producer = await sendTransport.produce({
          track: audioTrack,
          appData: { source: "screen" },
        })
        screenAudioProducerRef.current = producer

        const replaceScreenAudio = async () => {
          const currentProducer = screenAudioProducerRef.current
          if (!currentProducer || currentProducer.closed || !screenVideoProducerRef.current) return
          try {
            const freshStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })
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
      screenAudioProducerRef, dispatch, stopScreenShare])

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
    toggleMic,
    switchMic,
    toggleCam,
    toggleScreenShare,
    startScreenShare,
    stopScreenShare,
    setScreenQuality,
  }
}
