import { Peer } from '../Peer'
import { getRoomMessages, getRoomReadMarkers } from '../db'
import type {
  JoinRoomPayload,
  CreateTransportPayload,
  ConnectTransportPayload,
  ProducePayload,
  ConsumePayload,
  ResumeConsumerPayload,
  PauseConsumerPayload,
  SetConsumerLayersPayload,
  CloseProducerPayload,
  PauseProducerPayload,
} from '../types'
import { ack, err, createRateLimiter, withTimeout, optional, type Callback, type HandlerContext } from './helpers'
import { canonicalRoomCode } from '../room-code'
import { MAX_PEERS_PER_ROOM, MAX_ROOMS, MAX_ROOM_CREATIONS_PER_IP, ROOM_CREATE_WINDOW_MS } from '../config'
import { clientIp, createKeyedRateLimiter } from '../limits'
import {
  rooms,
  isRoomKnown,
  roomCount,
  hasPeerToken,
  verifyPeerToken,
  issuePeerToken,
  clearPendingDisconnect,
  getPeerSocket,
  setPeerSocket,
  getPeerClient,
  setPeerClient,
  getOrCreateRoom,
  evictPeer,
  isRoomCreationAllowed,
} from './room-registry'

// ---------------------------------------------------------------------------
// WebRTC / mediasoup signalling: joinRoom, transports, produce/consume
// ---------------------------------------------------------------------------

const allowRoomCreationFromIp = createKeyedRateLimiter(MAX_ROOM_CREATIONS_PER_IP, ROOM_CREATE_WINDOW_MS)

export function registerMediaHandlers(ctx: HandlerContext): void {
  const { io, socket, session } = ctx
  const ip = clientIp(socket.handshake.headers, socket.handshake.address)
  // Normal clients join once per (re)connect; this only stops join floods.
  const allowJoin = createRateLimiter(10, 10_000)
  let joinSequence = 0
  socket.on('leaveRoom', () => { joinSequence += 1 })

  const ownsPeer = (roomId: string, peerId: string): boolean => (
    session.roomId === roomId &&
    session.peerId === peerId &&
    getPeerSocket(roomId, peerId) === socket.id
  )

  // Любое действие над транспортами/продюсерами/консьюмерами участника можно
  // выполнять только из сокета, который этим участником и является. Иначе,
  // зная код комнаты и peerId, можно закрыть чужой транспорт или заглушить
  // чужой микрофон.
  const rejectForeignPeer = (event: string, roomId: unknown, peerId: unknown, callback?: Callback<never>): boolean => {
    if (typeof roomId === 'string' && typeof peerId === 'string' && ownsPeer(roomId, peerId)) return false
    console.warn(`[media] ${event} rejected room=${String(roomId)} peer=${String(peerId)} socket=${socket.id}`)
    if (callback) err(callback, 'Socket does not own this peer')
    return true
  }

  // -----------------------------------------------------------------------
  // joinRoom
  // -----------------------------------------------------------------------
  socket.on(
    'joinRoom',
    async (payload: JoinRoomPayload, callback: Callback<{ rtpCapabilities: object; existingPeers: object[] }>) => {
      const { peerId, displayName, rtpCapabilities, create, clientId, peerToken } = payload ?? {}
      const roomId = canonicalRoomCode(payload?.roomId)
      const sequence = ++joinSequence

      try {
        if (!allowJoin()) {
          return err(callback as Callback<never>, 'Слишком много попыток входа, подождите немного')
        }
        if (
          !roomId ||
          typeof peerId !== 'string' || !peerId || peerId.length > 128 ||
          typeof displayName !== 'string' || !displayName.trim()
        ) {
          return err(callback as Callback<never>, 'Некорректные данные подключения')
        }
        // Комната ещё не поднята — пускаем только того, кто пришёл её создавать,
        // либо по коду, который сервер сам выдал под звонок (там «создателя»
        // нет: оба участника просто идут по ссылке, и кто успел первым, тот и
        // поднимает комнату).
        if (!create && !rooms.has(roomId) && !isRoomCreationAllowed(roomId)) {
          return err(callback as Callback<never>, 'Комната не найдена')
        }

        if (!isRoomKnown(roomId)) {
          if (roomCount() >= MAX_ROOMS) {
            console.warn(`[room] Room limit reached (${MAX_ROOMS}), rejected room=${roomId} ip=${ip}`)
            return err(callback as Callback<never>, 'Сервер перегружен, попробуйте чуть позже')
          }
          if (!allowRoomCreationFromIp(ip)) {
            console.warn(`[room] Room creation rate limit ip=${ip} room=${roomId}`)
            return err(callback as Callback<never>, 'Слишком много новых комнат, попробуйте позже')
          }
        }

        // This peerId is already seated (live or within its reconnect grace
        // window). Only its owner — who holds the server-issued token — may take
        // the seat over; anyone else who merely saw the peerId in `peerJoined`
        // is refused instead of kicking the real participant out.
        const alreadyOwnedBySocket = getPeerSocket(roomId, peerId) === socket.id
        if (!alreadyOwnedBySocket && hasPeerToken(roomId, peerId) && !verifyPeerToken(roomId, peerId, peerToken)) {
          console.warn(`[room] Peer takeover rejected (bad token) room=${roomId} peer=${peerId} socket=${socket.id} ip=${ip}`)
          return err(callback as Callback<never>, 'Этот участник уже в комнате с другого устройства')
        }

        if (session.roomId && session.peerId && (session.roomId !== roomId || session.peerId !== peerId)) {
          evictPeer(io, session.roomId, session.peerId, socket.id)
          socket.leave(session.roomId)
          session.roomId = null
          session.peerId = null
        }

        // Создание комнаты поднимает mediasoup-router и подтягивает состояние
        // доски из БД. Если worker мёртв или база висит, промис может не
        // зарезолвиться никогда — ограничиваем и отвечаем ошибкой, чтобы клиент
        // показал её вместо бесконечного спиннера.
        const room = await withTimeout(getOrCreateRoom(roomId), 10_000, 'getOrCreateRoom')
        // Room creation/hydration yields. A disconnected or superseded request
        // must never claim ownership after the newer connection has joined.
        if (!socket.connected || sequence !== joinSequence) return
        if (rooms.get(roomId) !== room) return err(callback as Callback<never>, 'Комната не найдена')
        if (getPeerSocket(roomId, peerId) !== socket.id && hasPeerToken(roomId, peerId) && !verifyPeerToken(roomId, peerId, peerToken)) {
          return err(callback as Callback<never>, 'Этот участник уже в комнате с другого устройства')
        }
        const oldPeer = room.getPeer(peerId)
        const previousSocketId = getPeerSocket(roomId, peerId)
        const previousSocket = previousSocketId !== socket.id && previousSocketId
          ? io.sockets.sockets.get(previousSocketId) : undefined
        const sameClient = !!clientId && getPeerClient(roomId, peerId) === clientId
        const repeatedJoin = !!oldPeer && previousSocketId === socket.id
        if (!oldPeer && room.isFull()) return err(callback as Callback<never>, `Room is full (max ${MAX_PEERS_PER_ROOM} participants)`)

        // A full rejoin replaces media in place. Evicting the last participant
        // here would destroy the room and delete its chat while they reconnect.
        const closedProducers = oldPeer && !repeatedJoin ? [...oldPeer.producers.keys()] : []
        if (!repeatedJoin) oldPeer?.close()
        const peer = repeatedJoin ? oldPeer! : new Peer({ peerId, displayName: displayName.trim(), socketId: socket.id })
        peer.displayName = displayName.trim()
        peer.rtpCapabilities = rtpCapabilities
        if (!repeatedJoin) room.addPeer(peer)

        session.roomId = roomId
        session.peerId = peerId
        setPeerSocket(roomId, peerId, socket.id)
        setPeerClient(roomId, peerId, typeof clientId === 'string' ? clientId : undefined)
        clearPendingDisconnect(roomId, peerId)
        const issuedPeerToken = issuePeerToken(roomId, peerId)
        socket.join(roomId)
        for (const producerId of closedProducers) socket.to(roomId).emit('producerClosed', { peerId, producerId })

        if (previousSocket?.connected) {
          if (!sameClient) previousSocket.emit('kicked', { reason: 'duplicate' })
          // Bind first so the old disconnect cannot evict the replacement.
          previousSocket.disconnect(true)
        }

        const existingPeers = room.getExistingPeersFor(peerId)
        console.log(`[room] ${repeatedJoin ? 'Repeated join' : oldPeer ? 'Peer rejoined' : 'Peer joined'} room=${roomId} peer=${peerId} socket=${socket.id} peers=${room.getPeerIds().length}`)

        // A repeated acknowledgement from the same socket must not create a
        // second presence event or replay the join sound for other clients.
        if (!oldPeer) socket.to(roomId).emit('peerJoined', { peerId, displayName: displayName.trim() })

        // Load persisted chat history so the joining peer (or someone who just
        // reloaded the page) sees prior messages. Empty when persistence is off.
        // Read markers of every participant so checkmarks render correctly on
        // already-sent messages right after joining/reloading.
        // Оба запроса некритичны для входа в звонок и выполняются параллельно с
        // ограничением по времени: висящая база больше не задерживает ack.
        const [messages, readMarkers] = await Promise.all([
          optional(getRoomMessages(roomId), 3_000, 'getRoomMessages', []),
          optional(getRoomReadMarkers(roomId), 3_000, 'getRoomReadMarkers', []),
        ])

        if (!socket.connected || sequence !== joinSequence || !ownsPeer(roomId, peerId)) return

        // Serialize presentationDrawings Map → plain object for JSON transport.
        const presentationDrawings: Record<string, string> = {}
        for (const [idx, snap] of room.presentationDrawings.entries()) {
          presentationDrawings[String(idx)] = snap
        }

        ack(callback, {
          peerToken: issuedPeerToken,
          rtpCapabilities: room.getRtpCapabilities(),
          existingPeers,
          currentSlide: room.currentSlide ?? null,
          messages,
          readMarkers,
          // Shared whiteboard: whether it's open for everyone and the latest
          // full snapshot so a mid-session joiner sees the current drawing.
          whiteboardOpen: room.whiteboardOpen,
          whiteboardSnapshot: room.whiteboardSnapshot,
          // Presentation drawing annotations — one snapshot per slide index.
          presentationDrawings,
        })
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // resetMediaState — rebuild transports without removing room presence
  // -----------------------------------------------------------------------
  socket.on(
    'resetMediaState',
    (payload: { roomId: string; peerId: string }, callback: Callback<void>) => {
      const roomId = canonicalRoomCode(payload?.roomId)
      const peerId = payload?.peerId
      try {
        if (!roomId || typeof peerId !== 'string') return err(callback as Callback<never>, 'Invalid media reset payload')
        if (session.roomId !== roomId || session.peerId !== peerId || getPeerSocket(roomId, peerId) !== socket.id) {
          console.warn(`[media] Reset rejected room=${roomId} peer=${peerId} socket=${socket.id}`)
          return err(callback as Callback<never>, 'Socket does not own this peer')
        }
        const room = rooms.get(roomId)
        const peer = room?.getPeer(peerId)
        if (!room || !peer) return err(callback as Callback<never>, 'Peer not found')

        const producerIds = [...peer.producers.keys()]
        const transportCount = peer.transports.size
        const consumerCount = peer.consumers.size
        peer.resetMedia()
        for (const producerId of producerIds) {
          socket.to(roomId).emit('producerClosed', { peerId, producerId })
        }
        console.log(`[media] State reset room=${roomId} peer=${peerId} socket=${socket.id} transports=${transportCount} producers=${producerIds.length} consumers=${consumerCount}`)
        ack(callback, undefined)
      } catch (e) {
        console.error(`[media] State reset failed room=${roomId} peer=${peerId} socket=${socket.id}`, e)
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // createWebRtcTransport
  // -----------------------------------------------------------------------
  socket.on(
    'createWebRtcTransport',
    async (payload: CreateTransportPayload, callback: Callback<object>) => {
      const { roomId, peerId, direction } = payload ?? {}

      try {
        if (rejectForeignPeer('createWebRtcTransport', roomId, peerId, callback as Callback<never>)) return
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        const transportData = await room.createWebRtcTransport(peerId, direction ?? 'send')
        ack(callback, transportData)
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // connectTransport
  // -----------------------------------------------------------------------
  socket.on(
    'connectTransport',
    async (payload: ConnectTransportPayload, callback: Callback<void>) => {
      const { roomId, peerId, transportId, dtlsParameters } = payload ?? {}

      try {
        if (rejectForeignPeer('connectTransport', roomId, peerId, callback as Callback<never>)) return
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        await room.connectTransport(peerId, transportId, dtlsParameters)
        ack(callback, undefined)
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // restartIce  (called by client when transport ICE state => disconnected/failed)
  // -----------------------------------------------------------------------
  socket.on(
    'restartIce',
    async (
      payload: { roomId: string; peerId: string; transportId: string },
      callback: Callback<object>,
    ) => {
      const { roomId, peerId, transportId } = payload ?? {}
      try {
        if (rejectForeignPeer('restartIce', roomId, peerId, callback as Callback<never>)) return
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        console.log(`[media] ICE restart room=${roomId} peer=${peerId} transport=${transportId} socket=${socket.id}`)
        const iceParameters = await room.restartIce(peerId, transportId)
        ack(callback, iceParameters)
      } catch (e) {
        console.error(`[media] ICE restart failed room=${roomId} peer=${peerId} transport=${transportId} socket=${socket.id}`, e)
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // produce
  // -----------------------------------------------------------------------
  socket.on(
    'produce',
    async (payload: ProducePayload, callback: Callback<{ producerId: string }>) => {
      const { roomId, peerId, transportId, kind, rtpParameters, appData = {} } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        const peer = room.getPeer(peerId)
        if (!peer) return err(callback as Callback<never>, `Peer ${peerId} not found`)
        if (!ownsPeer(roomId, peerId)) {
          console.warn(`[media] Produce rejected room=${roomId} peer=${peerId} transport=${transportId} socket=${socket.id}`)
          return err(callback as Callback<never>, 'Socket does not own this peer')
        }

        const result = await room.produce(peerId, transportId, kind, rtpParameters, appData)
        console.info(`[media] Producer created room=${roomId} peer=${peerId} transport=${transportId} producer=${result.producerId} kind=${kind} source=${String(appData.source ?? "media")}`)

        // Notify all other peers in the room about the new producer
        socket.to(roomId).emit('newProducer', {
          peerId,
          displayName: peer.displayName,
          producerId: result.producerId,
          kind,
          appData,
        })

        ack(callback, { producerId: result.producerId })
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // consume
  // -----------------------------------------------------------------------
  socket.on(
    'consume',
    async (payload: ConsumePayload, callback: Callback<object>) => {
      const { roomId, peerId, producerId, rtpCapabilities } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)
        if (!ownsPeer(roomId, peerId)) {
          console.warn(`[media] Consume rejected room=${roomId} peer=${peerId} producer=${producerId} socket=${socket.id}`)
          return err(callback as Callback<never>, 'Socket does not own this peer')
        }

        const consumerData = await room.consume(peerId, producerId, rtpCapabilities)
        const data = consumerData as { consumerId: string; kind: string }
        console.info(`[media] Consumer created room=${roomId} peer=${peerId} producer=${producerId} consumer=${data.consumerId} kind=${data.kind}`)
        ack(callback, consumerData)
      } catch (e) {
        console.error(`[media] Consume failed room=${roomId} peer=${peerId} producer=${producerId} socket=${socket.id}`, e)
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // resumeConsumer
  // -----------------------------------------------------------------------
  socket.on(
    'resumeConsumer',
    async (payload: ResumeConsumerPayload, callback: Callback<void>) => {
      const { roomId, peerId, consumerId } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)
        if (!ownsPeer(roomId, peerId)) {
          console.warn(`[media] Resume rejected room=${roomId} peer=${peerId} consumer=${consumerId} socket=${socket.id}`)
          return err(callback as Callback<never>, 'Socket does not own this peer')
        }

        await room.resumeConsumer(peerId, consumerId)
        console.info(`[media] Consumer resumed room=${roomId} peer=${peerId} consumer=${consumerId}`)
        ack(callback, undefined)
      } catch (e) {
        console.error(`[media] Resume failed room=${roomId} peer=${peerId} consumer=${consumerId} socket=${socket.id}`, e)
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // closeConsumer — targeted receive-path recovery
  // -----------------------------------------------------------------------
  socket.on(
    'closeConsumer',
    (payload: ResumeConsumerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, consumerId } = payload ?? {}
      try {
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }
        if (!ownsPeer(roomId, peerId)) {
          console.warn(`[media] Consumer close rejected room=${roomId} peer=${peerId} consumer=${consumerId} socket=${socket.id}`)
          if (callback) return err(callback as Callback<never>, 'Socket does not own this peer')
          return
        }
        const details = room.closeConsumer(peerId, consumerId)
        console.warn(`[media] Consumer closed for recovery room=${roomId} peer=${peerId} producer=${details.producerId} consumer=${consumerId} kind=${details.kind}`)
        if (callback) ack(callback, undefined)
      } catch (e) {
        console.warn(`[media] Consumer close failed room=${roomId} peer=${peerId} consumer=${consumerId}: ${(e as Error).message}`)
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // pauseConsumer  (client-driven weak-downlink protection)
  //
  // The viewer's network guard decided that incoming video is drowning its
  // audio and asked us to stop forwarding it. Unlike a mute, this is a purely
  // local decision of ONE viewer — the producer keeps sending and everybody
  // else keeps receiving, so we deliberately do NOT broadcast anything here.
  // -----------------------------------------------------------------------
  socket.on(
    'pauseConsumer',
    async (payload: PauseConsumerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, consumerId, paused } = payload ?? {}

      try {
        if (rejectForeignPeer('pauseConsumer', roomId, peerId, callback as Callback<never> | undefined)) return
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        if (paused) {
          await room.pauseConsumer(peerId, consumerId)
        } else {
          await room.resumeConsumer(peerId, consumerId)
        }
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // setConsumerLayers  (client-driven weak-downlink protection, gentle step)
  //
  // The viewer's guard noticed its downlink is getting tight but not hopeless.
  // Rather than killing the picture we pin the consumer to the lowest simulcast
  // layer, which cuts the incoming video bitrate roughly 9× while keeping a
  // (small, choppy) image. Private to this viewer, so nothing is broadcast.
  // -----------------------------------------------------------------------
  socket.on(
    'setConsumerLayers',
    async (payload: SetConsumerLayersPayload, callback?: Callback<void>) => {
      const { roomId, peerId, consumerId, spatialLayer, temporalLayer } = payload ?? {}

      try {
        if (rejectForeignPeer('setConsumerLayers', roomId, peerId, callback as Callback<never> | undefined)) return
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        await room.setConsumerPreferredLayers(peerId, consumerId, spatialLayer, temporalLayer)
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // requestConsumerKeyFrame  (client-driven black-frame recovery)
  //
  // Emitted by a viewer whose video consumer has resumed but is still showing
  // a black frame (no decoded frames yet). We push a fresh keyframe on demand;
  // the client keeps asking until its decoder actually produces a picture.
  // -----------------------------------------------------------------------
  socket.on(
    'requestConsumerKeyFrame',
    async (payload: ResumeConsumerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, consumerId } = payload ?? {}

      try {
        if (rejectForeignPeer('requestConsumerKeyFrame', roomId, peerId, callback as Callback<never> | undefined)) return
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        await room.requestConsumerKeyFrame(peerId, consumerId)
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // closeProducer  (e.g. stop screen sharing)
  // -----------------------------------------------------------------------
  socket.on(
    'closeProducer',
    (payload: CloseProducerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, producerId } = payload ?? {}

      try {
        if (rejectForeignPeer('closeProducer', roomId, peerId, callback as Callback<never> | undefined)) return
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        room.closeProducer(peerId, producerId)
        socket.to(roomId).emit('producerClosed', { peerId, producerId })
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // pauseProducer / resumeProducer  (e.g. mute / unmute microphone)
  // -----------------------------------------------------------------------
  socket.on(
    'pauseProducer',
    async (payload: PauseProducerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, producerId, paused } = payload ?? {}

      try {
        if (rejectForeignPeer('pauseProducer', roomId, peerId, callback as Callback<never> | undefined)) return
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        if (paused) {
          await room.pauseProducer(peerId, producerId)
        } else {
          await room.resumeProducer(peerId, producerId)
        }

        // Inform other peers so they can update UI (e.g. mute indicator)
        socket.to(roomId).emit('producerPaused', { peerId, producerId, paused })
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )
}
