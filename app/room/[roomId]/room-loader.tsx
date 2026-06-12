"use client"

import dynamic from "next/dynamic"

// dynamic with ssr:false must live in a Client Component.
const RoomClient = dynamic(() => import("./room-client"), { ssr: false })

export default function RoomLoader({
  roomId,
  create,
}: {
  roomId: string
  create: boolean
}) {
  return <RoomClient roomId={roomId} create={create} />
}
