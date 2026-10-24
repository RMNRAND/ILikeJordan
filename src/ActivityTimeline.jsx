import { useEffect, useRef, useState } from 'react'
import './ActivityTimeline.css'

const SCALES = ['D', 'M', 'Y']
const MAX_FILES = 20
const MAX_UPLOAD_BATCH = 5
const MAX_FILE_BYTES = 10 * 1024 * 1024
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

function localDateTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateKey(value) {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function ActivityTimeline({ name, onNameChange, onCreateLobby, onJoinLobby }) {
  const [items, setItems] = useState([])
  const [scale, setScale] = useState('D')
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [playOpen, setPlayOpen] = useState(false)
  const [groupTogether, setGroupTogether] = useState(true)
  const [sharedDate, setSharedDate] = useState(() => localDateTime())
  const [selectedFiles, setSelectedFiles] = useState([])
  const [previews, setPreviews] = useState([])
  const [captions, setCaptions] = useState([])
  const [individualDates, setIndividualDates] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [joinCode, setJoinCode] = useState('')
  const [touchStart, setTouchStart] = useState(null)
  const [profileMessage, setProfileMessage] = useState('')
  const fileInputRef = useRef(null)
  const previewsRef = useRef([])
  const groupIdRef = useRef(null)

  useEffect(() => {
    let active = true
    fetch('/api/activity', { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error('Could not load activity.')
        return response.json()
      })
      .then((data) => { if (active) setItems(data) })
      .catch((error) => { if (active) setMessage(error.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => () => previewsRef.current.forEach(URL.revokeObjectURL), [])

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || []).filter((file) => IMAGE_TYPES.includes(file.type) && file.size <= MAX_FILE_BYTES)
    const rejectedCount = Array.from(fileList || []).length - incoming.length
    const next = [...selectedFiles, ...incoming].slice(0, MAX_FILES)
    const accepted = next.slice(selectedFiles.length)
    const nextPreviews = [...previews, ...accepted.map((file) => URL.createObjectURL(file))]
    setSelectedFiles(next)
    previewsRef.current = nextPreviews
    setPreviews(nextPreviews)
    setCaptions((values) => next.map((_, index) => values[index] || ''))
    setIndividualDates((values) => next.map((_, index) => values[index] || sharedDate))
    if (rejectedCount) setMessage('Only JPEG, PNG, WebP, or GIF photos up to 10 MB each are supported.')
    else if (incoming.length > next.length - selectedFiles.length) setMessage(`You can add up to ${MAX_FILES} images at a time.`)
  }

  const removeFile = (index) => {
    URL.revokeObjectURL(previews[index])
    setSelectedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))
    const nextPreviews = previews.filter((_, previewIndex) => previewIndex !== index)
    previewsRef.current = nextPreviews
    setPreviews(nextPreviews)
    setCaptions((current) => current.filter((_, captionIndex) => captionIndex !== index))
    setIndividualDates((current) => current.filter((_, dateIndex) => dateIndex !== index))
  }

  const saveImages = async (event) => {
    event.preventDefault()
    if (!selectedFiles.length) return
    setUploading(true)
    setUploadProgress(0)
    setMessage('')
    const uploaded = []
    const groupId = groupTogether ? (groupIdRef.current ||= crypto.randomUUID()) : null
    try {
      const dates = selectedFiles.map((_, index) => new Date(groupTogether ? sharedDate : individualDates[index]).toISOString())
      for (let start = 0; start < selectedFiles.length; start += MAX_UPLOAD_BATCH) {
        const batchFiles = selectedFiles.slice(start, start + MAX_UPLOAD_BATCH)
        const body = new FormData()
        batchFiles.forEach((file) => body.append('images', file, file.name))
        body.append('author', name || 'A friend')
        body.append('group', String(groupTogether))
        if (groupId) body.append('groupId', groupId)
        body.append('dates', JSON.stringify(dates.slice(start, start + MAX_UPLOAD_BATCH)))
        body.append('captions', JSON.stringify(captions.slice(start, start + MAX_UPLOAD_BATCH)))
        const response = await fetch('/api/activity/images', { method: 'POST', credentials: 'same-origin', body })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not save images.')
        uploaded.push(...result)
        setItems((current) => [...result, ...current].sort((left, right) => right.date.localeCompare(left.date)))
        setUploadProgress(uploaded.length)
      }
      setSelectedFiles([])
      previewsRef.current.forEach(URL.revokeObjectURL)
      previewsRef.current = []
      setPreviews([])
      setCaptions([])
      setIndividualDates([])
      groupIdRef.current = null
      setComposerOpen(false)
    } catch (error) {
      if (uploaded.length) {
        const remaining = selectedFiles.slice(uploaded.length)
        previews.slice(0, uploaded.length).forEach(URL.revokeObjectURL)
        const remainingPreviews = previews.slice(uploaded.length)
        previewsRef.current = remainingPreviews
        setSelectedFiles(remaining)
        setPreviews(remainingPreviews)
        setCaptions((current) => current.slice(uploaded.length))
        setIndividualDates((current) => current.slice(uploaded.length))
        setMessage(`${uploaded.length} photos saved. ${remaining.length} remain selected; save again to continue. ${error.message}`)
      } else {
        setMessage(error.message || 'Could not save images.')
      }
    } finally {
      setUploading(false)
    }
  }

  const scopedItems = items

  const sections = new Map()
  scopedItems.forEach((item) => {
    const date = new Date(item.date)
    const key = scale === 'Y' ? String(date.getFullYear()) : scale === 'M' ? `${date.getFullYear()}-${date.getMonth()}` : dateKey(date)
    if (!sections.has(key)) sections.set(key, { date, items: [] })
    sections.get(key).items.push(item)
  })

  const handleScalePointerDown = (event) => setTouchStart(event.clientX)
  const handleScalePointerUp = (event) => {
    if (touchStart === null) return
    const distance = event.clientX - touchStart
    if (Math.abs(distance) > 45) {
      const currentIndex = SCALES.indexOf(scale)
      const nextIndex = Math.max(0, Math.min(SCALES.length - 1, currentIndex + (distance < 0 ? 1 : -1)))
      setScale(SCALES[nextIndex])
    }
    setTouchStart(null)
  }

  const groupedCards = (records) => {
    const groups = new Map()
    records.forEach((item) => {
      const key = item.groupId || item.id
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    })
    return Array.from(groups.values())
  }

  const createGameLobby = () => {
    if (!name.trim()) {
      setProfileMessage('Add your name before starting a table.')
      setPlayOpen(false)
      return
    }
    setProfileMessage('')
    onCreateLobby()
  }

  const joinGameLobby = (event) => {
    event.preventDefault()
    if (!name.trim()) {
      setProfileMessage('Add your name before joining a table.')
      setPlayOpen(false)
      return
    }
    setProfileMessage('')
    onJoinLobby(joinCode)
    setPlayOpen(false)
  }

  return (
    <section className="activity-home">
      <div className="activity-heading">
        <div className="activity-heading-copy">
          <p className="eyebrow">SHARED ACTIVITY</p>
          <h1>Our <em>Timeline</em></h1>
          <p className="activity-subtitle">Photos and times together.</p>
          <label className="profile-name"><span>POSTING AS</span><input autoComplete="nickname" maxLength={24} placeholder="Your name" value={name} onChange={(event) => onNameChange(event.target.value)} /></label>
        </div>
        <div className="activity-actions">
          <button className="icon-action plus-action" aria-label="Add photos" title="Add photos" onClick={() => { setMessage(''); setComposerOpen(true) }}>+</button>
          <button className="icon-action game-action" aria-label="Start or join a game" title="Start or join a game" onClick={() => setPlayOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.75c0-.77.84-1.25 1.5-.86l9.5 5.5a1 1 0 0 1 0 1.72l-9.5 5.5c-.66.39-1.5-.09-1.5-.86z" /></svg></button>
        </div>
      </div>
      {profileMessage && <p className="activity-message" role="status">{profileMessage}</p>}

      <div className="timeline-toolbar">
        <div className="timeline-period"><strong>{scale === 'D' ? 'Every day' : scale === 'M' ? 'Every month' : 'Every year'}</strong><span>{items.length} saved {items.length === 1 ? 'moment' : 'moments'}</span></div>
        <div className="scale-pill" role="group" aria-label="Timeline scale" onPointerDown={handleScalePointerDown} onPointerUp={handleScalePointerUp} onPointerCancel={() => setTouchStart(null)}>
          <span className={`scale-indicator scale-${scale.toLowerCase()}`} />
          {SCALES.map((value) => <button key={value} className={scale === value ? 'active' : ''} aria-pressed={scale === value} onClick={() => setScale(value)}>{value}</button>)}
        </div>
      </div>

      {message && <p className="activity-message" role="status">{message}</p>}
      <div className="timeline-content">
        {loading ? <p className="timeline-empty">Gathering your moments…</p> : scopedItems.length === 0 ? <div className="timeline-empty-state"><span className="empty-spark">✳</span><h2>Nothing saved here yet.</h2><p>Add a photo or save a finished game to start your shared archive.</p><button className="text-button" onClick={() => setComposerOpen(true)}>Add the first memory <span>+</span></button></div> : Array.from(sections.entries()).map(([key, section]) => (
          <section className="timeline-section" key={key}>
            <div className="timeline-section-label"><span>{scale === 'Y' ? new Intl.DateTimeFormat(undefined, { year: 'numeric' }).format(section.date) : scale === 'M' ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(section.date) : new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(section.date)}</span><span>{section.items.length} {section.items.length === 1 ? 'moment' : 'moments'}</span></div>
            <div className="memory-grid">
              {groupedCards(section.items).map((group) => {
                const first = group[0]
                if (first.kind === 'game') return <article className="game-memory" key={first.id}><div className="memory-topline"><span className="memory-type">GAME SAVED</span><time>{formatTime(first.date)}</time></div><div className="game-memory-symbol">♟</div><h2>{first.title}</h2>{first.note && <p>{first.note}</p>}<footer><span>{first.author}</span><span>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(first.date))}</span></footer></article>
                return <article className={`photo-memory ${group.length > 1 ? 'photo-memory-group' : ''}`} key={first.groupId || first.id}><div className="photo-memory-grid">{group.map((photo) => <figure key={photo.id}><img src={`/api/activity/images/${photo.id}`} alt={photo.caption || 'Shared memory'} loading="lazy" /><figcaption>{photo.caption}</figcaption></figure>)}</div><div className="photo-memory-meta"><span>{first.author}</span><time>{formatTime(first.date)}</time></div></article>
              })}
            </div>
          </section>
        ))}
      </div>
      <footer className="archive-footer"><span>I LIKE JORDAN / OUR SHARED DAYS</span><span>{items.length} SAVED MOMENTS</span></footer>

      {composerOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !uploading) setComposerOpen(false) }}><section className="activity-modal" role="dialog" aria-modal="true" aria-labelledby="memory-title"><div className="modal-heading"><div><p className="eyebrow">ADD TO THE ARCHIVE</p><h2 id="memory-title">A moment together</h2></div><button className="icon-action close-action" aria-label="Close" onClick={() => setComposerOpen(false)}>×</button></div><form onSubmit={saveImages}><button type="button" className="drop-zone" onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files) }}><span className="drop-icon">↑</span><strong>Choose photos</strong><small>Up to twenty photos, 10 MB each</small><input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} /></button>
            {selectedFiles.length > 0 && <div className="upload-settings"><label className="group-toggle"><input type="checkbox" checked={groupTogether} onChange={(event) => setGroupTogether(event.target.checked)} /><span className="toggle-track" /><span>Keep these photos together</span></label>{groupTogether && <label className="field-label" htmlFor="shared-date">DATE AND TIME</label>}{groupTogether && <input id="shared-date" className="date-input" type="datetime-local" value={sharedDate} onChange={(event) => setSharedDate(event.target.value)} />}</div>}
            <div className="upload-list">{selectedFiles.map((file, index) => <div className="upload-row" key={`${file.name}-${file.lastModified}-${index}`}><img src={previews[index]} alt="" /><div className="upload-fields"><strong>{file.name}</strong>{!groupTogether && <input aria-label={`Date and time for ${file.name}`} className="date-input" type="datetime-local" value={individualDates[index] || sharedDate} onChange={(event) => setIndividualDates((current) => current.map((value, currentIndex) => currentIndex === index ? event.target.value : value))} />}<input aria-label={`Caption for ${file.name}`} className="caption-input" maxLength={240} placeholder="Add a caption (optional)" value={captions[index] || ''} onChange={(event) => setCaptions((current) => current.map((value, currentIndex) => currentIndex === index ? event.target.value : value))} /></div><button type="button" className="remove-image" aria-label={`Remove ${file.name}`} onClick={() => removeFile(index)}>×</button></div>)}</div>
            {message && <p className="notice" role="status">{message}</p>}<div className="modal-footer"><span>{uploading ? `Saving ${uploadProgress} / ${selectedFiles.length}…` : `${selectedFiles.length} / ${MAX_FILES} photos`}</span><button className="primary-button" disabled={!selectedFiles.length || uploading}>{uploading ? 'Saving…' : 'Save moment'} <span aria-hidden="true">↑</span></button></div></form></section></div>}

      {playOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlayOpen(false) }}><section className="activity-modal play-modal" role="dialog" aria-modal="true" aria-labelledby="play-title"><div className="modal-heading"><div><p className="eyebrow">PLAY TOGETHER</p><h2 id="play-title">Find a table</h2></div><button className="icon-action close-action" aria-label="Close" onClick={() => setPlayOpen(false)}>×</button></div><p className="auth-copy">Start a new room or join with a six-letter code.</p><button className="primary-button" onClick={createGameLobby}>Create a lobby <span aria-hidden="true">↗</span></button><form className="play-join-form" onSubmit={joinGameLobby}><label className="field-label" htmlFor="activity-lobby-code">LOBBY CODE</label><div className="code-entry"><input id="activity-lobby-code" maxLength={6} autoCapitalize="characters" placeholder="ABCDEF" value={joinCode} onChange={(event) => setJoinCode(event.target.value.replace(/[^a-z]/gi, '').toUpperCase())} /><button className="join-button">Join <span aria-hidden="true">→</span></button></div></form></section></div>}
    </section>
  )
}

export default ActivityTimeline
