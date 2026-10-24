import { useEffect, useRef, useState } from 'react'
import './Collage.css'

const RATIOS = [['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['4:3', 4 / 3], ['3:2', 1.5], ['16:9', 16 / 9], ['9:16', 9 / 16]]

export function layoutOf(photo, index, groupSize) {
  const layout = photo.layout || {}
  return {
    order: layout.order ?? index,
    span: layout.span ?? (groupSize > 1 ? 1 : 2),
    ratio: layout.ratio ?? 4 / 3,
    zoom: layout.zoom ?? 1,
    tx: layout.tx ?? 0,
    ty: layout.ty ?? 0,
  }
}

export function orderedPhotos(photos) {
  return photos
    .map((photo, index) => ({ photo, order: photo.layout?.order ?? index }))
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.photo)
}

const clampLayout = (layout) => {
  const zoom = Math.min(4, Math.max(1, layout.zoom))
  const limit = (zoom - 1) / 2
  return { ...layout, zoom, tx: Math.min(limit, Math.max(-limit, layout.tx)), ty: Math.min(limit, Math.max(-limit, layout.ty)) }
}

const imageStyle = (layout) => ({ transform: `translate(${layout.tx * 100}%, ${layout.ty * 100}%) scale(${layout.zoom})` })

function Tile({ photo, layout, editing, selected, gridVisible, activeCaption, onSelect, onToggle, onChange, onGesture }) {
  const tileRef = useRef(null)
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    const node = tileRef.current
    if (!editing || !selected || !node) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      onChange(clampLayout({ ...layoutRef.current, zoom: layoutRef.current.zoom * Math.exp(-event.deltaY * 0.002) }))
      onGesture()
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [editing, selected, onChange, onGesture])

  const distance = () => {
    const [a, b] = Array.from(pointers.current.values())
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  const handlePointerDown = (event) => {
    if (!editing) return
    if (!selected) { onSelect(); return }
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    gesture.current = { start: layoutRef.current, distance: pointers.current.size === 2 ? distance() : 0, origin: { x: event.clientX, y: event.clientY } }
    onGesture()
  }

  const handlePointerMove = (event) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const rect = tileRef.current.getBoundingClientRect()
    const { start } = gesture.current
    if (pointers.current.size >= 2) {
      if (!gesture.current.distance) gesture.current = { ...gesture.current, start: layoutRef.current, distance: distance() }
      onChange(clampLayout({ ...layoutRef.current, zoom: start.zoom * (distance() / gesture.current.distance) }))
    } else {
      const { origin } = gesture.current
      onChange(clampLayout({ ...start, tx: start.tx + (event.clientX - origin.x) / rect.width, ty: start.ty + (event.clientY - origin.y) / rect.height }))
    }
    onGesture()
  }

  const handlePointerUp = (event) => {
    pointers.current.delete(event.pointerId)
    const [remaining] = Array.from(pointers.current.values())
    gesture.current = remaining ? { start: layoutRef.current, distance: 0, origin: remaining } : null
    onGesture()
  }

  return (
    <figure
      ref={tileRef}
      className={`collage-tile${editing ? ' editing' : ''}${selected ? ' selected' : ''}${activeCaption ? ' active' : ''}`}
      style={{ gridColumn: `span ${layout.span}`, aspectRatio: layout.ratio }}
      onClick={editing ? undefined : onToggle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <img src={`/api/activity/images/${photo.id}`} alt={photo.caption || 'Shared memory'} draggable={false} style={imageStyle(layout)} />
      {selected && <div className={`crop-grid${gridVisible ? ' visible' : ''}`} aria-hidden="true" />}
      {!editing && photo.caption && <figcaption>{photo.caption}</figcaption>}
    </figure>
  )
}

function Collage({ photos, startEditing, onSave, onClose }) {
  const [editing, setEditing] = useState(startEditing)
  const [draft, setDraft] = useState(() => orderedPhotos(photos).map((photo, index, all) => ({ id: photo.id, caption: photo.caption || '', layout: layoutOf(photo, index, all.length) })))
  const [selectedId, setSelectedId] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [gridVisible, setGridVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const hideTimer = useRef(null)

  useEffect(() => () => clearTimeout(hideTimer.current), [])
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saving, onClose])

  const showGrid = () => {
    setGridVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setGridVisible(false), 700)
  }

  const photoById = new Map(photos.map((photo) => [photo.id, photo]))
  const selected = draft.find((entry) => entry.id === selectedId)
  const update = (id, patch) => setDraft((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry))
  const updateLayout = (id, patch) => setDraft((current) => current.map((entry) => entry.id === id ? { ...entry, layout: clampLayout({ ...entry.layout, ...patch }) } : entry))

  const move = (direction) => {
    const index = draft.findIndex((entry) => entry.id === selectedId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= draft.length) return
    const next = [...draft]
    ;[next[index], next[target]] = [next[target], next[index]]
    setDraft(next.map((entry, order) => ({ ...entry, layout: { ...entry.layout, order } })))
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave(draft.map((entry, order) => ({ id: entry.id, caption: entry.caption, layout: { ...entry.layout, order } })))
      setSelectedId(null)
      setEditing(false)
    } catch (failure) {
      setError(failure.message || 'Could not save the collage.')
    } finally {
      setSaving(false)
    }
  }

  const cancelEdit = () => {
    setDraft(orderedPhotos(photos).map((photo, index, all) => ({ id: photo.id, caption: photo.caption || '', layout: layoutOf(photo, index, all.length) })))
    setSelectedId(null)
    setEditing(false)
    setError('')
  }

  return (
    <div className="collage-overlay" role="dialog" aria-modal="true" aria-label="Photo collage">
      <header className="collage-header">
        <strong>{editing ? 'Edit collage' : 'Collage'}</strong>
        <div className="collage-header-actions">
          {editing ? (
            <>
              <button className="text-button" onClick={cancelEdit} disabled={saving}>Cancel</button>
              <button className="primary-button collage-save" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </>
          ) : (
            <button className="text-button" onClick={() => setEditing(true)}>Edit</button>
          )}
          <button className="icon-action close-action" aria-label="Close" onClick={onClose} disabled={saving}>×</button>
        </div>
      </header>

      <div className="collage-scroll" onClick={(event) => { if (event.target === event.currentTarget) { setSelectedId(null); setActiveId(null) } }}>
        <div className="collage-grid">
          {draft.map((entry) => (
            <Tile
              key={entry.id}
              photo={{ ...photoById.get(entry.id), caption: editing ? entry.caption : photoById.get(entry.id).caption }}
              layout={entry.layout}
              editing={editing}
              selected={editing && selectedId === entry.id}
              gridVisible={gridVisible}
              activeCaption={!editing && activeId === entry.id}
              onSelect={() => setSelectedId(entry.id)}
              onToggle={() => setActiveId((current) => current === entry.id ? null : entry.id)}
              onChange={(layout) => updateLayout(entry.id, layout)}
              onGesture={showGrid}
            />
          ))}
        </div>
      </div>

      {editing && (
        <div className="collage-panel">
          {error && <p className="notice" role="status">{error}</p>}
          {!selected ? <p className="collage-hint">Tap a photo to edit it. Drag to move, pinch or scroll to zoom.</p> : (
            <>
              <div className="collage-row">
                <span>Width</span>
                <div className="segmented">
                  <button className={selected.layout.span === 1 ? 'active' : ''} onClick={() => updateLayout(selected.id, { span: 1 })}>Half</button>
                  <button className={selected.layout.span === 2 ? 'active' : ''} onClick={() => updateLayout(selected.id, { span: 2 })}>Full</button>
                </div>
                <button className="text-button" onClick={() => move(-1)} aria-label="Move earlier">↑ Earlier</button>
                <button className="text-button" onClick={() => move(1)} aria-label="Move later">↓ Later</button>
              </div>
              <div className="collage-row">
                <span>Shape</span>
                <div className="segmented scrollable">
                  {RATIOS.map(([label, value]) => <button key={label} className={Math.abs(selected.layout.ratio - value) < 0.01 ? 'active' : ''} onClick={() => { updateLayout(selected.id, { ratio: value }); showGrid() }}>{label}</button>)}
                </div>
              </div>
              <div className="collage-row">
                <span>Zoom</span>
                <input type="range" min="1" max="4" step="0.01" value={selected.layout.zoom} aria-label="Zoom" onChange={(event) => { updateLayout(selected.id, { zoom: Number(event.target.value) }); showGrid() }} />
                <button className="text-button" onClick={() => updateLayout(selected.id, { zoom: 1, tx: 0, ty: 0 })}>Reset</button>
              </div>
              <input className="caption-input" maxLength={240} placeholder="Caption (optional)" aria-label="Caption" value={selected.caption} onChange={(event) => update(selected.id, { caption: event.target.value })} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default Collage
