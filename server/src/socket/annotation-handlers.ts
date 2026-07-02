import type { AnnotationStrokePayload, AnnotationClearPayload } from '../types'
import { createRateLimiter, type HandlerContext } from './helpers'
import { authedRoom } from './room-registry'

// ---------------------------------------------------------------------------
// Screen-share annotations (рисование поверх демонстрации экрана)
//
// Эфемерные — НЕ персистятся: аннотации живут только пока идёт демонстрация.
// annotationStroke транслирует один vector-штрих остальным участникам;
// annotationClear стирает всё для всех. Координаты нормализованы клиентом.
// ---------------------------------------------------------------------------

export function registerAnnotationHandlers(ctx: HandlerContext): void {
  const { socket } = ctx

  // Rate-limit: рисование генерирует много событий — до 300/сек.
  const allowAnnotationStroke = createRateLimiter(300, 1000)

  socket.on('annotationStroke', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid, stroke } = payload as AnnotationStrokePayload
    const room = authedRoom(rid, pid, socket.id)
    if (!room) return
    if (stroke == null) return

    if (!allowAnnotationStroke()) return

    socket.to(rid).emit('annotationStroke', { peerId: pid, stroke })
  })

  socket.on('annotationClear', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid } = payload as AnnotationClearPayload
    const room = authedRoom(rid, pid, socket.id)
    if (!room) return
    socket.to(rid).emit('annotationClear', { peerId: pid })
  })
}
