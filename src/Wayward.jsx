import { useEffect, useMemo, useState } from 'react'
import { CENTER, SEAT_LABELS, SIZE, describe, legalSteps, replay, wallProblem } from './waywardRules'
import './Wayward.css'

const CELL = 40
const MARGIN = 20
const VIEW = SIZE * CELL + MARGIN * 2
const COLORS = ['#c0553a', '#3d7a9c', '#5f9a4a', '#8b5fa8']
const at = (value) => MARGIN + value * CELL

function wallLine(wall) {
  return wall.o === 'h'
    ? { x1: at(wall.x) + 4, x2: at(wall.x + 2) - 4, y1: at(wall.y), y2: at(wall.y) }
    : { x1: at(wall.x), x2: at(wall.x), y1: at(wall.y) + 4, y2: at(wall.y + 2) - 4 }
}

function Board({ state, targets = [], onCell, wallMode, onSegment, ghost, ghostBad }) {
  const cells = []
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const isTarget = targets.some(([tx, ty]) => tx === x && ty === y)
      cells.push(<rect key={`${x}-${y}`} className={`wy-cell${x === CENTER && y === CENTER ? ' center' : ''}${isTarget ? ' target' : ''}`} x={at(x) + 1} y={at(y) + 1} width={CELL - 2} height={CELL - 2} onClick={isTarget ? () => onCell(x, y) : undefined} />)
    }
  }
  const hits = []
  if (wallMode) {
    for (let line = 1; line < SIZE; line += 1) {
      for (let index = 0; index < SIZE; index += 1) {
        hits.push(<rect key={`h${line}-${index}`} className="wy-hit" x={at(index) + 4} y={at(line) - 6} width={CELL - 8} height={12} onClick={() => onSegment('h', Math.min(index, SIZE - 2), line)} />)
        hits.push(<rect key={`v${line}-${index}`} className="wy-hit" x={at(line) - 6} y={at(index) + 4} width={12} height={CELL - 8} onClick={() => onSegment('v', line, Math.min(index, SIZE - 2))} />)
      }
    }
  }
  return (
    <svg className="wy-board" viewBox={`0 0 ${VIEW} ${VIEW}`} role="img" aria-label="Wayward board">
      {Array.from({ length: SIZE }, (_, index) => <g key={index} className="wy-label"><text x={at(index) + CELL / 2} y={13} textAnchor="middle">{'ABCDEFGHIJK'[index]}</text><text x={10} y={at(index) + CELL / 2 + 3} textAnchor="middle">{index + 1}</text></g>)}
      {cells}
      {state.walls.map((wall, index) => <line key={index} className="wy-wall" {...wallLine(wall)} />)}
      {ghost && <line className={`wy-wall ghost${ghostBad ? ' bad' : ''}`} {...wallLine(ghost)} />}
      {state.pos.map(([x, y], seat) => (
        <g key={seat} className={`wy-token${state.turn === seat && state.winner === null ? ' active' : ''}`}>
          <circle cx={at(x) + CELL / 2} cy={at(y) + CELL / 2} r={13} fill={COLORS[seat]} />
          <text x={at(x) + CELL / 2} y={at(y) + CELL / 2 + 4} textAnchor="middle">{state.seats[seat].name.slice(0, 1).toUpperCase()}</text>
        </g>
      ))}
      {targets.map(([x, y]) => <circle key={`t${x}-${y}`} className="wy-dot" cx={at(x) + CELL / 2} cy={at(y) + CELL / 2} r={5} />)}
      {hits}
    </svg>
  )
}

function Legend({ state }) {
  return (
    <ul className="wy-legend">
      {state.seats.map((seat, index) => (
        <li key={seat.id} className={state.turn === index && state.winner === null ? 'active' : ''}>
          <span className="wy-swatch" style={{ background: COLORS[index] }} />
          <strong>{seat.name}</strong><small>{SEAT_LABELS[index]}</small>
          {state.winner === index && <em>Winner</em>}
        </li>
      ))}
    </ul>
  )
}

export function Wayward({ events, selfId, roster, canAct, onMove }) {
  const steps = useMemo(() => replay(events), [events])
  const [mode, setMode] = useState('move')
  const [pending, setPending] = useState(null)
  const state = steps?.[steps.length - 1].state
  const turnKey = state ? `${state.turn}-${state.walls.length}` : ''
  useEffect(() => { setPending(null); setMode('move') }, [turnKey])

  if (!state) return <p className="wy-status">Setting up the board…</p>
  const mySeat = state.seats.findIndex((seat) => seat.id === selfId)
  const current = state.seats[state.turn]
  const myTurn = state.winner === null && state.turn === mySeat && canAct
  const targets = myTurn && mode === 'move' ? legalSteps(state, mySeat) : []
  const problem = pending ? wallProblem(state, pending.o, pending.x, pending.y) : ''
  const absent = !roster.some((player) => player.id === current.id)
  const submit = (move) => { onMove({ ...move, by: selfId }, describe(state, move)) }

  let status = `${current.name}'s turn`
  if (state.winner !== null) status = `${state.seats[state.winner].name} reached the center`
  else if (myTurn) status = 'Your turn'
  else if (mySeat < 0) status = `Watching — ${current.name}'s turn`

  return (
    <div className="wy-game">
      <p className={`wy-status${myTurn ? ' mine' : ''}`}>{status}</p>
      <Board state={state} targets={targets} onCell={(x, y) => submit({ k: 'step', x, y })} wallMode={myTurn && mode === 'wall'} onSegment={(o, x, y) => setPending({ o, x, y })} ghost={pending} ghostBad={Boolean(problem)} />
      <Legend state={state} />
      {myTurn && (
        <div className="wy-controls">
          <div className="segmented">
            <button className={mode === 'move' ? 'active' : ''} onClick={() => { setMode('move'); setPending(null) }}>Move</button>
            <button className={mode === 'wall' ? 'active' : ''} onClick={() => setMode('wall')}>Wall</button>
          </div>
          {mode === 'wall' && <p className="wy-hint">{pending ? (problem || 'Ready to place.') : 'Tap an edge. The wall covers two squares, extending right or down.'}</p>}
          {mode === 'wall' && pending && <button className="primary-button wy-place" disabled={Boolean(problem)} onClick={() => submit({ k: 'wall', ...pending })}>Place wall</button>}
          {mode === 'move' && !targets.length && <button className="text-button" onClick={() => submit({ k: 'pass' })}>No moves — pass</button>}
        </div>
      )}
      {state.winner === null && absent && canAct && <button className="text-button wy-skip" onClick={() => onMove({ k: 'skip', by: selfId }, describe(state, { k: 'skip' }))}>{current.name} is away — skip turn</button>}
    </div>
  )
}

export function WaywardReplay({ turns }) {
  const steps = useMemo(() => replay(turns), [turns])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const last = (steps?.length || 1) - 1

  useEffect(() => {
    if (!playing) return undefined
    if (index >= last) { setPlaying(false); return undefined }
    const timer = setTimeout(() => setIndex((value) => value + 1), 700)
    return () => clearTimeout(timer)
  }, [playing, index, last])

  if (!steps) return <p className="auth-copy">No board moves were recorded for this game.</p>
  const step = steps[index]
  return (
    <div className="wy-game">
      <Board state={step.state} />
      <Legend state={step.state} />
      <p className="wy-status">{index === 0 ? 'Start of the game' : `${step.event.player} ${step.event.text}`}</p>
      <div className="wy-replay">
        <button className="text-button" onClick={() => { setPlaying(false); setIndex(0) }} disabled={index === 0} aria-label="First step">⏮</button>
        <button className="text-button" onClick={() => { setPlaying(false); setIndex(index - 1) }} disabled={index === 0} aria-label="Previous step">◀</button>
        <button className="text-button" onClick={() => { if (index >= last) setIndex(0); setPlaying((value) => !value) }}>{playing ? 'Pause' : 'Play'}</button>
        <button className="text-button" onClick={() => { setPlaying(false); setIndex(index + 1) }} disabled={index >= last} aria-label="Next step">▶</button>
        <button className="text-button" onClick={() => { setPlaying(false); setIndex(last) }} disabled={index >= last} aria-label="Last step">⏭</button>
      </div>
      <input className="wy-scrub" type="range" min="0" max={last} value={index} aria-label="Step" onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)) }} />
      <p className="wy-hint">Step {index} of {last}</p>
    </div>
  )
}
