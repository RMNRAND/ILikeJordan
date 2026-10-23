import { useEffect, useRef, useState } from 'react'
import './App.css'

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'https://tabletalk-signaling.k2tfbvzgpm.workers.dev'
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
const makeId = () => crypto.randomUUID()
const makeCode = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.random() * 26)).join('')

function App() {
  const [name, setName] = useState(() => localStorage.getItem('player-name') || '')
  const [codeInput, setCodeInput] = useState('')
  const [roomCode, setRoomCode] = useState('')
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
      if (connection) connection.close()
      connection = createConnection(from, false)
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
    const endpoint = new URL(`/room/${code}`, SIGNALING_URL)
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
          if ((message.hostId || id) === id) (message.players || []).forEach((player) => createConnection(player.id, true))
          else createConnection(message.hostId, false)
        }
        if (message.type === 'membership') {
          const roster = message.players || []
          if (roster.length < 2) {
            leaveLobby()
            setNotice('Not enough connected players to continue. You can create or join another lobby.')
            return
          }
          updatePlayers(roster)
          if (message.hostId && message.hostId !== hostIdRef.current) setHost(message.hostId, roster)
          else if (hostIdRef.current === id) {
            const newcomer = message.players?.find((player) => !connectionsRef.current.has(player.id) && !connectedPeers.includes(player.id))
            if (newcomer) createConnection(newcomer.id, true)
          }
          if (message.leftId) {
            connectionsRef.current.get(message.leftId)?.close()
            connectionsRef.current.delete(message.leftId)
            channelsRef.current.delete(message.leftId)
          }
        }
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
  const joinLobby = (event) => {
    event.preventDefault()
    const code = codeInput.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 6)
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
    setPeerId('')
    setPlayers([])
    setConnectedPeers([])
    setHostId('')
    setLinkState('offline')
    setNotice('')
  }

  const sendTurn = (event) => {
    event.preventDefault()
    const text = turnText.trim()
    if (!text || linkState !== 'connected') return
    publishEvent({ id: makeId(), player: name.trim(), text, time: Date.now() })
    setTurnText('')
    setNotice('')
  }

  const copyCode = async () => {
    await navigator.clipboard.writeText(roomCode)
    setNotice('Lobby code copied.')
  }

  const isHost = peerId === hostId

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#home" aria-label="Tabletalk home"><span className="mark">T</span> TABLETALK</a>
        <div className="top-status"><span className={`status-dot ${linkState}`} />{linkState === 'connected' ? 'PEER LINK ACTIVE' : 'PRIVATE TABLES'}</div>
      </header>

      {!roomCode ? (
        <section className="lobby-home" id="home">
          <div className="intro">
            <p className="eyebrow">A TABLE FOR YOUR PEOPLE</p>
            <h1>Make a move.<br /><em>Keep the table.</em></h1>
            <p className="intro-copy">A lightweight room for turn-based games. Your moves travel directly between players, not through a game server.</p>
            <div className="network-note"><span className="note-icon">↗</span><span><strong>Peer to peer</strong><br />A small lobby service matches players. Board-game turns go direct.</span></div>
          </div>
          <section className="entry-panel" aria-label="Lobby controls">
            <div className="panel-heading"><div><p className="eyebrow">GET TO THE TABLE</p><h2>Start playing</h2></div><span className="panel-index">01 / 02</span></div>
            <label className="field-label" htmlFor="player-name">YOUR NAME</label>
            <input id="player-name" autoComplete="nickname" maxLength={24} placeholder="e.g. Jordan" value={name} onChange={(event) => setName(event.target.value)} />
            <button className="primary-button" onClick={createLobby}>Create a lobby <span aria-hidden="true">↗</span></button>
            <div className="rule"><span>OR JOIN A TABLE</span></div>
            <form onSubmit={joinLobby} className="join-form">
              <label className="field-label" htmlFor="lobby-code">SIX-LETTER CODE</label>
              <div className="code-entry"><input id="lobby-code" maxLength={6} autoCapitalize="characters" autoComplete="off" placeholder="ABCDEF" value={codeInput} onChange={(event) => setCodeInput(event.target.value.replace(/[^a-z]/gi, '').toUpperCase())} /><button className="join-button" aria-label="Join lobby">Join <span aria-hidden="true">→</span></button></div>
            </form>
            {notice && <p className="notice" role="status">{notice}</p>}
            <p className="panel-foot">No account needed <span>·</span> Up to six players</p>
          </section>
          <div className="home-footer"><span>TABLETALK / 001</span><span>THE GAME STAYS WITH YOU</span><span>SCROLL NOT REQUIRED</span></div>
        </section>
      ) : (
        <section className="room-view">
          <div className="room-head">
            <div><button className="back-button" onClick={leaveLobby}>← Leave table</button><p className="eyebrow">LOBBY / {isHost ? 'HOST' : 'PLAYER'}</p><h1>You're at the <em>table.</em></h1></div>
            <div className="room-code-wrap"><span className="field-label">SHARE THIS CODE</span><button className="room-code" onClick={copyCode} title="Copy lobby code">{roomCode}<span>▣</span></button></div>
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
            <section className="turn-panel"><div className="section-heading"><h2>Turn log</h2><span>{events.length} EVENTS</span></div><ol className="event-list">{events.map((item, index) => <li className="event-row" key={item.id}><span className="event-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.player}</strong><p>{item.text}</p></div><time>{new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}{!events.length && <li className="empty-log">No turns yet. Add the first move when the table is connected.</li>}</ol><form className="turn-form" onSubmit={sendTurn}><input value={turnText} maxLength={500} onChange={(event) => setTurnText(event.target.value)} placeholder="Record a move or turn…" aria-label="Turn update" disabled={linkState !== 'connected'} /><button className="primary-button" disabled={linkState !== 'connected' || !turnText.trim()}>Send turn <span aria-hidden="true">↑</span></button></form></section>
          </div>
        </section>
      )}
    </main>
  )
}

export default App