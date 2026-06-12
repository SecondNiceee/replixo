import RoomLoader from "./room-loader"

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>
  searchParams: Promise<{ create?: string }>
}) {
  const { roomId } = await params
  const { create } = await searchParams

  return <RoomLoader roomId={roomId} create={create === "true"} />
}
