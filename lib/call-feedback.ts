export const FEEDBACK_MIN_CALL_MS = 10 * 60 * 1000
export const FEEDBACK_COMMENT_MAX = 2000

const STORAGE_KEY = "replixo:pending-call-feedback"

export type FeedbackRating = 1 | 2 | 3

export interface PendingCallFeedback {
  roomId: string
  durationSec: number
}

// The room navigates away on leave, so the prompt is handed over to the next page
// through sessionStorage and shown there exactly once.
export function queueCallFeedback(pending: PendingCallFeedback) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending))
  } catch {}
}

export function takePendingCallFeedback(): PendingCallFeedback | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(STORAGE_KEY)
    const parsed = JSON.parse(raw) as Partial<PendingCallFeedback>
    if (typeof parsed.roomId !== "string" || typeof parsed.durationSec !== "number") return null
    return { roomId: parsed.roomId, durationSec: parsed.durationSec }
  } catch {
    return null
  }
}
