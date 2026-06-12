import RoomClient from "./room-client"

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>
  searchParams: Promise<{ create?: string }>
}) {
  const { roomId } = await params
  const { create } = await searchParams

  return <RoomClient roomId={roomId} create={create === "true"} />
}
