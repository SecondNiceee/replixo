"use client"

import { useEffect, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { CallSessionRow } from "@/app/api/adminuw102/route"
import { CallStats } from "./call-stats"

const SECRET = "SecondNiceee"

export function AdminGate() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sessions, setSessions] = useState<CallSessionRow[] | null>(null)

  useEffect(() => {
    if (sessions) return
    let typed = ""
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
      typed = (typed + e.key).slice(-SECRET.length)
      if (typed === SECRET) {
        typed = ""
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [sessions])

  async function load(pass: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/adminuw102", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({ password: pass }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? "Ошибка")
        return false
      }
      setSessions(data.sessions ?? [])
      return true
    } catch {
      setError("Сеть недоступна")
      return false
    } finally {
      setLoading(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (await load(password)) setOpen(false)
  }

  if (sessions) {
    return (
      <CallStats
        sessions={sessions}
        refreshing={loading}
        onRefresh={() => void load(password)}
      />
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Вход</DialogTitle>
          <DialogDescription>Введите пароль администратора.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            aria-label="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={loading || !password}>
            {loading ? "Проверка…" : "Открыть"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
