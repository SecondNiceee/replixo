'use client'

import { useCallback, useEffect, useRef } from 'react'

/** Предел длины одного сообщения. */
export const MAX_LENGTH = 4000
/** Предел роста поля ввода: дальше появляется собственный скролл. */
const MAX_HEIGHT = 140

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
 */
function syncRulerStyle(ruler: HTMLTextAreaElement, el: HTMLTextAreaElement) {
  const cs = getComputedStyle(el)
  ruler.style.width = `${el.clientWidth}px`
  ruler.style.font = cs.font
  ruler.style.letterSpacing = cs.letterSpacing
  ruler.style.lineHeight = cs.lineHeight
  ruler.style.padding = cs.padding
  // box-sizing влияет на то, входят ли отступы в заданную ширину.
  ruler.style.boxSizing = cs.boxSizing
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
 * Поле ввода сообщения: авторост по содержимому до MAX_HEIGHT и отправка по
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
  // Здесь же решается, нужен ли textarea скролл. Полагаться на CSS нельзя: у
  // поля своя высота в одну строку, а по внутренним отступам и line-height
  // содержимое одной строки её чуть перерастает — браузер видел переполнение и
  // рисовал полосу прокрутки в пустом поле. Поэтому скролл включаем вручную и
  // только когда контент реально не влез в предел роста.
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // Замеряем контент на клоне-«линейке», а не на самом поле.
    //
    // Обычный приём — сбросить height в 'auto', прочитать scrollHeight и вернуть
    // высоту — на живом поле даёт двойной side effect: на этот кадр поле
    // разворачивается на весь текст, браузер видит нулевое переполнение и
    // обнуляет scrollTop. Отсюда и «танцы»: значение приходилось восстанавливать
    // вручную, а любая ручная правка scrollTop спорит с собственным доводом
    // каретки, который браузер делает сразу после ввода. Визуально это и есть
    // «уехало вниз, через миг вернулось».
    //
    // Клон измеряется в том же кадре, но он вне потока и невидим, так что ни
    // высота, ни scrollTop настоящего поля при замере не трогаются вообще.
    // Дальше остаётся только задать height — прокруткой целиком распоряжается
    // браузер, который каретку из вида не теряет.
    const ruler = (rulerRef.current ??= createRuler())
    syncRulerStyle(ruler, el)
    // Замыкающий перенос строки браузер в scrollHeight не считает: без якоря
    // поле на пустой новой строке не подрастало, а прыгало на строку позже.
    ruler.value = `${el.value}\u200b`
    const full = ruler.scrollHeight

    const next = Math.min(full, MAX_HEIGHT)
    // Пишем, только если высота реально изменилась: лишняя запись в style
    // заставляет браузер пересчитать раскладку на каждый символ.
    if (el.style.height !== `${next}px`) el.style.height = `${next}px`
    // Скролл включаем вручную и только при реальном переполнении: у поля своя
    // высота в одну строку, и по отступам с line-height содержимое одной строки
    // её чуть перерастает — по CSS браузер рисовал бы полосу в пустом поле.
    const overflow = full > MAX_HEIGHT ? 'auto' : 'hidden'
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
      // leading-5, а не leading-relaxed: строка в 20px вместе с py-2.5
      // (10px сверху и снизу) даёт ровно 40px — высоту кнопок size-10. При
      // 1.625 поле в одну строку было почти на 3px выше кнопок, и так как
      // form выравнивает по нижнему краю, скрепка оказывалась выше центра
      // строки. Теперь одна строка совпадает с кнопкой по высоте, а при
      // росте поля кнопки остаются по центру последней строки.
      // scroll-hairline: полоса вдвое уже обычной (4px). Общий .scroll-slim в
      // поле высотой в пару строк выглядит непропорционально широким, а совсем
      // без полосы не видно, что текст уехал за верхний край. Правый отступ
      // (pr-3 против pl-4) отдан под гуттер, чтобы полоса не липла к тексту.
      className="scroll-hairline max-h-[140px] min-h-10 flex-1 resize-none select-text rounded-md border border-transparent bg-foreground/5 py-2.5 pl-4 pr-3 text-sm leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-card"
    />
  )
}
