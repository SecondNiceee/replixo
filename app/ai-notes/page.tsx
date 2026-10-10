import type { Metadata } from "next"
import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"
import { FactList, MarketingPage, MarketingSection } from "@/components/marketing/marketing-page"

export const metadata: Metadata = {
  title: "ИИ-конспекты уроков — Replixo",
  description:
    "Replixo записывает звук урока и с помощью Yandex Cloud составляет полный конспект: темы, правила, примеры и домашнее задание. Сейчас бесплатно.",
}

const pipeline = [
  {
    title: "Запись звука в звонке",
    text: "Вы включаете запись кнопкой в панели урока. Сохраняется только звук, видео и экран не записываются.",
  },
  {
    title: "Распознавание речи",
    text: "Yandex SpeechKit переводит речь в текст. Модель хорошо понимает русский язык, термины и формулы, продиктованные вслух.",
  },
  {
    title: "Разбор урока",
    text: "YandexGPT читает расшифровку целиком, выделяет темы, определения, разобранные задачи и всё, что вы задали ученику.",
  },
  {
    title: "Готовый документ",
    text: "Получается конспект на несколько страниц: его можно поправить, скачать в PDF или отправить ученику в чат.",
  },
]

const reasons = [
  {
    title: "Ученик повторяет материал",
    text: "Через неделю никто не помнит, что было на уроке. С конспектом ученик открывает тему и сразу видит, на чём остановились.",
  },
  {
    title: "Вы не тратите время на записи",
    text: "Не нужно писать итоги после каждого занятия. Конспект составляется сам, вам остаётся только проверить его.",
  },
  {
    title: "Домашнее задание не теряется",
    text: "Всё, что вы задали голосом, попадает в отдельный раздел. Спорить о том, что было задано, больше не придётся.",
  },
  {
    title: "Родители видят прогресс",
    text: "Конспект легко переслать родителям: они видят, какие темы прошли и над чем ребёнок работает сейчас.",
  },
]

export default function AiNotesPage() {
  return (
    <MarketingPage
      eyebrow="ИИ-конспект урока"
      title="Конспект урока составляется сам, пока вы ведёте занятие"
      lead={
        <p>
          Replixo слушает урок, разбирает, о чём шла речь, и собирает из этого понятный документ для
          ученика. Без ручных заметок и без отдельных программ.
        </p>
      }
    >
      <MarketingSection id="how" title="Как это работает">
        <p>
          Мы используем нейросети Yandex Cloud. Серверы находятся в России, поэтому всё работает без
          VPN, а данные урока не уходят за границу. ИИ распознаёт звук занятия и по расшифровке
          строит анализ урока.
        </p>
        <ol className="flex flex-col">
          {pipeline.map((step, i) => (
            <li key={step.title} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 border-t border-border py-5">
              <span className="font-mono text-sm text-muted-foreground">{i + 1}</span>
              <div className="flex flex-col gap-1">
                <h3 className="font-medium text-foreground">{step.title}</h3>
                <p className="text-sm leading-relaxed">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-sm">
          Аудио нужно только на время обработки. Запись звонка и видео мы не храним, сохраняется
          лишь готовый текст конспекта.
        </p>
      </MarketingSection>

      <MarketingSection id="why" title="Почему это удобно">
        <FactList items={reasons} />
      </MarketingSection>

      <MarketingSection id="free" title="Почему это бесплатно">
        <p>
          В ближайшие месяцы идёт бета-тестирование. Мы собираем отзывы преподавателей и дорабатываем
          качество конспектов, поэтому сейчас функция полностью бесплатна и без ограничений по
          количеству уроков.
        </p>
        <p>
          Если условия изменятся, мы заранее предупредим вас по почте и в уведомлениях на сайте.
          Уже созданные конспекты останутся у вас.
        </p>
        <div className="flex flex-col gap-3 pt-2 sm:flex-row">
          <Link href="/sign-up" className={buttonVariants({ size: "lg", className: "h-11 rounded-md px-5" })}>
            Зарегистрироваться
          </Link>
          <Link
            href="/examples"
            className={buttonVariants({ size: "lg", variant: "outline", className: "h-11 rounded-md px-5" })}
          >
            Посмотреть примеры
          </Link>
        </div>
      </MarketingSection>
    </MarketingPage>
  )
}
