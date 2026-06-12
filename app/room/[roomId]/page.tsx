import dynamic from "next/dynamic"

// Load the entire room UI only in the browser.
// ssr: false ensures mediasoup-client (and all other browser-only deps)
// are never evaluated during server-side rendering, which prevents the
// "Cannot access 'X' before initialization" TDZ crash from Turbopack.
const RoomClient = dynamic(() => import("./room-client"), { ssr: false })

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
