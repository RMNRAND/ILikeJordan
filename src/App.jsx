import { useEffect, useRef, useState } from 'react'
import ActivityTimeline from './ActivityTimeline'
import './App.css'

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || window.location.origin
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
const GAMES = [
  { id: 'chess', name: 'Chess', detail: 'Classic strategy' },
  { id: 'catan', name: 'Catan', detail: 'Trade and build' },
  { id: 'ticket-to-ride', name: 'Ticket to Ride', detail: 'Routes and railways' },
  { id: 'custom', name: 'Other game', detail: 'Bring your own rules' },
]
const makeId = () => crypto.randomUUID()
const makeCode = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.random() * 26)).join('')
const localDateTimeNow = () => {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function App() {
  const [authState, setAuthState] = useState('checking')
  const [authAddress, setAuthAddress] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [authStage, setAuthStage] = useState('address')
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [name, setName] = useState(() => localStorage.getItem('player-name') || '')
  const [roomCode, setRoomCode] = useState('')
  const [selectedGame, setSelectedGame] = useState('chess')
  const [gameStarted, setGameStarted] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [finishDialogOpen, setFinishDialogOpen] = useState(false)
  const [finishDate, setFinishDate] = useState(localDateTimeNow)
  const [finishNote, setFinishNote] = useState('')
  const [finishBusy, setFinishBusy] = useState(false)
  const [peerId, setPeerId] = useState('')
  const [players, setPlayers] = useState([])
  const [connectedPeers, setConnectedPeers] = useState([])
  const [hostId, setHostId] = useState('')
  const [linkState, setLinkState] = useState('offline')
  const [events, setEvents] = useState([])
  const [turnText, setTurnText] = useState('')
  const [notice, setNotice] = useState('')
  const socketRef = useRef(null)
  const connectionsRef = useRef(new Map())
  const channelsRef = useRef(new Map())
  const queuedIceRef = useRef(new Map())
  const peerIdRef = useRef('')
  const hostIdRef = useRef('')
  const eventsRef = useRef([])

  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((result) => setAuthState(result.authorized ? 'authorized' : 'signed-out'))
      .catch(() => {
        setAuthState('signed-out')
        setAuthMessage('Sign-in service is unavailable right now.')
      })
  }, [])

  useEffect(() => {
    peerIdRef.current = peerId
  }, [peerId])

  useEffect(() => {
    hostIdRef.current = hostId
  }, [hostId])

  useEffect(() => {
    eventsRef.current = events
  }, [events])

  useEffect(() => () => {
    socketRef.current?.close()
    connectionsRef.current.forEach((connection) => connection.close())
  }, [])

  const updatePlayers = (list) => setPlayers(list.filter((player) => player.id !== peerIdRef.current))

  const sendSignal = (target, payload) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'signal', target, payload }))
    }
  }

  const closeConnections = () => {
    connectionsRef.current.forEach((connection) => connection.close())
    connectionsRef.current.clear()
    channelsRef.current.clear()
    queuedIceRef.current.clear()
  }

  const appendEvent = (event) => {
    setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event].slice(-200))
  }

  const publishEvent = (event) => {
    appendEvent(event)
    if (peerIdRef.current === hostIdRef.current) {
      channelsRef.current.forEach((channel) => {
        if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'turn', event }))
      })
    } else {
      const channel = channelsRef.current.get(hostIdRef.current)
      if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'turn', event }))
      else setNotice('Host connection is not ready; this turn was kept only on your device.')
    }
  }

  const attachChannel = (remoteId, channel) => {
    channelsRef.current.set(remoteId, channel)
    channel.onopen = () => {
      setConnectedPeers((current) => current.includes(remoteId) ? current : [...current, remoteId])
      setLinkState('connected')
      if (peerIdRef.current === hostIdRef.current) {
        channel.send(JSON.stringify({ type: 'snapshot', events: eventsRef.current }))
      }
    }
    channel.onclose = () => {
      channelsRef.current.delete(remoteId)
      setConnectedPeers((current) => current.filter((id) => id !== remoteId))
      if (!channelsRef.current.size) setLinkState('signaling')
    }
    channel.onmessage = ({ data }) => {
      try {
        const message = JSON.parse(data)
        if (message.type === 'turn' && message.event) {
          appendEvent(message.event)
          if (peerIdRef.current === hostIdRef.current) {
            channelsRef.current.forEach((otherChannel, id) => {
              if (id !== remoteId && otherChannel.readyState === 'open') otherChannel.send(JSON.stringify(message))
            })
          }
        }
        if (message.type === 'snapshot' && Array.isArray(message.events)) {
          message.events.forEach(appendEvent)
        }
      } catch {
        setNotice('Received an unreadable turn update.')
      }
    }
  }

  const createConnection = (remoteId, offerer) => {
    if (!remoteId || remoteId === peerIdRef.current || connectionsRef.current.has(remoteId)) return
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    connectionsRef.current.set(remoteId, connection)
    connection.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(remoteId, { type: 'candidate', candidate })
    }
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') setNotice('Direct connection failed. This network may require a TURN relay.')
    }
    if (offerer) {
      attachChannel(remoteId, connection.createDataChannel('turns'))
      connection.createOffer().then((offer) => connection.setLocalDescription(offer)).then(() => {
        sendSignal(remoteId, { type: 'offer', description: connection.localDescription })
      }).catch(() => setNotice('Could not create a peer connection.'))
    } else {
      connection.ondatachannel = ({ channel }) => attachChannel(remoteId, channel)
    }
    return connection
  }

  const handleSignal = async (from, payload) => {
    let connection = connectionsRef.current.get(from)
    if (payload.type === 'offer') {
      if (!connection) connection = createConnection(from, false)
      await connection.setRemoteDescription(payload.description)
      for (const candidate of queuedIceRef.current.get(from) || []) await connection.addIceCandidate(candidate)
      queuedIceRef.current.delete(from)
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      sendSignal(from, { type: 'answer', description: connection.localDescription })
    } else if (payload.type === 'answer' && connection) {
      await connection.setRemoteDescription(payload.description)
      for (const candidate of queuedIceRef.current.get(from) || []) await connection.addIceCandidate(candidate)
      queuedIceRef.current.delete(from)
    } else if (payload.type === 'candidate') {
      if (connection?.remoteDescription) await connection.addIceCandidate(payload.candidate)
      else queuedIceRef.current.set(from, [...(queuedIceRef.current.get(from) || []), payload.candidate])
    }
  }

  const setHost = (newHostId, roster = players) => {
    setHostId(newHostId)
    hostIdRef.current = newHostId
    closeConnections()
    setConnectedPeers([])
    if (newHostId === peerIdRef.current) {
      roster.forEach((player) => createConnection(player.id, true))
    } else if (newHostId) {
      createConnection(newHostId, false)
    }
  }

  const connect = (code) => {
    if (!SIGNALING_URL) {
      setNotice('Set VITE_SIGNALING_URL to the deployed Worker WebSocket URL before creating or joining a lobby.')
      return
    }
    if (!name.trim()) {
      setNotice('Enter a player name first.')
      return
    }
    localStorage.setItem('player-name', name.trim())
    const id = makeId()
    setPeerId(id)
    peerIdRef.current = id
    setRoomCode(code)
    setLinkState('signaling')
    setNotice('')
    const endpoint = new URL(`/room/${code}`, SIGNALING_URL.replace(/^http/, 'ws'))
    const socket = new WebSocket(endpoint)
    socketRef.current = socket
    socket.onopen = () => socket.send(JSON.stringify({ type: 'join', peerId: id, name: name.trim() }))
    socket.onmessage = async ({ data }) => {
      try {
        const message = JSON.parse(data)
        if (message.type === 'joined') {
          setPeerId(id)
          updatePlayers(message.players || [])
          setHostId(message.hostId || id)
          hostIdRef.current = message.hostId || id
          setSelectedGame(message.gameId || 'chess')
          setGameStarted(Boolean(message.gameStarted))
          if ((message.hostId || id) === id) (message.players || []).forEach((player) => createConnection(player.id, true))
          else createConnection(message.hostId, false)
        }
        if (message.type === 'membership') {
          const roster = message.players || []
          const previousHostId = hostIdRef.current
          const hostLeft = message.leftId === previousHostId
          updatePlayers(roster)
          if (message.gameId) setSelectedGame(message.gameId)
          if (typeof message.gameStarted === 'boolean') setGameStarted(message.gameStarted)
          if (message.hostId && message.hostId !== hostIdRef.current) setHost(message.hostId, roster)
          else if (hostIdRef.current === id) {
            const newcomer = message.players?.find((player) => player.id !== id && !connectionsRef.current.has(player.id) && !connectedPeers.includes(player.id))
            if (newcomer) createConnection(newcomer.id, true)
          }
          if (message.leftId) {
            connectionsRef.current.get(message.leftId)?.close()
            connectionsRef.current.delete(message.leftId)
            channelsRef.current.delete(message.leftId)
          }
          if (roster.length < 2 && hostLeft) {
            leaveLobby()
            setNotice('The host left and there are not enough players to continue. Join another lobby when ready.')
          }
        }
        if (message.type === 'game') setSelectedGame(message.gameId)
        if (message.type === 'game-started') setGameStarted(true)
        if (message.type === 'game-finished') leaveLobby()
        if (message.type === 'signal') await handleSignal(message.from, message.payload)
        if (message.type === 'error') {
          setNotice(message.message || 'Could not join this lobby.')
          setLinkState('offline')
          socket.close()
        }
      } catch {
        setNotice('The lobby sent an invalid message.')
      }
    }
    socket.onclose = () => {
      if (socketRef.current !== socket) return
      socketRef.current = null
      setLinkState('offline')
      closeConnections()
      setRoomCode('')
      setPlayers([])
      setConnectedPeers([])
      setHostId('')
      setNotice('Lobby connection ended. Create or join another table.')
    }
    socket.onerror = () => setNotice('Could not reach the lobby service.')
  }

  const createLobby = () => connect(makeCode())
  const joinWithCode = (value) => {
    const code = value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 6)
    if (code.length !== 6) {
      setNotice('Lobby codes contain six letters.')
      return
    }
    connect(code)
  }

  const leaveLobby = () => {
    socketRef.current?.close()
    socketRef.current = null
    closeConnections()
    setRoomCode('')
    setGameStarted(false)
    setMenuOpen(false)
    setPeerId('')
    setPlayers([])
    setConnectedPeers([])
    setHostId('')
    setLinkState('offline')
    setNotice('')
  }

  const chooseGame = (gameId) => {
    if (!isHost || !GAMES.some((game) => game.id === gameId)) return
    setSelectedGame(gameId)
    socketRef.current?.send(JSON.stringify({ type: 'game', gameId }))
  }

  const startGame = () => {
    if (!isHost || !connectedPeers.length) return
    socketRef.current?.send(JSON.stringify({ type: 'start' }))
    setGameStarted(true)
  }

  const saveFinishedGame = async (event) => {
    event.preventDefault()
    if (!isHost || !finishDate) return
    setFinishBusy(true)
    setNotice('')
    try {
      const response = await fetch('/api/activity', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'game',
          gameId: selectedGame,
          title: GAMES.find((game) => game.id === selectedGame)?.name || 'Game',
          date: new Date(finishDate).toISOString(),
          author: name.trim(),
          note: finishNote,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save the game.')
      socketRef.current?.send(JSON.stringify({ type: 'finish' }))
      setFinishDialogOpen(false)
      setFinishNote('')
    } catch (error) {
      setNotice(error.message || 'Could not save the game.')
    } finally {
      setFinishBusy(false)
    }
  }

  const sendTurn = (event) => {
    event.preventDefault()
    const text = turnText.trim()
    if (!text || !hasTurnPath) return
    publishEvent({ id: makeId(), player: name.trim(), text, time: Date.now() })
    setTurnText('')
    setNotice('')
  }

  const copyCode = async () => {
    await navigator.clipboard.writeText(roomCode)
    setNotice('Lobby code copied.')
  }

  const requestAuthCode = async (event) => {
    event.preventDefault()
    setAuthBusy(true)
    setAuthMessage('')
    try {
      const response = await fetch('/api/auth/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: authAddress }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not request a code.')
      setAuthStage('code')
      setAuthMessage('If this address is authorized, a code will arrive shortly.')
    } catch (error) {
      setAuthMessage(error.message)
    } finally {
      setAuthBusy(false)
    }
  }

  const verifyAuthCode = async (event) => {
    event.preventDefault()
    setAuthBusy(true)
    setAuthMessage('')
    try {
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: authAddress, code: authCode }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not verify the code.')
      setAuthState('authorized')
      setNotice('')
    } catch (error) {
      setAuthMessage(error.message)
    } finally {
      setAuthBusy(false)
    }
  }

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    socketRef.current?.close()
    closeConnections()
    setRoomCode('')
    setGameStarted(false)
    setPlayers([])
    setConnectedPeers([])
    setHostId('')
    setAuthState('signed-out')
    setAuthStage('address')
    setAuthCode('')
  }

  const isHost = peerId === hostId
  const hasTurnPath = isHost ? connectedPeers.length > 0 : connectedPeers.includes(hostId)

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#home" aria-label="I Like Jordan home"><span className="mark">J</span> I LIKE JORDAN</a>
        <div className="topbar-actions">{authState === 'authorized' && <button className="logout-button" onClick={logout}>Sign out</button>}<div className="top-status"><span className={`status-dot ${linkState}`} />{linkState === 'connected' ? 'PEER LINK ACTIVE' : 'PRIVATE TABLES'}</div></div>
      </header>

      {authState !== 'authorized' ? (
        <section className="auth-page">
          <div className="auth-intro"><p className="eyebrow">PRIVATE</p><h1>Sign in</h1><p className="intro-copy">Verify your approved email address to continue.</p></div>
          <section className="entry-panel auth-panel" aria-label="Sign in">
            <div className="panel-heading"><div><p className="eyebrow">I LIKE JORDAN</p><h2>{authState === 'checking' ? 'Checking access' : authStage === 'address' ? 'Verify your access' : 'Enter your code'}</h2></div><span className="panel-index">PRIVATE</span></div>
            {authState === 'checking' ? <p className="auth-copy">Checking your sign-in…</p> : authStage === 'address' ? <form onSubmit={requestAuthCode}><label className="field-label" htmlFor="auth-address">APPROVED EMAIL ADDRESS</label><input id="auth-address" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" value={authAddress} onChange={(event) => setAuthAddress(event.target.value)} /><button className="primary-button" disabled={authBusy}>{authBusy ? 'Sending code…' : 'Send sign-in code'} <span aria-hidden="true">→</span></button></form> : <form onSubmit={verifyAuthCode}><p className="auth-copy">Enter the six-digit code sent to <strong>{authAddress}</strong>.</p><label className="field-label" htmlFor="auth-code">VERIFICATION CODE</label><input id="auth-code" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={authCode} onChange={(event) => setAuthCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /><button className="primary-button" disabled={authBusy || authCode.length !== 6}>{authBusy ? 'Checking…' : 'Verify and continue'} <span aria-hidden="true">→</span></button><button type="button" className="text-button auth-back" onClick={() => { setAuthStage('address'); setAuthCode(''); setAuthMessage('') }}>Use a different address</button></form>}
            {authMessage && <p className="notice" role="status">{authMessage}</p>}
            <p className="panel-foot">Three incorrect codes lock access until reset by the administrator.</p>
          </section>
        </section>
      ) : !roomCode ? (
        <ActivityTimeline name={name} onNameChange={(value) => { setName(value); localStorage.setItem('player-name', value) }} onCreateLobby={createLobby} onJoinLobby={joinWithCode} />
      ) : !gameStarted ? (
        <section className="room-view">
          <div className="room-head">
            <div><button className="back-button" onClick={leaveLobby}>← Leave table</button><p className="eyebrow">LOBBY / {isHost ? 'HOST' : 'PLAYER'}</p><h1>Set up the <em>table.</em></h1></div>
            <div className="room-code-wrap"><span className="field-label">INVITE PLAYERS</span><button className="room-code" onClick={copyCode} title="Copy lobby code">{roomCode}<span>▣</span></button></div>
          </div>
          {notice && <p className="notice room-notice" role="status">{notice}</p>}
          <div className="setup-columns">
            <section className="players-panel"><div className="section-heading"><h2>Players</h2><span>{players.length + 1} / 6</span></div>
              <ul className="player-list"><li className="player-row"><span className="avatar self-avatar">{name.trim().slice(0, 1).toUpperCase()}</span><span className="player-name">{name} <small>YOU</small></span><span className="role-tag">{isHost ? 'HOST' : 'PLAYER'}</span><span className="connection-dot active" /></li>
                {players.map((player) => <li className="player-row" key={player.id}><span className="avatar">{player.name.slice(0, 1).toUpperCase()}</span><span className="player-name">{player.name}</span><span className="role-tag">{player.id === hostId ? 'HOST' : 'PLAYER'}</span><span className={`connection-dot ${connectedPeers.includes(player.id) ? 'active' : ''}`} /></li>)}
              </ul>
              <div className="room-actions"><div><span className={`status-dot ${linkState}`} /><span>{linkState === 'connected' ? `${connectedPeers.length} direct link${connectedPeers.length === 1 ? '' : 's'} ready` : 'Connecting to players…'}</span></div>{isHost && players.length > 0 && <button className="text-button" onClick={() => socketRef.current?.send(JSON.stringify({ type: 'host', target: players[0].id }))}>Pass host</button>}</div>
            </section>
            <section className="game-select-panel"><div className="section-heading"><h2>Choose a game</h2><span>{isHost ? 'HOST PICKS' : 'HOST PICKING'}</span></div>
              <div className="game-options" role="radiogroup" aria-label="Select a board game">{GAMES.map((game) => <button type="button" role="radio" aria-checked={selectedGame === game.id} disabled={!isHost} className={`game-option ${selectedGame === game.id ? 'selected' : ''}`} key={game.id} onClick={() => chooseGame(game.id)}><span className="game-choice-mark">{selectedGame === game.id ? '✓' : ''}</span><span><strong>{game.name}</strong><small>{game.detail}</small></span><span className="game-arrow">↗</span></button>)}</div>
              <div className="start-area">{isHost ? <button className="primary-button start-button" disabled={!connectedPeers.length} onClick={startGame}>Start {GAMES.find((game) => game.id === selectedGame)?.name} <span aria-hidden="true">→</span></button> : <p className="waiting-copy">Waiting for the host to choose a game and start.</p>}<p className="connection-hint"><span className={`status-dot ${linkState}`} />{linkState === 'connected' ? 'Players connected directly' : 'Waiting for a direct player connection'}</p></div>
            </section>
          </div>
        </section>
      ) : (
        <section className="room-view">
          <div className="room-head">
            <div><p className="eyebrow">IN GAME / {isHost ? 'HOST' : 'PLAYER'}</p><h1>{GAMES.find((game) => game.id === selectedGame)?.name || 'Game'} <em>in progress.</em></h1></div>
            <div className="game-menu-wrap"><button className="menu-button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen}>☰ <span>Game menu</span></button>{menuOpen && <div className="game-menu" role="dialog" aria-label="In-game menu"><p className="eyebrow">TABLE MENU</p><strong>{GAMES.find((game) => game.id === selectedGame)?.name}</strong><span className="menu-player-count">{players.length + 1} players · {isHost ? 'Host' : 'Player'}</span><button onClick={() => setMenuOpen(false)}>Resume game <span>→</span></button>{isHost && <button onClick={() => { setMenuOpen(false); setFinishDate(localDateTimeNow()); setFinishDialogOpen(true) }}>Finish &amp; save game <span>✓</span></button>}<button className="menu-leave" onClick={leaveLobby}>Leave table <span>↗</span></button></div>}</div>
          </div>
          {notice && <p className="notice room-notice" role="status">{notice}</p>}
          <div className="room-columns">
            <section className="players-panel"><div className="section-heading"><h2>At the table</h2><span>{players.length + 1} / 6 PLAYERS</span></div>
              <ul className="player-list"><li className="player-row"><span className="avatar self-avatar">{name.trim().slice(0, 1).toUpperCase()}</span><span className="player-name">{name} <small>YOU</small></span><span className="role-tag">{isHost ? 'HOST' : 'PLAYER'}</span><span className="connection-dot active" /></li>
                {players.map((player) => <li className="player-row" key={player.id}><span className="avatar">{player.name.slice(0, 1).toUpperCase()}</span><span className="player-name">{player.name}</span><span className="role-tag">{player.id === hostId ? 'HOST' : 'PLAYER'}</span><span className={`connection-dot ${connectedPeers.includes(player.id) ? 'active' : ''}`} /></li>)}
              </ul>
              <div className="room-actions"><div><span className={`status-dot ${linkState}`} /><span>{linkState === 'connected' ? 'Direct link ready' : 'Waiting for peer links'}</span></div>{isHost && players.length > 0 && <button className="text-button" onClick={() => socketRef.current?.send(JSON.stringify({ type: 'host', target: players[0].id }))}>Pass host to {players[0].name}</button>}</div>
              <div className="host-note"><span className="note-icon">↻</span><p>Host disconnects? The table elects a new host and restores the shared turn log from players still connected.</p></div>
            </section>
            <section className="turn-panel"><div className="section-heading"><h2>Turn log</h2><span>{events.length} EVENTS</span></div><ol className="event-list">{events.map((item, index) => <li className="event-row" key={item.id}><span className="event-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.player}</strong><p>{item.text}</p></div><time>{new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}{!events.length && <li className="empty-log">No turns yet. Add the first move once at least one peer link is ready.</li>}</ol><form className="turn-form" onSubmit={sendTurn}><input value={turnText} maxLength={500} onChange={(event) => setTurnText(event.target.value)} placeholder={hasTurnPath ? 'Record a move or turn…' : 'Waiting for a direct connection…'} aria-label="Turn update" disabled={!hasTurnPath} /><button className="primary-button" disabled={!hasTurnPath || !turnText.trim()}>Send turn <span aria-hidden="true">↑</span></button></form></section>
          </div>
        </section>
      )}
      {finishDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !finishBusy) setFinishDialogOpen(false) }}><section className="activity-modal finish-game-modal" role="dialog" aria-modal="true" aria-labelledby="finish-game-title"><div className="modal-heading"><div><p className="eyebrow">ADD TO YOUR SHARED DAYS</p><h2 id="finish-game-title">Finish this game</h2></div><button className="icon-action close-action" aria-label="Close" onClick={() => setFinishDialogOpen(false)}>×</button></div><p className="auth-copy">Choose when this game should appear in your archive.</p><form onSubmit={saveFinishedGame}><label className="field-label" htmlFor="game-finished-date">DATE AND TIME</label><input id="game-finished-date" className="date-input" type="datetime-local" required value={finishDate} onChange={(event) => setFinishDate(event.target.value)} /><label className="field-label finish-note-label" htmlFor="game-finished-note">A NOTE (OPTIONAL)</label><textarea id="game-finished-note" className="caption-input finish-note-input" maxLength={500} placeholder="A favorite moment from the game…" value={finishNote} onChange={(event) => setFinishNote(event.target.value)} />{notice && <p className="notice" role="status">{notice}</p>}<button className="primary-button" disabled={finishBusy}>{finishBusy ? 'Saving…' : 'Save and conclude'} <span aria-hidden="true">✓</span></button></form></section></div>}
    </main>
  )
}

export default App