import { headers } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { reportPresenceLeave } from '@/lib/chat/presence'

// ---------------------------------------------------------------------------
// POST /api/chat/presence/leave — «вкладку закрывают».
//
// Зачем отдельный маршрут, если есть событие disconnect: во время выгрузки
// страницы socket.emit доставить нельзя — браузер убивает соединения, не
// дожидаясь отправки. Сокет-сервер узнаёт о разрыве только по своему
// pingTimeout, а это 30 секунд, и всё это время собеседник видит «в сети» у
// человека, который давно ушёл. navigator.sendBeacon, наоборот, при выгрузке
// доставляется надёжно.
//
// Почему beacon идёт в Next, а не сразу на сокет-сервер:
//   • Личность. Сокет-серверу нельзя верить браузеру: с публичным маршрутом
//     одним POST'ом можно было бы «выключить» произвольного пользователя.
//     Здесь личность берётся из сессии, а дальше запрос идёт по внутреннему
//     секрету — то есть от доверенной стороны.
//   • Прокси. Свой origin nginx проксирует всегда (location /), а под /dm/ у
//     него location'а нет: прямой POST на порт 3001 в проде ушёл бы в Next и
//     получил 404.
//
// socketId передаётся в query: он не секрет, а тело у sendBeacon приходит с
// Content-Type: text/plain, и парсить его ради одного поля незачем. Нужен он,
// чтобы снять с учёта именно закрывающуюся вкладку — остальные устройства того
// же пользователя должны остаться в сети.
// ---------------------------------------------------------------------------

/** socket.io генерирует id из base64url-алфавита. */
const SOCKET_ID = /^[A-Za-z0-9_-]{1,64}$/

export async function POST(req: NextRequest) {
  const socketId = req.nextUrl.searchParams.get('socketId') ?? ''
  // Ответ beacon'у никто не читает: страница уже выгружается. Поэтому на любую
  // проблему просто ничего не делаем — но статус отдаём честный, чтобы ошибку
  // было видно в логах, если её начнут искать.
  if (!SOCKET_ID.test(socketId)) {
    return NextResponse.json({ error: 'bad_socket_id' }, { status: 400 })
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await reportPresenceLeave(session.user.id, socketId)

  // 204: ответ пустой и кэшировать его нечего.
  return new NextResponse(null, { status: 204 })
}
