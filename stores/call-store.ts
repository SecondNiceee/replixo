'use client'

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Текущий звонок: входящий (нам звонят) и исходящий (мы звоним).
//
// Почему стор, а не useState: событие «звонят» приходит в глобальный
// уведомитель (он смонтирован в корневом layout и работает на любой странице),
// а кнопка «Позвонить» живёт в шапке переписки. Оба состояния нужны в
// несвязанных местах дерева, поэтому держим их снаружи React.
//
// Одновременно допускается ровно один звонок в каждую сторону: разговор — штука
// последовательная, а очередь входящих вызовов на экране только запутает.
// ---------------------------------------------------------------------------

export interface IncomingCall {
  callId: string
  /** Код комнаты, согласованный сервером заранее: оба придут в одну и ту же. */
  roomId: string
  fromUserId: string
  fromName: string
}

export interface OutgoingCall {
  callId: string
  roomId: string
  toUserId: string
  toName: string
}

interface CallStore {
  incoming: IncomingCall | null
  outgoing: OutgoingCall | null

  setIncoming: (call: IncomingCall) => void
  setOutgoing: (call: OutgoingCall) => void
  /**
   * Снять звонок с экрана. С `callId` — только если он совпадает с текущим:
   * события о завершении приходят и по устаревшим звонкам (второе устройство,
   * запоздавший таймаут), и они не должны гасить уже начатый новый вызов.
   */
  clearIncoming: (callId?: string) => void
  clearOutgoing: (callId?: string) => void
  reset: () => void
}

export const useCallStore = create<CallStore>((set) => ({
  incoming: null,
  outgoing: null,

  setIncoming: (call) => set({ incoming: call }),
  setOutgoing: (call) => set({ outgoing: call }),

  clearIncoming: (callId) =>
    set((state) =>
      !state.incoming || (callId && state.incoming.callId !== callId)
        ? state
        : { incoming: null },
    ),

  clearOutgoing: (callId) =>
    set((state) =>
      !state.outgoing || (callId && state.outgoing.callId !== callId)
        ? state
        : { outgoing: null },
    ),

  reset: () => set({ incoming: null, outgoing: null }),
}))
