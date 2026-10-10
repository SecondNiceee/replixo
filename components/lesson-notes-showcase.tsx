import Link from "next/link"
import { NoteTypewriter } from "@/components/note-typewriter"

const steps = [
  {
    title: "Проведите урок",
    text: "Включите запись в звонке и занимайтесь как обычно: объясняйте, решайте задачи, показывайте экран.",
  },
  {
    title: "ИИ разберёт занятие",
    text: "После урока ИИ выделит темы, правила, разобранные примеры и задания, которые вы дали ученику.",
  },
  {
    title: "Ученик получит конспект",
    text: "Полный конспект урока можно поправить, скачать в PDF или отправить ученику прямо в чат на сайте.",
  },
]

export function LessonNotesShowcase() {
  return (
    <section
      aria-labelledby="lesson-notes-title"
      className="border-t border-border px-6 py-16 sm:py-24"
    >
      <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-4">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              ИИ-конспект урока
            </p>
            <h2
              id="lesson-notes-title"
              className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
            >
              Урок закончился, а конспект уже готов
            </h2>
            <p className="text-pretty text-base leading-relaxed text-muted-foreground">
              Не нужно ничего записывать вручную. Ученик получает аккуратный
              конспект всего занятия и может повторить материал в любой момент.
            </p>
          </div>

          <ol className="flex flex-col border-l border-border">
            {steps.map((step) => (
              <li key={step.title} className="flex flex-col gap-1 py-3 pl-5 first:pt-0 last:pb-0">
                <h3 className="text-base font-medium text-foreground">{step.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>

          <p className="border-t border-border pt-6 text-pretty text-lg text-foreground">
            <span className="font-semibold">10+ конспектов</span>{" "}
            <span className="text-muted-foreground">уроков уже создают каждый день.</span>
          </p>

          <p className="text-sm text-muted-foreground">
            <Link
              href="/examples"
              className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground"
            >
              Примеры конспектов
            </Link>
            {" "}можно посмотреть без аккаунта, свои конспекты доступны после{" "}
            <Link
              href="/sign-up"
              className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground"
            >
              регистрации
            </Link>
            .
          </p>
        </div>

        <NoteTypewriter />
      </div>
    </section>
  )
}
