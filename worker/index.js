const MAX_PLAYERS = 6
const MAX_MESSAGE_BYTES = 16_384
const SESSION_SECONDS = 12 * 60 * 60
const APP_ORIGIN = 'https://ilikejordan.com'
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES_PER_UPLOAD = 5
const GAMES_ALLOWED = new Set(['chess', 'catan', 'ticket-to-ride', 'custom'])
const encoder = new TextEncoder()

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const isLocalhost = ['localhost', '127.0.0.1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !isLocalhost) return new Response('Not found', { status: 404 })
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

    if (url.pathname === '/api/activity') {
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
      const session = await getActiveSession(request, env)
      if (!session) return new Response('Authentication required', { status: 401 })
      if (request.method === 'POST' && request.headers.get('Origin') !== APP_ORIGIN) return new Response('Forbidden', { status: 403 })
      if (Number(request.headers.get('Content-Length') || 0) > 262_144) return new Response('Request too large', { status: 413 })
      const id = env.AUTH.idFromName('auth-state')
      const headers = new Headers(request.headers)
      headers.set('x-ij-subject', session.sub)
      const internalUrl = new URL(request.url)
      internalUrl.pathname = '/activity'
      return env.AUTH.get(id).fetch(new Request(internalUrl, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : request.body,
      }))
    }

    const deleteMatch = url.pathname.match(/^\/api\/activity\/([a-f0-9-]{36})$/i)
    if (deleteMatch && request.method === 'DELETE') {
      const session = await getActiveSession(request, env)
      if (!session) return new Response('Authentication required', { status: 401 })
      if (request.headers.get('Origin') !== APP_ORIGIN) return new Response('Forbidden', { status: 403 })
      const headers = new Headers(request.headers)
      headers.set('x-ij-subject', session.sub)
      return env.AUTH.get(env.AUTH.idFromName('auth-state')).fetch(new Request(`https://auth-state/activity/delete/${deleteMatch[1]}`, { method: 'POST', headers }))
    }

    const turnsMatch = url.pathname.match(/^\/api\/activity\/turns\/([a-f0-9-]{36})$/i)
    if (turnsMatch && request.method === 'GET') {
      const session = await getActiveSession(request, env)
      if (!session) return new Response('Authentication required', { status: 401 })
      const headers = new Headers(request.headers)
      headers.set('x-ij-subject', session.sub)
      return env.AUTH.get(env.AUTH.idFromName('auth-state')).fetch(new Request(`https://auth-state/activity/turns/${turnsMatch[1]}`, { headers }))
    }

    if (url.pathname === '/api/activity/layout' && request.method === 'PATCH') {
      const session = await getActiveSession(request, env)
      if (!session) return new Response('Authentication required', { status: 401 })
      if (request.headers.get('Origin') !== APP_ORIGIN) return new Response('Forbidden', { status: 403 })
      if (Number(request.headers.get('Content-Length') || 0) > 32_768) return new Response('Request too large', { status: 413 })
      const headers = new Headers(request.headers)
      headers.set('x-ij-subject', session.sub)
      const internalUrl = new URL(request.url)
      internalUrl.pathname = '/activity/layout'
      return env.AUTH.get(env.AUTH.idFromName('auth-state')).fetch(new Request(internalUrl, { method: 'PATCH', headers, body: request.body }))
    }

    if (url.pathname === '/api/activity/images' && request.method === 'POST') {
      const session = await getActiveSession(request, env)
      if (!session) return new Response('Authentication required', { status: 401 })
      if (request.headers.get('Origin') !== APP_ORIGIN) return new Response('Forbidden', { status: 403 })
      if (Number(request.headers.get('Content-Length') || 0) > 52 * 1024 * 1024) return new Response('Upload too large', { status: 413 })
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/form-data')) return new Response('Multipart form data required', { status: 415 })
      return saveActivityImages(request, env, session)
    }

    const imageMatch = url.pathname.match(/^\/api\/activity\/images\/([a-f0-9-]{36})$/i)
    if (imageMatch && request.method === 'GET') {
      const session = await getActiveSession(request, env)
      if (!session) return new Response('Authentication required', { status: 401 })
      const budget = await requestActivityReadBudget(env, session.sub, 'image')
      if (!budget.ok) return budget
      const image = await env.ACTIVITY_MEDIA.get(`activity/${imageMatch[1]}`)
      if (!image) return new Response('Not found', { status: 404 })
      return new Response(image.body, { headers: {
        'Content-Type': image.httpMetadata?.contentType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      } })
    }

    const roomMatch = url.pathname.match(/^\/room\/(main)$/)
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
    const rawPath = new URL(request.url).pathname
    const path = rawPath.replace(/^\/api(?=\/auth\/)/, '')
    if (path === '/auth/status' && request.method === 'GET') {
      if (!this.env.AUTH_PEPPER) return Response.json({ authorized: false })
      if (!await this.consumeIpBudget(request, 'status', 120, 60_000)) return jsonError('Too many access checks. Try again shortly.', 429)
      const session = await verifySession(request, this.env)
      const lock = session ? await this.state.storage.get(`lock:${session.sub}`) : null
      return Response.json({ authorized: Boolean(session && !lock?.locked) })
    }
    if (path === '/auth/request' && request.method === 'POST') return this.requestCode(request)
    if (path === '/auth/verify' && request.method === 'POST') return this.verifyCode(request)
    if (path === '/auth/logout' && request.method === 'POST') {
      return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'ij_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' } })
    }
    if (path === '/activity' && request.method === 'GET') {
      const subject = request.headers.get('x-ij-subject')
      const allowed = subject && await this.consumeSubjectBudget(`activity-list:${subject}`, 300, 24 * 60 * 60 * 1000)
      if (!allowed) return jsonError('Activity refresh limit reached for today.', 429)
      const items = await this.state.storage.list({ prefix: 'activity:', limit: 500 })
      return Response.json(Array.from(items.values()).sort((left, right) => right.date.localeCompare(left.date)))
    }
    if (path === '/activity/read-budget' && request.method === 'POST') {
      const subject = request.headers.get('x-ij-subject')
      const data = await readJson(request)
      const budgetName = data?.type === 'image' ? 'activity-image-read' : 'activity-list'
      const limit = data?.type === 'image' ? 5000 : 300
      const allowed = subject && await this.consumeSubjectBudget(`${budgetName}:${subject}`, limit, 24 * 60 * 60 * 1000)
      return allowed ? Response.json({ ok: true }) : jsonError('Daily activity read limit reached.', 429)
    }
    const deleteRoute = path.match(/^\/activity\/delete\/([a-f0-9-]{36})$/i)
    if (deleteRoute && request.method === 'POST') {
      const record = await this.state.storage.get(`activity:${deleteRoute[1]}`)
      if (!record || record.kind !== 'game') return jsonError('Saved game not found.', 404)
      await this.state.storage.delete([`activity:${record.id}`, `gameturns:${record.id}`])
      return Response.json({ ok: true })
    }
    const turnsRoute = path.match(/^\/activity\/turns\/([a-f0-9-]{36})$/i)
    if (turnsRoute && request.method === 'GET') {
      const subject = request.headers.get('x-ij-subject')
      if (!subject || !await this.consumeSubjectBudget(`activity-turns:${subject}`, 300, 24 * 60 * 60 * 1000)) return jsonError('Daily turn review limit reached.', 429)
      return Response.json(await this.state.storage.get(`gameturns:${turnsRoute[1]}`) || [])
    }
    if (path === '/activity' && request.method === 'POST') return this.createActivity(request)
    if (path === '/activity/images' && request.method === 'POST') return this.createImageActivities(request)
    if (path === '/activity/layout' && request.method === 'PATCH') return this.updateImageLayouts(request)
    if (path === '/activity/images/reserve' && request.method === 'POST') {
      const subject = request.headers.get('x-ij-subject')
      const data = await readJson(request)
      const count = Number(data?.count)
      if (!subject || !Number.isInteger(count) || count < 1 || count > MAX_IMAGES_PER_UPLOAD) return jsonError('Invalid image upload.', 400)
      if (!await this.consumeSubjectBudget(`activityrate:${subject}`, 40, 24 * 60 * 60 * 1000, count)) return jsonError('Daily activity limit reached.', 429)
      return Response.json({ ok: true })
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

  async createActivity(request) {
    const data = await readJson(request)
    const subject = request.headers.get('x-ij-subject')
    const date = validActivityDate(data?.date)
    const title = typeof data?.title === 'string' ? data.title.trim().slice(0, 80) : ''
    if (!subject || data?.kind !== 'game' || !date || !title || !GAMES_ALLOWED.has(data.gameId)) return jsonError('Invalid saved game.', 400)
    const rateKey = `activityrate:${subject}`
    const allowed = await this.consumeSubjectBudget(rateKey, 40, 24 * 60 * 60 * 1000)
    if (!allowed) return jsonError('Daily activity limit reached.', 429)
    const turns = Array.isArray(data.turns) ? data.turns.slice(0, 500).filter((turn) => typeof turn?.id === 'string' && typeof turn?.text === 'string').map((turn) => ({
      id: turn.id.slice(0, 64),
      player: safeName(turn.player),
      text: turn.text.trim().slice(0, 300),
      time: Number.isFinite(turn.time) ? turn.time : 0,
    })) : []
    const item = {
      id: crypto.randomUUID(),
      kind: 'game',
      date,
      createdAt: new Date().toISOString(),
      author: safeName(data.author),
      title,
      note: typeof data.note === 'string' ? data.note.trim().slice(0, 500) : '',
      turnCount: turns.length,
    }
    if (turns.length) await this.state.storage.put(`gameturns:${item.id}`, turns)
    await this.state.storage.put(`activity:${item.id}`, item)
    return Response.json(item, { status: 201 })
  }

  async createImageActivities(request) {
    const data = await readJson(request)
    const subject = request.headers.get('x-ij-subject')
    if (!subject || !Array.isArray(data?.items) || data.items.length < 1 || data.items.length > MAX_IMAGES_PER_UPLOAD) return jsonError('Each upload batch must contain between one and five images.', 400)
    const ids = data.items.map((item) => item?.id)
    if (ids.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) return jsonError('Invalid image metadata.', 400)
    const groupIds = new Set(data.items.map((item) => item.groupId).filter(Boolean))
    if (groupIds.size > 1) return jsonError('Images in one upload must share the same group.', 400)
    const records = data.items.map((item) => {
      const date = validActivityDate(item.date)
      const mimeType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(item.mimeType) ? item.mimeType : ''
      if (!date || !mimeType) return null
      return {
        id: item.id,
        kind: 'image',
        date,
        createdAt: new Date().toISOString(),
        author: safeName(item.author),
        caption: typeof item.caption === 'string' ? item.caption.trim().slice(0, 240) : '',
        groupId: typeof item.groupId === 'string' ? item.groupId : null,
        mimeType,
      }
    })
    if (records.some((item) => !item)) return jsonError('Invalid image metadata.', 400)
    await Promise.all(records.map((item) => this.state.storage.put(`activity:${item.id}`, item)))
    return Response.json(records, { status: 201 })
  }

  async updateImageLayouts(request) {
    const data = await readJson(request)
    const subject = request.headers.get('x-ij-subject')
    if (!subject || !Array.isArray(data?.items) || data.items.length < 1 || data.items.length > 20) return jsonError('Invalid layout update.', 400)
    if (!await this.consumeSubjectBudget(`activity-layout:${subject}`, 300, 24 * 60 * 60 * 1000)) return jsonError('Daily layout edit limit reached.', 429)
    const updated = []
    for (const entry of data.items) {
      if (typeof entry?.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(entry.id)) return jsonError('Invalid layout update.', 400)
      const record = await this.state.storage.get(`activity:${entry.id}`)
      if (!record || record.kind !== 'image') return jsonError('Photo not found.', 404)
      if (entry.layout !== undefined) record.layout = cleanLayout(entry.layout)
      if (typeof entry.caption === 'string') record.caption = entry.caption.trim().slice(0, 240)
      if (typeof entry.author === 'string') record.author = safeName(entry.author)
      if (typeof entry.postCaption === 'string') record.postCaption = entry.postCaption.trim().slice(0, 240)
      updated.push(record)
    }
    await Promise.all(updated.map((record) => this.state.storage.put(`activity:${record.id}`, record)))
    return Response.json(updated)
  }

  async consumeSubjectBudget(key, limit, windowMs, amount = 1) {
    const now = Date.now()
    return this.state.storage.transaction(async (transaction) => {
      const budget = await transaction.get(key) || { startedAt: now, count: 0 }
      if (now - budget.startedAt >= windowMs) {
        budget.startedAt = now
        budget.count = 0
      }
      if (budget.count + amount > limit) return false
      budget.count += amount
      await transaction.put(key, budget)
      return true
    })
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
    } else if (message.type === 'game' && ['chess', 'catan', 'ticket-to-ride', 'custom'].includes(message.gameId) && !this.gameStarted) {
      this.gameId = message.gameId
      await this.state.storage.put('gameId', this.gameId)
      this.broadcast({ type: 'game', gameId: this.gameId })
    } else if (message.type === 'start' && attachment.peerId === this.hostId && this.peers.size >= 2) {
      this.gameStarted = true
      await this.state.storage.put('gameStarted', true)
      this.broadcast({ type: 'game-started', gameId: this.gameId })
    } else if (message.type === 'finish' && attachment.peerId === this.hostId && this.gameStarted) {
      this.gameStarted = false
      await this.state.storage.put('gameStarted', false)
      this.broadcast({ type: 'game-finished', gameId: this.gameId })
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
  return Boolean(await getActiveSession(request, env))
}

async function getActiveSession(request, env) {
  const session = await verifySession(request, env)
  if (!session) return null
  const id = env.AUTH.idFromName('auth-state')
  const check = await env.AUTH.get(id).fetch(`https://auth-state/session/check?subject=${encodeURIComponent(session.sub)}`)
  if (!check.ok || !(await check.json()).authorized) return null
  return session
}

async function saveActivityImages(request, env, session) {
  const form = await request.formData()
  const files = form.getAll('images').filter((value) => value instanceof File)
  if (!files.length || files.length > MAX_IMAGES_PER_UPLOAD) return jsonError('Choose between one and five images.', 400)
  const grouped = form.get('group') === 'true'
  let dates = []
  try { dates = JSON.parse(String(form.get('dates') || '[]')) } catch { return jsonError('Invalid image dates.', 400) }
  if (!Array.isArray(dates) || dates.length !== files.length) return jsonError('Choose a date and time for each image.', 400)
  const normalizedDates = dates.map(validActivityDate)
  if (normalizedDates.some((date) => !date)) return jsonError('Choose a valid date and time.', 400)
  if (grouped && normalizedDates.some((date) => date !== normalizedDates[0])) return jsonError('Grouped images must share one date and time.', 400)
  if (files.some((file) => file.size < 1 || file.size > MAX_IMAGE_BYTES || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type))) {
    return jsonError('Images must be JPEG, PNG, WebP, or GIF, no larger than 4 MB each.', 413)
  }
  const subject = session.sub
  const authId = env.AUTH.idFromName('auth-state')
  const reserve = await env.AUTH.get(authId).fetch('https://auth-state/activity/images/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ij-subject': subject },
    body: JSON.stringify({ count: files.length }),
  })
  if (!reserve.ok) return new Response(await reserve.text(), { status: reserve.status, headers: { 'Content-Type': 'application/json' } })

  let captions = []
  try { captions = JSON.parse(String(form.get('captions') || '[]')) } catch { return jsonError('Invalid image captions.', 400) }
  if (!Array.isArray(captions) || captions.length !== files.length) return jsonError('Invalid image captions.', 400)
  const requestedGroupId = form.get('groupId')
  const groupId = grouped ? (typeof requestedGroupId === 'string' && /^[a-f0-9-]{36}$/i.test(requestedGroupId) ? requestedGroupId : crypto.randomUUID()) : null
  const author = safeName(form.get('author'))
  const items = []
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const id = crypto.randomUUID()
      await env.ACTIVITY_MEDIA.put(`activity/${id}`, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
      })
      items.push({
        id,
        kind: 'image',
        date: normalizedDates[index],
        author,
        caption: typeof captions[index] === 'string' ? captions[index].trim().slice(0, 240) : '',
        groupId,
        mimeType: file.type,
      })
    }
    const metadataResponse = await env.AUTH.get(authId).fetch('https://auth-state/activity/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ij-subject': subject },
      body: JSON.stringify({ items }),
    })
    if (!metadataResponse.ok) throw new Error('Could not save image metadata.')
    return new Response(await metadataResponse.text(), { status: 201, headers: { 'Content-Type': 'application/json' } })
  } catch {
    await Promise.all(items.map((item) => env.ACTIVITY_MEDIA.delete(`activity/${item.id}`)))
    return jsonError('Could not save the selected images.', 500)
  }
}

async function requestActivityReadBudget(env, subject, type) {
  const id = env.AUTH.idFromName('auth-state')
  return env.AUTH.get(id).fetch('https://auth-state/activity/read-budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ij-subject': subject },
    body: JSON.stringify({ type }),
  })
}

function validActivityDate(value) {
  if (typeof value !== 'string') return ''
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || milliseconds < Date.UTC(2000, 0, 1) || milliseconds > Date.now() + 366 * 24 * 60 * 60 * 1000) return ''
  return new Date(milliseconds).toISOString()
}

function cleanLayout(layout) {
  const number = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  const zoom = number(layout?.zoom, 1, 4, 1)
  const limit = (zoom - 1) / 2
  return {
    order: Math.round(number(layout?.order, 0, 999, 0)),
    cols: [2, 3, 6].includes(layout?.cols) ? layout.cols : 3,
    ratio: number(layout?.ratio, 0.4, 2.5, 4 / 3),
    zoom,
    tx: number(layout?.tx, -limit, limit, 0),
    ty: number(layout?.ty, -limit, limit, 0),
  }
}

function safeName(value) {
  if (typeof value !== 'string') return 'Roman & Jordan'
  return value.trim().replace(/[<>\r\n]/g, '').slice(0, 32) || 'Roman & Jordan'
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