const MAX_PLAYERS = 6
const MAX_MESSAGE_BYTES = 16_384

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.protocol !== 'https:' || url.pathname !== '/health') {
      if (request.method !== 'GET' || url.protocol !== 'https:') return new Response('Not found', { status: 404 })
    }
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'tabletalk-signaling' })

    const match = url.pathname.match(/^\/room\/([A-Z]{6})$/)
    if (!match) return new Response('Not found', { status: 404 })
    const origin = request.headers.get('Origin')
    const allowedOrigin = env.ALLOWED_ORIGIN
    if (!origin || (allowedOrigin && origin !== allowedOrigin)) return new Response('Forbidden', { status: 403 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })

    const id = env.ROOMS.idFromName(match[1])
    return env.ROOMS.get(id).fetch(request)
  },
}

export class LobbyRoom {
  constructor(state) {
    this.state = state
    this.peers = new Map()
    this.sockets = new Map()
    this.hostId = ''
    this.state.getWebSockets().forEach((socket) => {
      const attachment = socket.deserializeAttachment()
      if (!attachment?.peerId || !attachment?.name) return
      this.sockets.set(attachment.peerId, socket)
      this.peers.set(attachment.peerId, attachment)
      if (attachment.host) this.hostId = attachment.peerId
    })
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.state.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket, data) {
    const raw = typeof data === 'string' ? data : ''
    if (!raw || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'Message too large')
      return
    }
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      socket.close(1003, 'Invalid message')
      return
    }

    const attachment = socket.deserializeAttachment() || {}
    if (message.type === 'join' && !attachment.peerId) {
      if (this.peers.size >= MAX_PLAYERS) return this.send(socket, { type: 'error', message: 'This lobby is full.' })
      if (typeof message.peerId !== 'string' || !/^[\w-]{1,64}$/.test(message.peerId) || typeof message.name !== 'string') {
        return this.send(socket, { type: 'error', message: 'Invalid player details.' })
      }
      if (this.peers.has(message.peerId)) return this.send(socket, { type: 'error', message: 'That player is already in this lobby.' })
      const name = message.name.trim().slice(0, 24)
      if (!name) return this.send(socket, { type: 'error', message: 'Enter a player name.' })
      const peer = { peerId: message.peerId, name, host: this.peers.size === 0 }
      if (peer.host) this.hostId = peer.peerId
      socket.serializeAttachment(peer)
      this.sockets.set(peer.peerId, socket)
      this.peers.set(peer.peerId, peer)
      this.send(socket, { type: 'joined', hostId: this.hostId, players: this.list() })
      this.broadcast({ type: 'membership', hostId: this.hostId, players: this.list() }, peer.peerId)
      return
    }

    if (!attachment.peerId || !this.peers.has(attachment.peerId)) return this.send(socket, { type: 'error', message: 'Join the lobby first.' })
    if (message.type === 'signal') {
      const target = this.sockets.get(message.target)
      if (!target || !message.payload || !['offer', 'answer', 'candidate'].includes(message.payload.type)) return
      this.send(target, { type: 'signal', from: attachment.peerId, payload: message.payload })
    } else if (message.type === 'host' && attachment.peerId === this.hostId && this.sockets.has(message.target)) {
      this.hostId = message.target
      this.peers.forEach((peer, peerId) => {
        peer.host = peerId === this.hostId
        this.sockets.get(peerId)?.serializeAttachment(peer)
      })
      this.broadcast({ type: 'membership', hostId: this.hostId, players: this.list() })
    }
  }

  async webSocketClose(socket) {
    this.removePeer(socket)
  }

  async webSocketError(socket) {
    this.removePeer(socket)
  }

  removePeer(socket) {
    const attachment = socket.deserializeAttachment() || {}
    if (!attachment.peerId || this.sockets.get(attachment.peerId) !== socket) return
    this.sockets.delete(attachment.peerId)
    this.peers.delete(attachment.peerId)
    if (attachment.peerId === this.hostId) {
      this.hostId = this.peers.keys().next().value || ''
      this.peers.forEach((peer, peerId) => {
        peer.host = peerId === this.hostId
        this.sockets.get(peerId)?.serializeAttachment(peer)
      })
    }
    if (this.peers.size) this.broadcast({ type: 'membership', hostId: this.hostId, leftId: attachment.peerId, players: this.list() })
  }

  list() {
    return Array.from(this.peers.values(), ({ peerId, name }) => ({ id: peerId, name }))
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      this.removePeer(socket)
    }
  }

  broadcast(message, exceptId = '') {
    this.sockets.forEach((socket, peerId) => {
      if (peerId !== exceptId) this.send(socket, message)
    })
  }
}