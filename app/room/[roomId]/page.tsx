import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { canonicalRoomCode } from "@/lib/room-code"
import RoomClient from "./room-client"

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>
  searchParams: Promise<{ create?: string }>
}) {
  const [{ roomId }, { create }, session] = await Promise.all([
    params,
    searchParams,
    auth.api.getSession({ headers: await headers() }),
  ])
  const canonicalRoomId = canonicalRoomCode(roomId)

  if (!canonicalRoomId) notFound()
  if (roomId !== canonicalRoomId) {
    redirect(`/room/${canonicalRoomId}${create === "true" ? "?create=true" : ""}`)
  }

  return (
    <RoomClient
      roomId={canonicalRoomId}
      create={create === "true"}
      serverDisplayName={session?.user.name?.trim() || null}
    />
  )
}
