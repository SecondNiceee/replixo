'use client'

import { useCallback, useEffect, useRef } from 'react'

/** Предел длины одного сообщения. */
export const MAX_LENGTH = 4000
/**
 * Предел роста поля ввода в строках, а не в пикселях.
 *
 * Раньше пределом было ровное «140px», и в него не влезало целое число строк:
 * при внутренней высоте 138px оставалось 5.9 строки, а прокрутка получала
 * остаток в 2px. Из-за него браузер, доводя каретку до вида, останавливался
 * посреди строки — и верхняя со нижней оказывались срезаны по горизонту.
 * Считая предел от line-height, мы получаем высоту, кратную строке: крайние
 * положения прокрутки совпадают с границами строк.
 */
const MAX_LINES = 6

/**
 * Невидимый двойник поля ввода — им замеряется высота текста, чтобы не трогать
 * настоящее поле (подробнее в resize). Держим вне потока документа и без
 * прокрутки: нужен только его scrollHeight.
 */
function createRuler(): HTMLTextAreaElement {
  const ruler = document.createElement('textarea')
  ruler.setAttribute('aria-hidden', 'true')
  ruler.tabIndex = -1
  ruler.readOnly = true
  Object.assign(ruler.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    // Не display:none и не visibility:hidden: у скрытого элемента нет раскладки,
    // а значит и scrollHeight равен нулю. Убираем его за пределы экрана.
    transform: 'translateX(-200vw)',
    height: '0',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
    // Перенос строк должен совпадать с настоящим полем, иначе замер разойдётся.
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    resize: 'none',
    border: '0',
  })
  document.body.appendChild(ruler)
  return ruler
}

/**
 * Переносит на линейку всё, что влияет на перенос строк и высоту. Ширину и
 * типографику копируем из живого поля, а не задаём константами: они приходят из
 * Tailwind-классов и меняются вместе с размером окна.
 *
 * Рамку линейке не отдаём (в createRuler border: 0) — она не влияет на перенос,
 * а её вклад в высоту учитываем отдельно, в measure.
 */
function syncRulerStyle(ruler: HTMLTextAreaElement, el: HTMLTextAreaElement, cs: CSSStyleDeclaration) {
  // clientWidth — ширина за вычетом рамок и полосы прокрутки, то есть ровно то
  // место, по которому живое поле переносит строки.
  ruler.style.width = `${el.clientWidth}px`
  ruler.style.font = cs.font
  ruler.style.letterSpacing = cs.letterSpacing
  ruler.style.lineHeight = cs.lineHeight
  ruler.style.padding = cs.padding
  // Ширину задали уже без рамок, значит и линейка должна считать её как content-box.
  ruler.style.boxSizing = 'content-box'
}

/**
 * Высота, которую нужно поставить полю, и нужен ли ему скролл.
 *
 * scrollHeight линейки — это высота текста вместе с внутренними отступами, но
 * без рамок. У живого поля box-sizing: border-box, то есть заданная height
 * включает рамки. Если отдать scrollHeight как есть, поле выйдет на сумму рамок
 * (2px) ниже содержимого — и текст будет вечно переполнять его на эти пиксели.
 * Отсюда и брались обрезанные строки. Поэтому рамки прибавляем явно.
 */
function measure(el: HTMLTextAreaElement, ruler: HTMLTextAreaElement) {
  const cs = getComputedStyle(el)
  syncRulerStyle(ruler, el, cs)
  // Замыкающий перенос строки браузер в scrollHeight не считает: без якоря
  // поле на пустой новой строке не подрастало, а прыгало на строку позже.
  ruler.value = `${el.value}\u200b`

  const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  const paddings = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
  // line-height здесь всегда в пикселях: getComputedStyle разрешает и unitless,
  // и normal в конкретное значение.
  const lineHeight = parseFloat(cs.lineHeight)

  const content = ruler.scrollHeight + borders
  const limit = lineHeight * MAX_LINES + paddings + borders

  return { height: Math.min(content, limit), overflows: content > limit }
}

interface ComposerTextareaProps {
  value: string
  /** Только текст: подписки на набор (onTyping) остаются в композере. */
  onChange: (value: string) => void
  /** Enter без Shift; Shift+Enter переносит строку. */
  onSubmit: () => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  disabled: boolean
}

/**
 * Поле ввода сообщения: авторост по содержимому до MAX_LINES строк и отправка по
 * Enter. Вынесено из DmComposer отдельным файлом — вся возня с замером высоты и
 * прокруткой живёт здесь и не мешает читать логику вложений и отправки.
 */
export function ComposerTextarea({
  value,
  onChange,
  onSubmit,
  onPaste,
  disabled,
}: ComposerTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rulerRef = useRef<HTMLTextAreaElement | null>(null)

  // Линейку создаём один раз на компонент и убираем за собой: она живёт в
  // document.body, а не в React-дереве, поэтому сама не удалится.
  useEffect(() => {
    return () => {
      rulerRef.current?.remove()
      rulerRef.current = null
    }
  }, [])

  // Подгонка высоты под содержимое.
  //
  // Замеряем контент на клоне-«линейке», а не на самом поле. Обычный приём —
  // сбросить height в 'auto', прочитать scrollHeight и вернуть высоту — на живом
  // поле даёт побочный эффект: на этот кадр поле разворачивается на весь текст,
  // браузер видит нулевое переполнение и обнуляет scrollTop. Клон измеряется в
  // том же кадре, но он вне потока и невидим, так что ни высота, ни scrollTop
  // настоящего поля при замере не трогаются. Дальше остаётся только задать
  // height — прокруткой целиком распоряжается браузер, который каретку из вида
  // не теряет.
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const { height, overflows } = measure(el, (rulerRef.current ??= createRuler()))

    // Пишем, только если значение реально изменилось: лишняя запись в style
    // заставляет браузер пересчитать раскладку на каждый символ.
    if (el.style.height !== `${height}px`) el.style.height = `${height}px`
    // Скролл включаем вручную и только при реальном переполнении: по CSS браузер
    // рисовал бы полосу и в невыросшем поле, из-за округления высоты строки.
    const overflow = overflows ? 'auto' : 'hidden'
    if (el.style.overflowY !== overflow) el.style.overflowY = overflow
  }, [])

  // Пересчёт после рендера, а не в обработчике ввода: и при наборе, и при
  // очистке после отправки в DOM на момент вызова ещё предыдущее значение.
  // Первый проход на монтировании тоже нужен — он задаёт высоту ровно в одну
  // строку вместо приблизительной из CSS.
  useEffect(() => {
    resize()
  }, [value, resize])

  // Ширина поля входит в замер, поэтому при изменении размеров пересчитываем:
  // после сужения окна тот же текст занимает больше строк.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const observer = new ResizeObserver(() => resize())
    observer.observe(el)
    return () => observer.disconnect()
  }, [resize])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter отправляет, Shift+Enter — перенос строки. Во время набора
      // иероглифов (CJK IME) Enter подтверждает композицию, а не отправляет.
      if (e.key !== 'Enter' || e.shiftKey) return
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      onSubmit()
    },
    [onSubmit],
  )

  return (
    // Внутренние отступы и фон — на обёртке, а не на самом поле.
    //
    // Пока padding был у textarea, Chrome, доводя каретку до вида, отсчитывал
    // прокрутку от самой каретки и нижний отступ в 10px не учитывал: на седьмой
    // строке scrollTop останавливался на 8px вместо 20px, и крайние строки
    // оказывались срезаны по горизонту. Без отступов высота поля кратна строке,
    // прокрутка ходит шагом в строку, и обрезать по половине строки нечего.
    // Текст при этом не заезжает на отступы: он обрезается по краю textarea,
    // а тот лежит внутри обёртки.
    //
    // Фокус обводится ring, а не border: ring рисуется поверх раскладки и в
    // height не входит, тогда как рамка в 1px при box-sizing: border-box
    // отнимала два пикселя у содержимого — поле вечно переполнялось на них.
    //
    // py-2.5 (10px сверху и снизу) вместе со строкой в 20px (leading-5) даёт
    // ровно 40px — высоту кнопок size-10, чтобы скрепка и отправка стояли по
    // центру строки. При росте поля кнопки остаются по центру последней строки.
    <div className="flex-1 rounded-md bg-foreground/5 py-2.5 pl-4 pr-2 transition-colors focus-within:bg-card focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring">
      <textarea
        ref={textareaRef}
        value={value}
        // Высоту здесь не правим: этим занимается resize в эффекте по value.
        // Второй, урезанный пересчёт на месте выставлял высоту, но не трогал
        // overflowY — и после него в невыросшем поле оставалась полоса.
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        rows={1}
        maxLength={MAX_LENGTH}
        placeholder={disabled ? 'Подключение к чату…' : 'Напишите сообщение…'}
        aria-label="Текст сообщения"
        // Потолок роста задан в MAX_LINES и считается от line-height, поэтому
        // max-height в классах нет: ровное значение в пикселях резало бы высоту
        // посреди строки и возвращало обрезанный текст.
        //
        // scroll-hairline: полоса вдвое уже обычной (4px). Общий .scroll-slim в
        // поле высотой в пару строк выглядит непропорционально широким, а совсем
        // без полосы не видно, что текст уехал за верхний край. Гуттер ей даёт
        // pr-2 на обёртке, чтобы полоса не липла к краю.
        className="scroll-hairline block w-full resize-none select-text bg-transparent p-0 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
