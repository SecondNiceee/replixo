"use client"

import { useCallback, useEffect, useRef, useState } from "react"

const TARGET_RATE = 16000
// Синхронное распознавание SpeechKit принимает до 30 сек — берём с запасом.
const CHUNK_SECONDS = 25
const CHUNK_SAMPLES = TARGET_RATE * CHUNK_SECONDS
// Тишину не отправляем, чтобы не платить за пустые минуты.
const SILENCE_RMS = 0.01

export type LessonRecorderStatus = "idle" | "recording" | "summarizing" | "done" | "error"

interface Recorder {
  ctx: AudioContext
  processor: ScriptProcessorNode
  sources: Map<MediaStream, MediaStreamAudioSourceNode>
  buffer: Int16Array
  length: number
  sumSquares: number
  startedAt: number
  chunkStartedAt: number
}

function formatTime(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
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
  const pendingRef = useRef<Promise<void>[]>([])

  const flush = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.length === 0) return
    const samples = rec.buffer.slice(0, rec.length)
    const rms = Math.sqrt(rec.sumSquares / rec.length)
    const at = rec.chunkStartedAt - rec.startedAt
    rec.length = 0
    rec.sumSquares = 0
    rec.chunkStartedAt = performance.now()
    if (rms < SILENCE_RMS || samples.length < TARGET_RATE) return

    const job = fetch("/api/lesson/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: samples.buffer,
    })
      .then((res) => (res.ok ? res.json() : { text: "" }))
      .then(({ text }: { text?: string }) => {
        if (text) transcriptRef.current.push({ at, text })
      })
      .catch(() => {})
    pendingRef.current.push(job)
  }, [])

  // Подключаем/отключаем потоки участников, пока идёт запись.
  useEffect(() => {
    const rec = recorderRef.current
    if (!rec || status !== "recording") return
    const wanted = new Set(streams.filter((s) => s.getAudioTracks().length > 0))
    for (const [stream, node] of rec.sources) {
      if (!wanted.has(stream)) {
        node.disconnect()
        rec.sources.delete(stream)
      }
    }
    for (const stream of wanted) {
      if (rec.sources.has(stream)) continue
      const node = rec.ctx.createMediaStreamSource(stream)
      node.connect(rec.processor)
      rec.sources.set(stream, node)
    }
  }, [streams, status])

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
      sumSquares: 0,
      startedAt: now,
      chunkStartedAt: now,
    }

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const outLength = Math.floor(input.length / ratio)
      for (let i = 0; i < outLength; i++) {
        const from = Math.floor(i * ratio)
        const to = Math.min(input.length, Math.floor((i + 1) * ratio))
        let sum = 0
        for (let j = from; j < to; j++) sum += input[j]
        const sample = Math.max(-1, Math.min(1, sum / Math.max(1, to - from)))
        rec.buffer[rec.length++] = sample * 0x7fff
        rec.sumSquares += sample * sample
        if (rec.length >= CHUNK_SAMPLES) flush()
      }
    }
    // ScriptProcessor срабатывает, только если подключён к выходу. Выходной
    // буфер мы не заполняем, поэтому в динамиках тишина (без эха).
    processor.connect(ctx.destination)

    recorderRef.current = rec
    transcriptRef.current = []
    pendingRef.current = []
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
    await Promise.all(pendingRef.current)

    const transcript = transcriptRef.current
      .sort((a, b) => a.at - b.at)
      .map((part) => `[${formatTime(part.at)}] ${part.text}`)
      .join("\n")

    if (!transcript) {
      setError("Не удалось распознать речь — возможно, на уроке было слишком тихо.")
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
