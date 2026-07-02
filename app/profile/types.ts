export interface User {
  id: string
  name: string
  email: string
}

export interface Friend {
  id: string
  friendId: string
  friendName: string
  friendUsername: string | null
}

export interface PendingRequest {
  id: string
  requesterId: string
  requesterName: string
  requesterUsername: string | null
}

export interface SentRequest {
  id: string
  addresseeId: string
  addresseeName: string
  addresseeUsername: string | null
  createdAt: string
}

export const fetcher = (url: string) => fetch(url).then((r) => r.json())
