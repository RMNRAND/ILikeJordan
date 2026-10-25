export const SIZE = 11
export const CENTER = 5
export const SEAT_LABELS = ['North', 'South', 'West', 'East']
const START = [[5, 0], [5, 10], [0, 5], [10, 5]]
const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]]

export const label = (x, y) => `${'ABCDEFGHIJK'[x]}${y + 1}`

const key = (o, x, y) => `${o}:${x},${y}`

// A wall anchored at (x, y) covers two edge segments: h walls run right along the line above row y, v walls run down the line left of column x.
function segments(walls) {
  const set = new Set()
  walls.forEach((wall) => {
    if (wall.o === 'h') { set.add(key('h', wall.x, wall.y)); set.add(key('h', wall.x + 1, wall.y)) }
    else { set.add(key('v', wall.x, wall.y)); set.add(key('v', wall.x, wall.y + 1)) }
  })
  return set
}

function blocked(segs, x, y, nx, ny) {
  if (nx !== x) return segs.has(key('v', Math.max(x, nx), y))
  return segs.has(key('h', x, Math.max(y, ny)))
}

function neighbors(segs, x, y) {
  return DIRS
    .map(([dx, dy]) => [x + dx, y + dy])
    .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE && !blocked(segs, x, y, nx, ny))
}

function hasPath(segs, [startX, startY]) {
  const seen = new Set([`${startX},${startY}`])
  const queue = [[startX, startY]]
  while (queue.length) {
    const [x, y] = queue.shift()
    if (x === CENTER && y === CENTER) return true
    for (const [nx, ny] of neighbors(segs, x, y)) {
      const id = `${nx},${ny}`
      if (!seen.has(id)) { seen.add(id); queue.push([nx, ny]) }
    }
  }
  return false
}

export function initialState(seats) {
  const used = seats.slice(0, 4)
  return { seats: used, pos: used.map((_, index) => [...START[index]]), walls: [], turn: 0, winner: null }
}

export function legalSteps(state, seat) {
  const [x, y] = state.pos[seat]
  return neighbors(segments(state.walls), x, y)
    .filter(([nx, ny]) => !state.pos.some(([ox, oy], other) => other !== seat && ox === nx && oy === ny))
}

export function wallProblem(state, o, x, y) {
  const inBounds = o === 'h' ? x >= 0 && x <= 9 && y >= 1 && y <= 10 : x >= 1 && x <= 10 && y >= 0 && y <= 9
  if (!inBounds) return 'Walls must sit on an inner edge.'
  const cells = o === 'h' ? [[x, y - 1], [x + 1, y - 1], [x, y], [x + 1, y]] : [[x - 1, y], [x - 1, y + 1], [x, y], [x, y + 1]]
  if (state.pos.some(([px, py]) => cells.some(([cx, cy]) => cx === px && cy === py))) return 'A player is standing beside that edge.'
  for (const wall of state.walls) {
    if (wall.o === o) {
      if (o === 'h' ? wall.y === y && Math.abs(wall.x - x) <= 1 : wall.x === x && Math.abs(wall.y - y) <= 1) return 'Walls cannot overlap.'
    } else if (o === 'h' ? wall.x === x + 1 && wall.y === y - 1 : wall.x === x - 1 && wall.y === y + 1) {
      return 'Walls cannot cross.'
    }
  }
  const segs = segments([...state.walls, { o, x, y }])
  if (state.pos.some((position) => !hasPath(segs, position))) return 'That would cut a player off from the center.'
  return ''
}

export function describe(state, move) {
  if (move.k === 'step') return `moved to ${label(move.x, move.y)}`
  if (move.k === 'wall') return move.o === 'h'
    ? `placed a wall above ${label(move.x, move.y)}\u2013${label(move.x + 1, move.y)}`
    : `placed a wall left of ${label(move.x, move.y)}\u2013${label(move.x, move.y + 1)}`
  if (move.k === 'skip') return `skipped ${state.seats[state.turn]?.name || 'a player'}'s turn`
  return 'passed'
}

export function applyMove(state, move) {
  if (state.winner !== null) return { error: 'The game is over.' }
  const seat = state.turn
  const next = { ...state, pos: state.pos.map((position) => [...position]), walls: [...state.walls] }
  const advance = () => { next.turn = (seat + 1) % state.seats.length }
  if (move.k === 'skip') { advance(); return { state: next } }
  if (move.by !== state.seats[seat].id) return { error: 'Not your turn.' }
  if (move.k === 'pass') {
    if (legalSteps(state, seat).length) return { error: 'You can still move.' }
    advance()
    return { state: next }
  }
  if (move.k === 'step') {
    if (!legalSteps(state, seat).some(([x, y]) => x === move.x && y === move.y)) return { error: 'That square is not reachable.' }
    next.pos[seat] = [move.x, move.y]
    if (move.x === CENTER && move.y === CENTER) next.winner = seat
    else advance()
    return { state: next }
  }
  if (move.k === 'wall') {
    if (wallProblem(state, move.o, move.x, move.y)) return { error: 'Illegal wall.' }
    next.walls.push({ o: move.o, x: move.x, y: move.y, seat })
    advance()
    return { state: next }
  }
  return { error: 'Unknown move.' }
}

// Returns the state after each applied move since the latest setup event; steps[0] is the starting board.
export function replay(events) {
  let start = -1
  events.forEach((event, index) => { if (event.move?.k === 'setup') start = index })
  if (start < 0) return null
  let state = initialState(events[start].move.seats)
  const steps = [{ state, event: events[start] }]
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]
    if (!event.move) continue
    const result = applyMove(state, event.move)
    if (result.error) continue
    state = result.state
    steps.push({ state, event })
  }
  return steps
}
