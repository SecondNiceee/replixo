"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { Video } from "lucide-react"
import { StartCallDialog } from "@/components/start-call-dialog"
import { JoinCallDialog } from "@/components/join-call-dialog"
import { NoteTypewriter } from "@/components/note-typewriter"

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
    <section className="pattern-notebook relative flex min-h-screen items-center overflow-hidden bg-background px-6 pb-20 pt-24 sm:pt-28">

      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <p className="sr-only">Для репетиторов и преподавателей</p>

          <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl xl:text-5xl">
            Видеоплатформа для онлайн-уроков с автоматическими конспектами
          </h1>

          <h2 className="mt-6 max-w-xl text-pretty text-base font-normal leading-relaxed text-muted-foreground sm:text-lg">
            Создайте комнату, отправьте ученику код, и он подключится из
            браузера.
          </h2>

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
            className="mt-9 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="font-medium text-foreground underline underline-offset-4">
              Зарегистрируйтесь
            </span>
            , чтобы использовать ИИ-конспект урока для ученика
          </Link>
        </div>

        <NoteTypewriter />
      </div>

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
