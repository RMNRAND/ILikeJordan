const MAX_PLAYERS = 6
const MAX_MESSAGE_BYTES = 16_384
const SESSION_SECONDS = 12 * 60 * 60
const APP_ORIGIN = 'https://ilikejordan.com'
const encoder = new TextEncoder()

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.protocol !== 'https:') return new Response('Not found', { status: 404 })
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'i-like-jordan' })

    if (url.pathname.startsWith('/api/auth/')) {
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
      if (request.method === 'POST' && request.headers.get('Origin') !== APP_ORIGIN) return new Response('Forbidden', { status: 403 })
      if (request.method === 'POST' && Number(request.headers.get('Content-Length') || 0) > 2048) return new Response('Request too large', { status: 413 })
      const id = env.AUTH.idFromName('auth-state')
      const headers = new Headers(request.headers)
      headers.set('x-ij-client-ip', request.headers.get('CF-Connecting-IP') || 'unknown')
      return env.AUTH.get(id).fetch(new Request(request, { headers }))
    }

    if (url.pathname === '/api/admin/unlock') {
      if (request.method !== 'POST' || request.headers.get('Origin') !== APP_ORIGIN) return new Response('Forbidden', { status: 403 })
      if (!env.AUTH_ADMIN_KEY || request.headers.get('Authorization') !== `Bearer ${env.AUTH_ADMIN_KEY}`) return new Response('Forbidden', { status: 403 })
      const id = env.AUTH.idFromName('auth-state')
      return env.AUTH.get(id).fetch(new Request(request))
    }

    const roomMatch = url.pathname.match(/^\/room\/([A-Z]{6})$/)
    if (roomMatch) {
      if (!await hasValidSession(request, env)) return new Response('Authentication required', { status: 401 })
      if (request.headers.get('Origin') !== APP_ORIGIN) return new Response('Forbidden', { status: 403 })
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
      const id = env.ROOMS.idFromName(roomMatch[1])
      return env.ROOMS.get(id).fetch(request)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}

export class AuthState {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/auth/status' && request.method === 'GET') {
      if (!this.env.AUTH_PEPPER) return Response.json({ authorized: false })
      if (!await this.consumeIpBudget(request, 'status', 120, 60_000)) return jsonError('Too many access checks. Try again shortly.', 429)
      const session = await verifySession(request, this.env)
      const lock = session ? await this.state.storage.get(`lock:${session.sub}`) : null
      return Response.json({ authorized: Boolean(session && !lock?.locked) })
    }
    if (path === '/api/auth/request' && request.method === 'POST') return this.requestCode(request)
    if (path === '/api/auth/verify' && request.method === 'POST') return this.verifyCode(request)
    if (path === '/api/auth/logout' && request.method === 'POST') {
      return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'ij_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' } })
    }
    if (path === '/api/admin/unlock' && request.method === 'POST') return this.unlock(request)
    if (path === '/session/check' && request.method === 'GET') {
      const subject = new URL(request.url).searchParams.get('subject') || ''
      const lock = subject ? await this.state.storage.get(`lock:${subject}`) : null
      return Response.json({ authorized: !lock?.locked && Boolean(subject) })
    }
    return new Response('Not found', { status: 404 })
  }

  async requestCode(request) {
    if (!this.env.ALLOWED_GATEWAY_EMAILS || !this.env.RESEND_API_KEY || !this.env.AUTH_PEPPER || !this.env.RESEND_FROM_EMAIL) {
      return jsonError('Sign-in is not configured yet.', 503)
    }
    if (!await this.consumeIpBudget(request, 'request', 10, 24 * 60 * 60 * 1000)) return jsonError('Too many code requests. Try again tomorrow.', 429)
    const data = await readJson(request)
    const address = normalizeAddress(data?.address)
    if (!address) return jsonError('Enter a valid email address.', 400)
    const addressKey = await this.key('address', address)
    const lock = await this.state.storage.get(`lock:${addressKey}`)
    if (lock?.locked) return Response.json({ ok: true })

    const allowed = this.getAllowedAddresses()
    if (!allowed.has(address)) return Response.json({ ok: true })

    const now = Date.now()
    const sendRateResult = await this.state.storage.transaction(async (transaction) => {
      const sendRate = await transaction.get(`sendrate:${addressKey}`) || { startedAt: now, count: 0, lastSentAt: 0 }
      if (now - sendRate.startedAt > 60 * 60 * 1000) {
        sendRate.startedAt = now
        sendRate.count = 0
      }
      if (now - sendRate.lastSentAt < 60_000) return 'cooldown'
      if (sendRate.count >= 3) return 'hourly-limit'
      sendRate.count += 1
      sendRate.lastSentAt = now
      await transaction.put(`sendrate:${addressKey}`, sendRate)
      return 'reserved'
    })
    if (sendRateResult === 'cooldown') return jsonError('Wait a minute before requesting another code.', 429)
    if (sendRateResult === 'hourly-limit') return jsonError('Code request limit reached. Try again in an hour.', 429)

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
    const digest = await this.key('otp', `${address}:${code}`)
    try {
      const result = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.env.RESEND_FROM_EMAIL,
          to: [address],
          subject: 'Your I Like Jordan sign-in code',
          text: `Your I Like Jordan verification code is ${code}. It expires in 5 minutes. If you did not request this, ignore this message.`,
        }),
      })
      if (!result.ok) return jsonError('Could not deliver a code. Check the approved email address.', 502)
    } catch {
      return jsonError('Could not deliver a code right now.', 502)
    }

    await this.state.storage.put(`challenge:${addressKey}`, { digest, expiresAt: now + 5 * 60 * 1000 })
    return Response.json({ ok: true })
  }

  async verifyCode(request) {
    if (!this.env.AUTH_PEPPER) return jsonError('Sign-in is not configured yet.', 503)
    if (!await this.consumeIpBudget(request, 'verify', 30, 60 * 60 * 1000)) return jsonError('Too many verification attempts. Try again later.', 429)
    const data = await readJson(request)
    const address = normalizeAddress(data?.address)
    const code = typeof data?.code === 'string' ? data.code.trim() : ''
    if (!address || !/^\d{6}$/.test(code)) return jsonError('Enter the six-digit code.', 400)
    if (!this.getAllowedAddresses().has(address)) return jsonError('Code invalid or expired.', 401)

    const addressKey = await this.key('address', address)
    const lockKey = `lock:${addressKey}`
    const challengeKey = `challenge:${addressKey}`
    const suppliedDigest = await this.key('otp', `${address}:${code}`)
    const verification = await this.state.storage.transaction(async (transaction) => {
      const lock = await transaction.get(lockKey) || { attempts: 0, locked: false }
      if (lock.locked) return { status: 'locked' }
      const challenge = await transaction.get(challengeKey)
      if (!challenge || challenge.expiresAt < Date.now() || challenge.digest !== suppliedDigest) {
        lock.attempts += 1
        if (lock.attempts >= 3) lock.locked = true
        await transaction.put(lockKey, lock)
        return { status: 'invalid', attempts: lock.attempts, locked: lock.locked }
      }
      await transaction.delete(challengeKey)
      await transaction.delete(lockKey)
      return { status: 'verified' }
    })
    if (verification.status === 'locked') return jsonError('Access is locked. Contact the site administrator to reset it.', 423)
    if (verification.status === 'invalid') {
      if (verification.locked) return jsonError('Three incorrect codes. Access is locked until the site administrator resets it.', 423)
      return jsonError(`Code invalid or expired. ${3 - verification.attempts} attempt${verification.attempts === 2 ? '' : 's'} remaining.`, 401)
    }

    const token = await makeSessionToken(addressKey, this.env)
    return Response.json({ ok: true }, {
      headers: { 'Set-Cookie': `ij_session=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` },
    })
  }

  async unlock(request) {
    const data = await readJson(request)
    const address = normalizeAddress(data?.address)
    if (!address || !this.getAllowedAddresses().has(address)) return jsonError('Address is not on the allowlist.', 404)
    const addressKey = await this.key('address', address)
    await Promise.all([
      this.state.storage.delete(`lock:${addressKey}`),
      this.state.storage.delete(`challenge:${addressKey}`),
    ])
    return Response.json({ ok: true })
  }

  async consumeIpBudget(request, category, limit, windowMs) {
    const ip = request.headers.get('x-ij-client-ip') || 'unknown'
    const ipKey = await this.key('ip', ip)
    const storageKey = `rate:${category}:${ipKey}`
    const now = Date.now()
    return this.state.storage.transaction(async (transaction) => {
      const budget = await transaction.get(storageKey) || { startedAt: now, count: 0 }
      if (now - budget.startedAt >= windowMs) {
        budget.startedAt = now
        budget.count = 0
      }
      if (budget.count >= limit) return false
      budget.count += 1
      await transaction.put(storageKey, budget)
      return true
    })
  }

  getAllowedAddresses() {
    try {
      const addresses = JSON.parse(this.env.ALLOWED_GATEWAY_EMAILS || '[]')
      return new Set(Array.isArray(addresses) ? addresses.map(normalizeAddress).filter(Boolean) : [])
    } catch {
      return new Set()
    }
  }

  async key(scope, value) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(this.env.AUTH_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${scope}:${value}`))
    return toBase64Url(new Uint8Array(digest))
  }
}

export class LobbyRoom {
  constructor(state) {
    this.state = state
    this.peers = new Map()
    this.sockets = new Map()
    this.hostId = ''
    this.gameId = 'chess'
    this.gameStarted = false
    this.state.blockConcurrencyWhile(async () => {
      this.gameId = await this.state.storage.get('gameId') || 'chess'
      this.gameStarted = Boolean(await this.state.storage.get('gameStarted'))
    })
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
    if (!raw || encoder.encode(raw).byteLength > MAX_MESSAGE_BYTES) {
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
      this.send(socket, { type: 'joined', hostId: this.hostId, players: this.list(), gameId: this.gameId, gameStarted: this.gameStarted })
      this.broadcast({ type: 'membership', hostId: this.hostId, players: this.list(), gameId: this.gameId, gameStarted: this.gameStarted }, peer.peerId)
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
      this.broadcast({ type: 'membership', hostId: this.hostId, players: this.list(), gameId: this.gameId, gameStarted: this.gameStarted })
    } else if (message.type === 'game' && attachment.peerId === this.hostId && ['chess', 'catan', 'ticket-to-ride', 'custom'].includes(message.gameId) && !this.gameStarted) {
      this.gameId = message.gameId
      await this.state.storage.put('gameId', this.gameId)
      this.broadcast({ type: 'game', gameId: this.gameId })
    } else if (message.type === 'start' && attachment.peerId === this.hostId && this.peers.size >= 2) {
      this.gameStarted = true
      await this.state.storage.put('gameStarted', true)
      this.broadcast({ type: 'game-started', gameId: this.gameId })
    }
  }

  async webSocketClose(socket) { return this.removePeer(socket) }
  async webSocketError(socket) { return this.removePeer(socket) }

  async removePeer(socket) {
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
    if (this.peers.size) this.broadcast({ type: 'membership', hostId: this.hostId, leftId: attachment.peerId, players: this.list(), gameId: this.gameId, gameStarted: this.gameStarted })
    else {
      this.gameId = 'chess'
      this.gameStarted = false
      await this.state.storage.deleteAll()
    }
  }

  list() { return Array.from(this.peers.values(), ({ peerId, name }) => ({ id: peerId, name })) }

  send(socket, message) {
    try { socket.send(JSON.stringify(message)) } catch { void this.removePeer(socket) }
  }

  broadcast(message, exceptId = '') {
    this.sockets.forEach((socket, peerId) => { if (peerId !== exceptId) this.send(socket, message) })
  }
}

async function verifySession(request, env) {
  if (!env.AUTH_PEPPER) return null
  const token = getCookie(request, 'ij_session')
  if (!token) return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = await sign(payload, env.AUTH_PEPPER)
  if (!constantTimeEqual(signature, expected)) return null
  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))
    return Number.isInteger(session.exp) && session.exp > Math.floor(Date.now() / 1000) && typeof session.sub === 'string' ? session : null
  } catch {
    return null
  }
}

async function hasValidSession(request, env) {
  const session = await verifySession(request, env)
  if (!session) return false
  const id = env.AUTH.idFromName('auth-state')
  const check = await env.AUTH.get(id).fetch(`https://auth-state/session/check?subject=${encodeURIComponent(session.sub)}`)
  if (!check.ok) return false
  return Boolean((await check.json()).authorized)
}

async function makeSessionToken(subject, env) {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) })))
  return `${payload}.${await sign(payload, env.AUTH_PEPPER)}`
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

function getCookie(request, key) {
  const entry = request.headers.get('Cookie')?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${key}=`))
  return entry?.slice(key.length + 1) || ''
}

function toBase64Url(bytes) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function normalizeAddress(value) {
  if (typeof value !== 'string') return ''
  const address = value.trim().toLowerCase()
  return address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : ''
}

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) return null
  try { return await request.json() } catch { return null }
}

function jsonError(message, status) { return Response.json({ error: message }, { status }) }