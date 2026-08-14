import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Текст сообщения с автоматическими ссылками.
//
// Общий компонент для чата комнаты и личных сообщений. Разбираем текст
// собственным регэкспом, а не dangerouslySetInnerHTML: подставлять сюда HTML от
// другого участника нельзя ни при каких условиях, а React экранирует текстовые
// узлы сам.
//
// Что считаем ссылкой:
//   1. явная схема — http(s)://…
//   2. www.… — добавляем https:// при переходе
//   3. домен вида example.com/путь — только для известных TLD-подобных
//      окончаний длиной 2–24 символа, чтобы «файл.pdf» или «версия 1.2» не
//      превращались в ссылки
//   4. e-mail — mailto:
// ---------------------------------------------------------------------------

// Символы, которыми ссылка заканчиваться не может (пробел, угловые скобки,
// кавычки). Держим одной константой, чтобы все три ветки были согласованы.
const NOT_URL = '[^\\s<>"\'`]'

// Список TLD ограничен намеренно: без него «файл.pdf» и «версия 1.2» стали бы
// ссылками. Схема http(s):// работает с любым доменом и без этого списка.
const TLD =
  'com|ru|org|net|io|dev|app|me|co|info|biz|edu|gov|tv|ai|xyz|site|online|store|shop|pro|team|cloud|tech|space|su|by|kz|ua|uk|de|fr|it|es|pl|nl|cn|jp|in|br|ca|au|us|eu'

const URL_SOURCE = [
  // e-mail
  '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*\\.[a-zA-Z]{2,24}',
  // http(s)://…
  `https?:\\/\\/${NOT_URL}+`,
  // www.…
  `www\\.${NOT_URL}+`,
  // «голый» домен: example.com, sub.example.co.uk/path?x=1
  `[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\\.(?:${TLD})(?![a-zA-Z0-9-])(?:[\\/?#]${NOT_URL}*)?`,
].join('|')

// Знаки, которые почти всегда относятся к предложению, а не к ссылке:
// «зайди на example.com.» или «(см. example.com)».
const TRAILING_PUNCT = new Set(['.', ',', '!', '?', ';', ':', '»', ')', ']', '}', "'", '"'])

const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * Отрезать хвостовую пунктуацию, сохранив баланс скобок внутри URL.
 *
 * Режем по одному символу: «…Foo_(bar))» — первая закрывающая скобка часть
 * ссылки (её открыли внутри url), вторая относится к тексту. Групповая обрезка
 * такое различить не смогла бы.
 */
function splitTrailing(raw: string): [string, string] {
  let url = raw
  let tail = ''
  while (url.length > 0) {
    const last = url[url.length - 1]
    if (!TRAILING_PUNCT.has(last)) break
    const opener = CLOSER_TO_OPENER[last]
    if (opener) {
      // Скобка легальна внутри URL, если для неё есть открывающая
      // (ссылки на Википедию: /wiki/Foo_(bar) ).
      const opens = url.split(opener).length - 1
      const closes = url.split(last).length - 1
      if (opens >= closes) break
    }
    url = url.slice(0, -1)
    tail = last + tail
  }
  return [url, tail]
}

function hrefFor(token: string): string {
  if (/^https?:\/\//i.test(token)) return token
  if (token.includes('@') && !token.includes('/')) return `mailto:${token}`
  return `https://${token}`
}

export function MessageText({
  text,
  className,
}: {
  text: string
  /** Классы пузыря: ссылка наследует цвет, поэтому подчёркивание задаём здесь. */
  className?: string
}) {
  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let key = 0

  // lastIndex мутируется, поэтому создаём отдельный экземпляр на каждый вызов —
  // общий регэксп с флагом /g не переиспользуем между рендерами.
  const re = new RegExp(URL_SOURCE, 'gi')
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    const [raw] = match
    const [url, tail] = splitTrailing(raw)
    if (!url) continue

    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    nodes.push(
      <a
        key={`l${key++}`}
        href={hrefFor(url)}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline decoration-current/50 underline-offset-2 transition-colors hover:decoration-current"
      >
        {url}
      </a>,
    )
    if (tail) nodes.push(tail)
    lastIndex = match.index + raw.length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))

  return (
    <span className={cn('select-text whitespace-pre-wrap break-words', className)}>
      {nodes.length > 0 ? nodes : text}
    </span>
  )
}
