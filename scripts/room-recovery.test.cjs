const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const quiet = { info() {}, warn() {}, error() {}, log() {} }
const compiled = new Map()
function loadTs(file, imports, globals = {}) {
  if (!compiled.has(file)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    compiled.set(file, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText)
  }
  const exports = {}
  vm.runInNewContext(compiled.get(file), {
    exports,
    require(id) { assert.ok(id in imports, `Unexpected import: ${id}`); return imports[id] },
    console: quiet, AbortController, setTimeout, clearTimeout, ...globals,
  }, { filename: file })
  return exports
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function clock() {
  let now = 0
  let id = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    async advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        timers.delete(next[0]); now = next[1].at; next[1].fn()
        await flush()
      }
      now = until
    },
  }
}

class FakeSocket extends EventEmitter {
  connected = false
  active = true
  requests = []
  emit(event, payload, reply) { this.requests.push({ event, payload, reply }); return true }
  inbound(event, ...args) { return super.emit(event, ...args) }
  connectAs(id) { this.id = id; this.connected = true; this.inbound('connect') }
  disconnect() { this.connected = false; this.id = undefined; this.inbound('disconnect', 'transport close') }
}

function roomClient({ setup } = {}) {
  const socket = new FakeSocket()
  const time = clock()
  socket.timeout = (ms) => ({ emit: (event, payload, ack) => {
    const timer = time.setTimeout(() => ack(new Error('operation has timed out')), ms)
    socket.emit(event, payload, (...args) => { time.clearTimeout(timer); ack(null, ...args) })
  } })
  const actions = []
  const effects = []
  const transports = []
  const reconnecting = []
  const { useMediasoup } = loadTs('hooks/use-mediasoup.ts', {
    '@/lib/mic-gate': { diagnoseMicTrack: () => null },
    './mediasoup/producer-transport': { isProducerOnStaleTransport: () => false },
    './mediasoup/socket-request': loadTs('hooks/mediasoup/socket-request.ts', {}, time),
    react: {
      useEffect: (fn) => effects.push(fn), useRef: (current) => ({ current }), useCallback: (fn) => fn,
      useReducer: (_, state) => [state, (action) => actions.push(action)],
      useState: (state) => [state, (value) => reconnecting.push(value)],
    },
    'socket.io-client': { io: () => socket },
    '@/lib/chat/reply': {},
    '@/hooks/mediasoup/types': { CLIENT_ID: 'same-page', getOrCreatePeerId: () => 'peer', getPeerToken: () => 'token' },
    'mediasoup-client': { Device: class { async load() {} } },
    './mediasoup/types': {},
    './mediasoup/use-transports': {
      useTransports: ({ sendTransportRef, recvTransportRef }) => ({
        async setupTransports(_, __, ___, signal) {
          await setup?.(signal)
          if (signal.aborted) throw new Error('setup interrupted')
          function transport() { return { closed: false, connectionState: 'connected', close() { this.closed = true } } }
          sendTransportRef.current = transport()
          recvTransportRef.current = transport()
          transports.push(sendTransportRef.current, recvTransportRef.current)
        },
      }),
    },
    './mediasoup/use-media-controls': { useMediaControls: () => ({}) },
    './mediasoup/use-network-guard': { useNetworkGuard: () => ({}) },
    './mediasoup/use-whiteboard': { useWhiteboard: () => ({}) },
    './mediasoup/reducer': {},
    './mediasoup/use-chat': { useChat: () => ({}) },
    './mediasoup/register-socket-listeners': { registerRoomSocketListeners() {} },
  }, { ...time, MediaStream: class { getTracks() { return [] } getAudioTracks() { return [] } getVideoTracks() { return [] } } })
  const api = useMediasoup('TEST-ROOM', 'Test')
  effects[0]() // auto-join effect
  const take = (event) => {
    const request = socket.requests.shift()
    assert.equal(request?.event, event)
    return request.reply
  }
  async function join() {
    take('joinRoom')(null, { rtpCapabilities: {}, existingPeers: [] })
    await flush()
    take('resetMediaState')(null)
    await flush()
  }
  async function establish() {
    socket.connectAs('first')
    await flush()
    await join()
    assert.equal(actions.at(-1).type, 'CONNECTED')
  }
  return { socket, time, actions, transports, reconnecting, take, join, establish, api }
}

test('a lost join acknowledgement during rebuild retries while keeping the room open', async () => {
  const h = roomClient()
  await h.establish()
  h.socket.disconnect()
  h.socket.connectAs('second')
  h.take('rejoinProbe')('peer evicted')
  await flush()
  const lateReply = h.take('joinRoom')
  await h.time.advance(15000)
  assert.equal(h.reconnecting.at(-1), true)
  assert.equal(h.actions.some((action) => action.type === 'ERROR'), false)
  lateReply(null, { rtpCapabilities: {}, existingPeers: [] })
  await flush()
  assert.equal(h.socket.requests.length, 0)
  await h.time.advance(1000)
  await h.join()
  assert.equal(h.actions.filter((action) => action.type === 'CONNECTED').length, 2)
  assert.equal(h.reconnecting.at(-1), false)
})

test('disconnect during join aborts it, ignores a transient connect error and starts a fresh join', async () => {
  const h = roomClient()
  await h.establish()
  h.socket.disconnect()
  h.socket.connectAs('second')
  h.take('rejoinProbe')('peer evicted')
  await flush()
  const lateReply = h.take('joinRoom')
  h.socket.disconnect()
  h.socket.inbound('connect_error', new Error('websocket error'))
  h.socket.connectAs('third')
  await flush()
  lateReply(null, { rtpCapabilities: {}, existingPeers: [] })
  await flush()
  await h.join()
  assert.equal(h.actions.some((action) => action.type === 'ERROR'), false)
  assert.equal(h.actions.filter((action) => action.type === 'CONNECTED').length, 2)
})

test('a second disconnect cancels an in-flight probe without closing working media', async () => {
  const h = roomClient()
  await h.establish()
  h.socket.disconnect()
  h.socket.connectAs('second')
  const staleProbe = h.take('rejoinProbe')
  h.socket.disconnect()
  h.socket.connectAs('third')
  h.take('rejoinProbe')(null)
  staleProbe('peer evicted')
  await flush()
  await h.time.advance(10000)
  assert.equal(h.socket.requests.length, 0)
  assert.equal(h.transports.length, 2)
  assert.ok(h.transports.every((transport) => !transport.closed))
  assert.equal(h.reconnecting.at(-1), false)
})

test('a lost acknowledgement while setting up media retries and reconnects', async () => {
  let attempts = 0
  const h = roomClient({ setup: () => {
    if (++attempts === 2) throw new Error('createWebRtcTransport: acknowledgement timeout')
  } })
  await h.establish()
  h.socket.disconnect()
  h.socket.connectAs('second')
  h.take('rejoinProbe')('peer evicted')
  await flush()
  await h.join()
  assert.equal(h.actions.filter((action) => action.type === 'CONNECTED').length, 1)
  assert.equal(h.actions.some((action) => action.type === 'ERROR'), false)
  await h.time.advance(1000)
  await h.join()
  assert.equal(h.actions.filter((action) => action.type === 'CONNECTED').length, 2)
})

test('leaving the room cancels a pending retry', async () => {
  const h = roomClient()
  await h.establish()
  h.socket.disconnect()
  h.socket.connectAs('second')
  h.take('rejoinProbe')('peer evicted')
  await flush()
  h.take('joinRoom')('getOrCreateRoom timeout (10000ms)')
  await flush()
  h.api.leave()
  h.take('leaveRoom')
  await h.time.advance(15000)
  assert.equal(h.socket.requests.length, 0)
  assert.equal(h.actions.at(-1).type, 'DISCONNECTED')
})

function roomServer({ loadRoom } = {}) {
  const peers = new Map()
  const owners = new Map()
  const clients = new Map()
  const tokens = new Map()
  const broadcasts = []
  const sessions = new Map()
  const room = {
    getPeer: (id) => peers.get(id), hasPeer: (id) => peers.has(id),
    addPeer: (peer) => peers.set(peer.peerId, peer),
    getPeerIds: () => [...peers.keys()], isFull: () => peers.size === 1,
    getExistingPeersFor: () => [], getRtpCapabilities: () => ({}),
    presentationDrawings: new Map(),
  }
  const roomRegistry = {
    rooms: new Map([['TEST-ROOM', room]]), isRoomKnown: () => true,
    getOrCreateRoom: async () => { await loadRoom?.(); return room },
    hasPeerToken: (_, id) => tokens.has(id),
    verifyPeerToken: (_, id, token) => tokens.get(id) === token,
    issuePeerToken: (_, id) => { if (!tokens.has(id)) tokens.set(id, 'token'); return tokens.get(id) },
    getPeerSocket: (_, id) => owners.get(id), setPeerSocket: (_, id, owner) => owners.set(id, owner),
    getPeerClient: (_, id) => clients.get(id), setPeerClient: (_, id, client) => clients.set(id, client),
    clearPendingDisconnect() {},
    evictPeer() { assert.fail('replacing the last peer must not evict it or delete the room') },
  }
  const io = { sockets: { sockets: new Map() } }
  const shared = {
    './helpers': loadTs('server/src/socket/helpers.ts', {}),
    '../room-code': { canonicalRoomCode: (code) => code },
    './room-registry': roomRegistry,
  }
  const { registerMediaHandlers } = loadTs('server/src/socket/media-handlers.ts', {
    ...shared,
    '../Peer': loadTs('server/src/Peer.ts', {}),
    '../db': { getRoomMessages: async () => [], getRoomReadMarkers: async () => [] },
    '../config': { MAX_PEERS_PER_ROOM: 1 },
    '../limits': { clientIp: () => '127.0.0.1', createKeyedRateLimiter: () => () => true },
  })
  const { registerLifecycleHandlers } = loadTs('server/src/socket/lifecycle-handlers.ts', shared)
  const socket = (id) => {
    const connection = new FakeSocket()
    connection.connectAs(id)
    connection.handshake = { headers: {}, address: '127.0.0.1' }
    connection.join = () => {}
    connection.to = () => ({ emit: (event) => broadcasts.push(event) })
    io.sockets.sockets.set(id, connection)
    const session = { roomId: null, peerId: null }
    sessions.set(id, session)
    registerMediaHandlers({ io, socket: connection, session })
    registerLifecycleHandlers({ io, socket: connection, session })
    return connection
  }
  const join = (connection, peerToken, reply) => connection.inbound('joinRoom', {
    roomId: 'TEST-ROOM', peerId: 'peer', clientId: 'same-page', peerToken, displayName: 'Test',
  }, reply)
  const joinAndWait = (connection, token) => new Promise((resolve, reject) => {
    join(connection, token, (error, data) => error ? reject(new Error(error)) : resolve(data))
  })
  return { socket, join, joinAndWait, owners, broadcasts, peers, sessions }
}

test('a full rejoin replaces the last peer in place and ignores a stale leave', async () => {
  const server = roomServer()
  const oldSocket = server.socket('old')
  const first = await server.joinAndWait(oldSocket)
  const oldPeer = server.peers.get('peer')
  oldPeer.producers.set('mic', { id: 'mic' })
  const newSocket = server.socket('new')
  const second = await server.joinAndWait(newSocket, first.peerToken)
  assert.equal(second.peerToken, first.peerToken)
  assert.equal(server.owners.get('peer'), 'new')
  assert.equal(oldSocket.connected, false)
  assert.equal(oldPeer.producers.size, 0)
  assert.deepEqual(server.broadcasts, ['peerJoined', 'producerClosed'])
  oldSocket.inbound('leaveRoom', { roomId: 'TEST-ROOM', peerId: 'peer' })
  assert.equal(server.owners.get('peer'), 'new')
})

test('a join that finishes loading after its socket disconnected cannot take ownership', async () => {
  let finishLoading
  const loading = new Promise((resolve) => { finishLoading = resolve })
  const server = roomServer({ loadRoom: () => loading })
  const oldSocket = server.socket('old')
  server.join(oldSocket, undefined, () => assert.fail('stale socket got a join acknowledgement'))
  oldSocket.disconnect()
  const newSocket = server.socket('new')
  const joining = server.joinAndWait(newSocket)
  finishLoading()
  await joining
  assert.equal(server.owners.get('peer'), 'new')
  assert.equal(server.sessions.get('old').peerId, null)
  assert.deepEqual(server.broadcasts, ['peerJoined'])
})
