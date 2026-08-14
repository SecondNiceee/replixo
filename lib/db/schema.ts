import { pgTable, text, timestamp, boolean, unique, index, real, primaryKey, integer, jsonb } from 'drizzle-orm/pg-core'

// --- Better Auth required tables -------------------------------------------
// Column names are camelCase to match Better Auth's defaults. Do not rename.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  username: text('username').unique(),
  displayUsername: text('displayUsername'),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  // Когда пользователя видели последний раз. Пишет только сокет-сервер (см.
  // server/src/dm/presence.ts): периодически, пока соединение живо, и в момент
  // разрыва. NULL — пользователь ни разу не подключался после добавления
  // колонки; UI тогда показывает просто «не в сети», без времени.
  //
  // Колонка добавлена нами и в схеме Better Auth не числится, но лежит в его
  // таблице. Переименовывать нельзя: на неё смотрит SQL сокет-сервера, который
  // работает с таблицами напрямую, без drizzle.
  lastSeenAt: timestamp('lastSeenAt'),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow(),
  updatedAt: timestamp('updatedAt').defaultNow(),
})

// --- Friends system --------------------------------------------------------

export const friendship = pgTable(
  'friendship',
  {
    id: text('id').primaryKey(),
    requesterId: text('requesterId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    addresseeId: text('addresseeId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // 'pending' | 'accepted' | 'declined'
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  },
  (t) => [unique().on(t.requesterId, t.addresseeId)],
)

// --- Уведомления -----------------------------------------------------------
// Постоянные уведомления пользователя. До этой таблицы события дружбы жили
// только в тосте: пользователь, который был офлайн (или просто перезагрузил
// страницу), про принятие/отклонение заявки не узнавал никогда — заявки видно
// в списках, а `accepted`/`declined` не оставляли следа.
//
// Теперь запись создаёт тот же Next-роут, что меняет дружбу, а сокет-сервер
// только пушит уже сохранённое. Поэтому уведомление не теряется, даже если
// сокет-сервер лежит.
//
// userId — ПОЛУЧАТЕЛЬ, actorId — тот, кто вызвал событие. Имя актора здесь не
// денормализуем: читаем джойном, чтобы переименование пользователя не оставляло
// в центре уведомлений устаревшую подпись.

export const notification = pgTable(
  'notification',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // 'friend-request' | 'friend-accepted' | 'friend-declined'
    kind: text('kind').notNull(),
    actorId: text('actorId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // null — не прочитано. Время, а не boolean: дешевле отлаживать и позже
    // позволит «прочитано до момента X».
    readAt: timestamp('readAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    // Центр уведомлений — это всегда «мои, свежие сверху».
    index('notification_user_createdAt_idx').on(t.userId, t.createdAt),
    // Одно живое уведомление на (получатель, актор, вид): повторная заявка от
    // того же человека обновляет запись, а не копит стопку. Это ровно та же
    // семантика, что у dedupeKey у тостов.
    unique('notification_user_actor_kind_uq').on(t.userId, t.actorId, t.kind),
  ],
)

// --- Личные чаты (ЛС между друзьями) ---------------------------------------
// В отличие от чата комнаты (эфемерный, идентичность — peerId), здесь
// идентичность — зарегистрированный user.id, а история постоянна.
// Префикс dm_ в именах таблиц, чтобы не путать с `message` / `message_read`.

// Диалог. type заложен на будущее: 'direct' (1:1) | 'group'.
// Для 'direct' id детерминированный: `direct:<minUserId>:<maxUserId>` —
// это гарантирует уникальность пары без отдельного unique-индекса.
export const conversation = pgTable(
  'dm_conversation',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull().default('direct'),
    // Денормализованный указатель на последнее сообщение: список диалогов
    // строится одним запросом без коррелированных подзапросов.
    lastMessageId: text('lastMessageId'),
    lastMessageAt: timestamp('lastMessageAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  // Список диалогов всегда отдаётся отсортированным по свежести. Без этого
  // индекса планировщик добавляет отдельный шаг сортировки на каждый запрос.
  (t) => [index('dm_conversation_lastMessageAt_idx').on(t.lastMessageAt)],
)

// Участник диалога + его личное состояние прочитанности.
export const conversationMember = pgTable(
  'dm_conversation_member',
  {
    conversationId: text('conversationId')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // До какого момента пользователь прочитал диалог.
    lastReadAt: timestamp('lastReadAt').notNull().defaultNow(),
    // Кэш непрочитанных: инкремент при доставке, сброс при отметке прочтения.
    unreadCount: integer('unreadCount').notNull().default(0),
    joinedAt: timestamp('joinedAt').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('dm_member_userId_idx').on(t.userId),
  ],
)

export const directMessage = pgTable(
  'dm_message',
  {
    // id генерирует отправитель — оптимистичная копия и запись в БД
    // разделяют один id, поэтому повторная отправка идемпотентна.
    id: text('id').primaryKey(),
    conversationId: text('conversationId')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    senderId: text('senderId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    text: text('text').notNull().default(''),
    // Вложение: { url, name, size, mime } | null (заполняется на шаге вложений).
    attachment: jsonb('attachment'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    editedAt: timestamp('editedAt'),
    deletedAt: timestamp('deletedAt'),
  },
  (t) => [index('dm_message_conv_createdAt_idx').on(t.conversationId, t.createdAt)],
)

// --- Room chat -------------------------------------------------------------
// Эфемерный чат конференции. Сообщения пишутся mediasoup-сервером и
// удаляются целиком, когда комната уничтожается (становится пустой).
// peerId/displayName — это идентичность участника в рамках звонка, а не
// обязательно зарегистрированный пользователь, поэтому FK на user здесь нет.

export const message = pgTable(
  'message',
  {
    id: text('id').primaryKey(),
    roomId: text('roomId').notNull(),
    peerId: text('peerId').notNull(),
    displayName: text('displayName').notNull(),
    // Текст сообщения. Для сообщений только с вложением хранится пустая строка.
    text: text('text').notNull().default(''),
    // Вложение (файл на диске сервера) в виде JSON: { url, name, size, mime }.
    // null — обычное текстовое сообщение.
    attachment: jsonb('attachment'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [index('message_roomId_createdAt_idx').on(t.roomId, t.createdAt)],
)

// --- Read receipts ---------------------------------------------------------
// Отметка "прочитано" на уровне участника: для каждой пары (комната, участник)
// храним время самого свежего сообщения, которое участник уже видел
// (чат открыт и вкладка активна). Отправитель сравнивает это время с временем
// своих сообщений, чтобы показать галочки "доставлено/прочитано".
// Стирается вместе с историей чата при уничтожении комнаты.

export const messageRead = pgTable(
  'message_read',
  {
    roomId: text('roomId').notNull(),
    peerId: text('peerId').notNull(),
    // Время (createdAt) последнего прочитанного участником сообщения.
    lastReadAt: timestamp('lastReadAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.peerId] })],
)

// --- Chat button settings --------------------------------------------------
// Персональные настройки плавающей кнопки чата для зарегистрированного
// пользователя. Незарегистрированные хранят то же самое в localStorage; при
// входе локальные настройки сливаются сюда. Одна строка на пользователя.

export const chatButtonSettings = pgTable('chat_button_settings', {
  userId: text('userId')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Позиция кнопки как доля вьюпорта (0..1), чтобы переживать ресайз.
  xRatio: real('xRatio').notNull().default(0.92),
  yRatio: real('yRatio').notNull().default(0.78),
  // Отрисовывать ли кнопку вообще.
  visible: boolean('visible').notNull().default(true),
  // KeyboardEvent.code для открытия чата; null — клавиша не назначена.
  hotkey: text('hotkey'),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

// --- Room / app settings ---------------------------------------------------
// Общие настройки приложения для зарегистрированного пользователя.
// Анонимные хранят то же самое в localStorage; при входе мёрджатся сюда.
// soundVolume — громкость звуков приложения, 0..100 (целое число).
// noiseGate — шумоподавление микрофона (гейт), включено по умолчанию.
// noiseGateStrength — сила гейта, 0..100 (50 — значение по умолчанию).

export const roomSettings = pgTable('room_settings', {
  userId: text('userId')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  soundVolume: integer('soundVolume').notNull().default(80),
  noiseGate: boolean('noiseGate').notNull().default(true),
  noiseGateStrength: integer('noiseGateStrength').notNull().default(50),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

// --- Annotation settings ---------------------------------------------------
// Персональный способ включения пера и одноразовая подсказка.

export const annotationSettings = pgTable('annotation_settings', {
  userId: text('userId')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  activation: text('activation').notNull().default('none'),
  hotkey: text('hotkey'),
  hintSeen: boolean('hintSeen').notNull().default(false),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

// --- Shared whiteboard -----------------------------------------------------
// Совместная доска комнаты (tldraw). Для каждой комнаты храним один последний
// снапшот документа целиком (JSON-строка от tldraw getSnapshot). Снапшот
// периодически перезаписывается, пока участники рисуют, и стирается вместе с
// комнатой, когда она опустела. open — открыта ли доска у всех сейчас.

export const whiteboard = pgTable('whiteboard', {
  roomId: text('roomId').primaryKey(),
  // Полный снапшот документа tldraw в виде JSON-строки. null — доска пустая.
  snapshot: text('snapshot'),
  // Открыта ли доска у всех участников (синхронизированное состояние комнаты).
  open: boolean('open').notNull().default(false),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

// --- Presentation drawings -------------------------------------------------
// Рисунки поверх слайдов презентации. Для каждой пары (комната, индекс слайда)
// храним последний снапшот рисунка как data URL (base64 PNG). Стирается вместе
// с комнатой. slideIndex хранится как text (0-based индекс в виде строки).

export const presentationDrawing = pgTable(
  'presentation_drawing',
  {
    roomId: text('roomId').notNull(),
    slideIndex: text('slideIndex').notNull(),
    snapshot: text('snapshot'),
    updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.slideIndex] })],
)


