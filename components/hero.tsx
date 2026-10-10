"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { Video } from "lucide-react"
import { StartCallDialog } from "@/components/start-call-dialog"
import { JoinCallDialog } from "@/components/join-call-dialog"

export function Hero() {
  const [startOpen, setStartOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)

  function handleStart(roomCode: string) {
    window.location.href = `/room/${roomCode}?create=true`
  }

  function handleJoin(roomCode: string) {
    window.location.href = `/room/${roomCode}`
  }

  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 text-center">
      {/* базовая светлая подложка */}
      <div
        aria-hidden="true"
        className="hero-surface pointer-events-none absolute inset-0 -z-30"
      />
      {/* крупная сетка */}
      <div
        aria-hidden="true"
        className="hero-grid pointer-events-none absolute inset-0 -z-20"
      />
      {/* виньетка и переход к следующей секции */}
      <div
        aria-hidden="true"
        className="hero-vignette pointer-events-none absolute inset-0 -z-10"
      />

      <p className="sr-only">
        Для репетиторов и преподавателей
      </p>

      <h1 className="max-w-5xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl">
        Видеоплатформа для онлайн-уроков
      </h1>

      <p className="mt-6 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
        Занятия без ограничения по времени и без установки программ. Создайте
        комнату, отправьте ученику код, и он подключится из браузера.
      </p>

      <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
        <Button
          size="lg"
          className="h-12 gap-2 rounded-md px-6 text-base font-medium"
          onClick={() => setStartOpen(true)}
        >
          <Video className="size-5" aria-hidden="true" />
          Начать урок
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-12 rounded-md px-6 text-base"
          onClick={() => setJoinOpen(true)}
        >
          Войти по коду урока
        </Button>
      </div>

      <Link
        href="/sign-up"
        className="mt-6 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="font-medium text-foreground underline underline-offset-4">
          Зарегистрируйтесь
        </span>
        , чтобы использовать ИИ-конспект урока для ученика
      </Link>

      <p className="mt-3 text-sm text-muted-foreground">
        Уже создаётся{" "}
        <span className="font-semibold tabular-nums text-foreground">10+</span>{" "}
        конспектов каждый день
      </p>

      <StartCallDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        onStart={handleStart}
      />
      <JoinCallDialog
        open={joinOpen}
        onOpenChange={setJoinOpen}
        onJoin={handleJoin}
      />
    </section>
  )
}
