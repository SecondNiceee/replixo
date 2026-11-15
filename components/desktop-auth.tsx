"use client"

import { useState } from "react"
import { AuthForm } from "@/components/auth-form"
import { ReplixoMark } from "@/components/replixo-mark"
import { Button } from "@/components/ui/button"
import type { AuthMode } from "@/stores/auth-dialog-store"

export function DesktopAuth({ initialMode }: { initialMode: AuthMode | null }) {
  const [mode, setMode] = useState(initialMode)

  return (
    <main className="app-dark app-shell-surface h-app overflow-y-auto px-5 py-6 text-foreground">
      <div className="flex min-h-full flex-col items-center justify-center">
        <section aria-labelledby="desktop-auth-heading" className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg sm:p-8">
          <div className="mb-6 flex items-center gap-3">
            <ReplixoMark />
            <h1 id="desktop-auth-heading" className="text-xl font-semibold">Replixo</h1>
          </div>
          {mode ? (
            <>
              <button type="button" onClick={() => setMode(null)} className="mb-4 text-sm text-muted-foreground underline-offset-4 hover:underline">
                Назад
              </button>
              <AuthForm key={mode} mode={mode} onSwitchMode={setMode} />
            </>
          ) : (
            <div className="grid gap-3">
              <Button type="button" size="lg" onClick={() => setMode("sign-up")}>Регистрация</Button>
              <Button type="button" size="lg" variant="outline" onClick={() => setMode("sign-in")}>Вход</Button>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
