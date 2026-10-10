"use client"

import { useCallback, useEffect, useRef, useState } from "react"

const TARGET_RATE = 16000
// Синхронное распознавание SpeechKit принимает до 30 сек — берём с запасом.
const CHUNK_SECONDS = 25
const CHUNK_SAMPLES = TARGET_RATE * CHUNK_SECONDS
// Речь определяем по коротким окнам (100 мс), а не по среднему за весь кусок:
// иначе тихий голос с паузами «размазывается» и весь кусок считается тишиной.
const FRAME_SAMPLES = TARGET_RATE / 10
const VOICE_FRAME_RMS = 0.006
// Кусок отправляем, если в нём набралось хотя бы ~1 сек речи.
const MIN_VOICED_FRAMES = 10
const TRANSCRIBE_ATTEMPTS = 3
const WATCHDOG_MS = 5000
const TRACK_RESYNC_MS = 2000

export type LessonRecorderStatus = "idle" | "recording" | "summarizing" | "done" | "error"

interface Recorder {
  ctx: AudioContext
  processor: ScriptProcessorNode
  sources: Map<string, MediaStreamAudioSourceNode>
  buffer: Int16Array
  length: number
  frameSumSquares: number
  frameLength: number
  voicedFrames: number
  startedAt: number
  chunkStartedAt: number
  lastAudioAt: number
}

interface Stats {
  sent: number
  recognized: number
  failed: number
  skippedSilent: number
}

function formatTime(ms: number) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0")
  const ss = String(s % 60).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function transcribeChunk(samples: Int16Array): Promise<string> {
  let lastError: Error = new Error("Ошибка распознавания речи")
  for (let attempt = 0; attempt < TRANSCRIBE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/lesson/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: samples.buffer as ArrayBuffer,
      })
      if (res.status === 401) throw Object.assign(new Error("Войдите в аккаунт, чтобы записывать конспект урока."), { fatal: true })
      if (res.status === 403) throw Object.assign(new Error("Конспект доступен только преподавателям."), { fatal: true })
      if (res.ok) {
        const { text } = (await res.json()) as { text?: string }
        return text ?? ""
      }
      lastError = new Error(`Ошибка распознавания речи (${res.status}). Проверьте логи сервера.`)
    } catch (e) {
      if (e instanceof Error && "fatal" in e) throw e
      lastError = e instanceof Error ? e : lastError
    }
    if (attempt < TRANSCRIBE_ATTEMPTS - 1) await sleep(1000 * 2 ** attempt)
  }
  throw lastError
}

/**
 * Записывает общий звук урока (свой микрофон + все участники), режет на куски
 * по 25 сек, отправляет каждый в SpeechKit, а по окончании просит LLM составить
 * конспект по накопленной расшифровке.
 */
export function useLessonRecorder(streams: MediaStream[]) {
  const [status, setStatus] = useState<LessonRecorderStatus>("idle")
  const [summary, setSummary] = useState("")
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<Recorder | null>(null)
  const transcriptRef = useRef<{ at: number; text: string }[]>([])
  // Куски распознаём по очереди: на часовом уроке параллельные запросы упираются в лимиты SpeechKit.
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const transcribeErrorRef = useRef<string | null>(null)
  const statsRef = useRef<Stats>({ sent: 0, recognized: 0, failed: 0, skippedSilent: 0 })

  const flush = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.length === 0) return
    const samples = rec.buffer.slice(0, rec.length)
    const voiced = rec.voicedFrames
    const at = rec.chunkStartedAt - rec.startedAt
    rec.length = 0
    rec.frameSumSquares = 0
    rec.frameLength = 0
    rec.voicedFrames = 0
    rec.chunkStartedAt = performance.now()
    if (voiced < MIN_VOICED_FRAMES || samples.length < TARGET_RATE) {
      statsRef.current.skippedSilent++
      return
    }

    statsRef.current.sent++
    queueRef.current = queueRef.current.then(async () => {
      try {
        const text = (await transcribeChunk(samples)).trim()
        if (text) {
          transcriptRef.current.push({ at, text })
          statsRef.current.recognized++
        }
      } catch (e) {
        statsRef.current.failed++
        transcribeErrorRef.current = e instanceof Error ? e.message : "Ошибка распознавания речи"
      }
    })
  }, [])

  // Подключаем/отключаем аудиодорожки участников, пока идёт запись. Ключ — id
  // дорожки: при переподключении WebRTC дорожка внутри потока может смениться.
  // Звонок меняет дорожку микрофона внутри того же MediaStream (removeTrack/addTrack)
  // при восстановлении связи, смене устройства или запуске демонстрации экрана —
  // id потока не меняется, поэтому дополнительно слушаем события и периодически сверяемся.
  useEffect(() => {
    if (status !== "recording") return
    const sync = () => {
      const rec = recorderRef.current
      if (!rec) return
      const wanted = new Map<string, MediaStreamTrack>()
      for (const stream of streams) {
        for (const track of stream.getAudioTracks()) {
          if (track.readyState === "live") wanted.set(track.id, track)
        }
      }
      for (const [id, node] of rec.sources) {
        if (!wanted.has(id)) {
          node.disconnect()
          rec.sources.delete(id)
        }
      }
      for (const [id, track] of wanted) {
        if (rec.sources.has(id)) continue
        const node = rec.ctx.createMediaStreamSource(new MediaStream([track]))
        node.connect(rec.processor)
        rec.sources.set(id, node)
      }
    }
    sync()
    for (const stream of streams) {
      stream.addEventListener("addtrack", sync)
      stream.addEventListener("removetrack", sync)
    }
    const timer = window.setInterval(sync, TRACK_RESYNC_MS)
    return () => {
      window.clearInterval(timer)
      for (const stream of streams) {
        stream.removeEventListener("addtrack", sync)
        stream.removeEventListener("removetrack", sync)
      }
    }
  }, [streams, status])

  // Браузер может приостановить AudioContext (сон, блокировка экрана, смена
  // наушников, фоновая вкладка) — тогда звук перестаёт записываться молча.
  useEffect(() => {
    if (status !== "recording") return
    const revive = () => {
      const rec = recorderRef.current
      if (rec && rec.ctx.state !== "running" && rec.ctx.state !== "closed") {
        void rec.ctx.resume().catch(() => {})
      }
    }
    const timer = window.setInterval(revive, WATCHDOG_MS)
    document.addEventListener("visibilitychange", revive)
    recorderRef.current?.ctx.addEventListener("statechange", revive)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", revive)
      recorderRef.current?.ctx.removeEventListener("statechange", revive)
    }
  }, [status])

  const start = useCallback(async () => {
    if (recorderRef.current) return
    const ctx = new AudioContext()
    await ctx.resume()
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    const ratio = ctx.sampleRate / TARGET_RATE
    const now = performance.now()
    const rec: Recorder = {
      ctx,
      processor,
      sources: new Map(),
      buffer: new Int16Array(CHUNK_SAMPLES),
      length: 0,
      frameSumSquares: 0,
      frameLength: 0,
      voicedFrames: 0,
      startedAt: now,
      chunkStartedAt: now,
      lastAudioAt: now,
    }

    processor.onaudioprocess = (event) => {
      rec.lastAudioAt = performance.now()
      const input = event.inputBuffer.getChannelData(0)
      const outLength = Math.floor(input.length / ratio)
      for (let i = 0; i < outLength; i++) {
        const from = Math.floor(i * ratio)
        const to = Math.min(input.length, Math.floor((i + 1) * ratio))
        let sum = 0
        for (let j = from; j < to; j++) sum += input[j]
        const sample = Math.max(-1, Math.min(1, sum / Math.max(1, to - from)))
        rec.buffer[rec.length++] = sample * 0x7fff
        rec.frameSumSquares += sample * sample
        if (++rec.frameLength >= FRAME_SAMPLES) {
          if (Math.sqrt(rec.frameSumSquares / rec.frameLength) >= VOICE_FRAME_RMS) rec.voicedFrames++
          rec.frameSumSquares = 0
          rec.frameLength = 0
        }
        if (rec.length >= CHUNK_SAMPLES) flush()
      }
    }
    // ScriptProcessor срабатывает, только если подключён к выходу. Выходной
    // буфер мы не заполняем, поэтому в динамиках тишина (без эха).
    processor.connect(ctx.destination)

    recorderRef.current = rec
    transcriptRef.current = []
    queueRef.current = Promise.resolve()
    transcribeErrorRef.current = null
    statsRef.current = { sent: 0, recognized: 0, failed: 0, skippedSilent: 0 }
    setSummary("")
    setError(null)
    setStatus("recording")
  }, [flush])

  const stop = useCallback(async () => {
    const rec = recorderRef.current
    if (!rec) return
    flush()
    rec.processor.onaudioprocess = null
    rec.sources.forEach((node) => node.disconnect())
    rec.processor.disconnect()
    void rec.ctx.close()
    recorderRef.current = null

    setStatus("summarizing")
    await queueRef.current

    const transcript = transcriptRef.current
      .sort((a, b) => a.at - b.at)
      .map((part) => `[${formatTime(part.at)}] ${part.text}`)
      .join("\n")

    if (!transcript) {
      const stats = statsRef.current
      console.warn("[lesson-recorder] пустая расшифровка", stats)
      let message = "Не удалось распознать речь — возможно, на уроке было слишком тихо."
      if (stats.failed > 0 && transcribeErrorRef.current) {
        message = transcribeErrorRef.current
      } else if (stats.sent === 0 && stats.skippedSilent === 0) {
        message = "Звук не записывался — браузер приостановил запись. Попробуйте ещё раз и не сворачивайте окно надолго."
      } else if (stats.sent > 0) {
        message = "Речь записана, но SpeechKit не вернул текст. Проверьте логи сервера."
      }
      setError(message)
      setStatus("error")
      return
    }

    try {
      const res = await fetch("/api/lesson/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      })
      const data = (await res.json()) as { summary?: string; error?: string }
      if (!res.ok || !data.summary) throw new Error(data.error || "Не удалось составить конспект")
      setSummary(data.summary)
      setStatus("done")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось составить конспект")
      setStatus("error")
    }
  }, [flush])

  useEffect(
    () => () => {
      const rec = recorderRef.current
      if (!rec) return
      rec.processor.onaudioprocess = null
      void rec.ctx.close()
      recorderRef.current = null
    },
    [],
  )

  return { status, summary, error, start, stop }
}
