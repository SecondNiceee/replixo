import { Plus } from "lucide-react"

const faqItems = [
  {
    question: "ИИ-конспекты бесплатные?",
    answer:
      "Да, на данный момент конспекты составляются абсолютно бесплатно.",
  },
  {
    question: "Регистрация обязательна?",
    answer:
      "Нет, регистрация не обязательна, но если вы хотите использовать конспекты, вам необходимо зарегистрироваться. Ученику полезно зарегистрироваться, чтобы вы могли слать ему материалы и ИИ-конспекты прямо на сайте (там доступен чат между учениками и преподавателями).",
  },
  {
    question: "Нужно ли устанавливать программу?",
    answer:
      "Нет. Звонок открывается прямо в браузере по ссылке или коду комнаты. Ученику достаточно перейти по ссылке, которую вы отправили.",
  },
  {
    question: "Записывается ли видео урока?",
    answer:
      "Нет. Видео и звук звонка не сохраняются. Для конспекта звук урока передаётся на распознавание только тогда, когда вы сами включили запись.",
  },
  {
    question: "Где обрабатываются данные?",
    answer:
      "Распознавание речи и составление конспекта выполняют сервисы Yandex Cloud, серверы которых находятся в России.",
  },
  {
    question: "Можно ли поправить конспект перед отправкой?",
    answer:
      "Да. Готовый конспект открывается в редакторе: можно изменить текст, добавить свои пометки, затем скачать PDF или отправить ученику в чат.",
  },
]

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqItems.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: { "@type": "Answer", text: item.answer },
  })),
}

export function Faq() {
  return (
    <section
      aria-labelledby="faq-title"
      className="border-t border-border px-6 py-16 sm:py-24"
    >
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-10 lg:grid-cols-[1fr_2fr] lg:gap-16">
        <div className="flex flex-col gap-3">
          <h2
            id="faq-title"
            className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
          >
            Вопросы и ответы
          </h2>
          <p className="text-pretty text-base leading-relaxed text-muted-foreground">
            Не нашли ответ? Напишите нам, адрес есть внизу страницы.
          </p>
        </div>

        <div className="flex flex-col border-t border-border">
          {faqItems.map((item) => (
            <details
              key={item.question}
              className="group border-b border-border"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left text-base font-medium text-foreground transition-colors hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
                {item.question}
                <Plus
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-45"
                  aria-hidden="true"
                />
              </summary>
              <p className="pb-5 pr-10 text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
    </section>
  )
}
