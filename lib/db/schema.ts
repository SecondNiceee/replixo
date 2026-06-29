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

export const roomSettings = pgTable('room_settings', {
  userId: text('userId')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  soundVolume: integer('soundVolume').notNull().default(80),
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


