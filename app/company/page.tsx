import type { Metadata } from "next"
import { FactList, MarketingPage, MarketingSection } from "@/components/marketing/marketing-page"
import { OPERATOR } from "@/lib/legal"

export const metadata: Metadata = {
  title: "О компании — Replixo",
  description: "Replixo — российская видеоплатформа для онлайн-уроков с ИИ-конспектами. Кто мы и как с нами связаться.",
}

const principles = [
  {
    title: "Урок важнее интерфейса",
    text: "Видео, доска и демонстрация экрана должны просто работать. Чем меньше кнопок между учителем и учеником, тем лучше.",
  },
  {
    title: "Работает в России",
    text: "Серверы и нейросети находятся в РФ. Подключение не зависит от VPN и зарубежных сервисов.",
  },
  {
    title: "Без лишних данных",
    text: "Мы не записываем видео звонков и не продаём данные. Храним только то, что нужно для работы сервиса.",
  },
  {
    title: "Делаем вместе с преподавателями",
    text: "Большая часть функций появилась из писем репетиторов. Если чего-то не хватает, напишите нам.",
  },
]

export default function CompanyPage() {
  return (
    <MarketingPage
      eyebrow="Компания"
      title="Мы делаем инструмент, которым удобно вести уроки каждый день"
      lead={
        <p>
          Replixo начинался как замена неудобным видеозвонкам для репетиторов: с ограничением по
          времени, установкой программ и пропадающей связью. Теперь это платформа для онлайн-занятий
          со встроенной доской, чатом и ИИ-конспектами.
        </p>
      }
    >
      <MarketingSection id="mission" title="Чем мы занимаемся">
        <p>
          Мы помогаем репетиторам и преподавателям проводить онлайн-уроки без технических сложностей.
          Ученик подключается по коду из браузера, а после занятия получает конспект, к которому можно
          вернуться в любой момент.
        </p>
        <p>
          Проект развивается небольшой командой. Мы быстро выпускаем обновления и отвечаем на письма
          сами, без колл-центра.
        </p>
      </MarketingSection>

      <MarketingSection id="principles" title="Наши принципы">
        <FactList items={principles} />
      </MarketingSection>

      <MarketingSection id="contacts" title="Реквизиты и контакты">
        <dl className="grid grid-cols-1 gap-x-10 gap-y-5 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Владелец сервиса</dt>
          <dd className="text-foreground">{OPERATOR.fullName}, самозанятый</dd>
          <dt className="text-muted-foreground">ИНН</dt>
          <dd className="font-mono text-foreground">{OPERATOR.inn}</dd>
          <dt className="text-muted-foreground">Почта</dt>
          <dd>
            <a href={`mailto:${OPERATOR.email}`} className="text-foreground underline underline-offset-4 hover:text-primary">
              {OPERATOR.email}
            </a>
          </dd>
        </dl>
        <p className="text-sm">
          По вопросам сотрудничества, работы сервиса и персональных данных пишите на почту, обычно
          отвечаем в течение дня.
        </p>
      </MarketingSection>
    </MarketingPage>
  )
}
