"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAnnotationHandlers = registerAnnotationHandlers;
const helpers_1 = require("./helpers");
const room_registry_1 = require("./room-registry");
// ---------------------------------------------------------------------------
// Screen-share annotations (рисование поверх демонстрации экрана)
//
// Эфемерные — НЕ персистятся: аннотации живут только пока идёт демонстрация.
// annotationStroke транслирует один vector-штрих остальным участникам;
// annotationClear стирает всё для всех. Координаты нормализованы клиентом.
// ---------------------------------------------------------------------------
function registerAnnotationHandlers(ctx) {
    const { socket } = ctx;
    // Rate-limit: рисование генерирует много событий — до 300/сек.
    const allowAnnotationStroke = (0, helpers_1.createRateLimiter)(300, 1000);
    socket.on('annotationStroke', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid, stroke } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        if (stroke == null)
            return;
        if (!allowAnnotationStroke())
            return;
        socket.to(rid).emit('annotationStroke', { peerId: pid, stroke });
    });
    socket.on('annotationClear', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        socket.to(rid).emit('annotationClear', { peerId: pid });
    });
}
