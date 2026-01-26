// ===========================================
// DOM Elements
// ===========================================
const piano = document.getElementById('piano')
const eventLog = document.getElementById('eventLog')
const statusDot = document.getElementById('statusDot')
const statusText = document.getElementById('statusText')

// ===========================================
// Piano Keyboard Setup
// ===========================================
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteName(note) {
    const octave = Math.floor(note / 12) - 1
    const name = noteNames[note % 12]
    return `${name}${octave}`
}

// Build piano - full 88-key range (A0 to C8)
const startNote = 21  // A0 (lowest on 88-key piano)
const endNote = 108   // C8 (highest on 88-key piano)
const keys = {}

let whiteKeyIndex = 0
for (let note = startNote; note <= endNote; note++) {
    const noteInOctave = note % 12
    const isBlack = [1, 3, 6, 8, 10].includes(noteInOctave)

    const key = document.createElement('div')
    key.dataset.note = note

    if (isBlack) {
        key.className = 'black-key'
        key.style.left = `${(whiteKeyIndex * 18) - 6}px`
    } else {
        key.className = 'white-key'
        whiteKeyIndex++
    }

    keys[note] = key
    piano.appendChild(key)
}

// ===========================================
// Piano Interaction (Click/Touch)
// ===========================================
const pressedKeys = new Set()

function sendNoteOn(note) {
    if (ws && ws.readyState === WebSocket.OPEN && !pressedKeys.has(note)) {
        pressedKeys.add(note)
        ws.send(JSON.stringify({ type: 'playNote', note, velocity: 100, on: true }))
        activateNote(note)
    }
}

function sendNoteOff(note) {
    if (ws && ws.readyState === WebSocket.OPEN && pressedKeys.has(note)) {
        pressedKeys.delete(note)
        ws.send(JSON.stringify({ type: 'playNote', note, on: false }))
        deactivateNote(note)
    }
}

// Mouse handlers
piano.addEventListener('mousedown', (e) => {
    const key = e.target.closest('.white-key, .black-key')
    if (key) {
        e.preventDefault()
        sendNoteOn(parseInt(key.dataset.note))
    }
})

document.addEventListener('mouseup', () => {
    pressedKeys.forEach(note => sendNoteOff(note))
})

piano.addEventListener('mouseleave', () => {
    pressedKeys.forEach(note => sendNoteOff(note))
})

piano.addEventListener('mouseover', (e) => {
    if (e.buttons === 1) {
        const key = e.target.closest('.white-key, .black-key')
        if (key) {
            const note = parseInt(key.dataset.note)
            pressedKeys.forEach(n => { if (n !== note) sendNoteOff(n) })
            sendNoteOn(note)
        }
    }
})

// Touch handlers for mobile
piano.addEventListener('touchstart', (e) => {
    e.preventDefault()
    for (const touch of e.changedTouches) {
        const key = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.white-key, .black-key')
        if (key) sendNoteOn(parseInt(key.dataset.note))
    }
}, { passive: false })

piano.addEventListener('touchend', (e) => {
    e.preventDefault()
    for (const touch of e.changedTouches) {
        const key = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.white-key, .black-key')
        if (key) sendNoteOff(parseInt(key.dataset.note))
    }
}, { passive: false })

piano.addEventListener('touchmove', (e) => {
    e.preventDefault()
    const currentNotes = new Set()
    for (const touch of e.touches) {
        const key = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.white-key, .black-key')
        if (key) currentNotes.add(parseInt(key.dataset.note))
    }
    pressedKeys.forEach(note => { if (!currentNotes.has(note)) sendNoteOff(note) })
    currentNotes.forEach(note => sendNoteOn(note))
}, { passive: false })

// ===========================================
// Note Visualization
// ===========================================
const activeNotes = new Set()
let isPlaying = false
const playbackNotes = new Set()

function activateNote(note, isPlayback = false) {
    if (keys[note]) {
        if (isPlayback) {
            keys[note].classList.add('playback')
            playbackNotes.add(note)
        } else {
            keys[note].classList.add('active')
            activeNotes.add(note)
        }
    }
}

function deactivateNote(note, isPlayback = false) {
    if (keys[note]) {
        if (isPlayback) {
            keys[note].classList.remove('playback')
            playbackNotes.delete(note)
        } else {
            keys[note].classList.remove('active')
            activeNotes.delete(note)
        }
    }
}

function clearPlaybackNotes() {
    playbackNotes.forEach(note => {
        if (keys[note]) keys[note].classList.remove('playback')
    })
    playbackNotes.clear()
}

// ===========================================
// Event Log
// ===========================================
const maxLogEntries = 100

function addLogEntry(event) {
    const entry = document.createElement('div')
    entry.className = 'event'

    const time = new Date(event.timestamp).toLocaleTimeString()
    let details = ''

    if (event.type === 'noteon' || event.type === 'noteoff') {
        details = `<span class="event-note">${noteName(event.note)}</span> <span class="event-vel">vel:${event.velocity}</span>`
    } else if (event.type === 'cc') {
        details = `CC${event.control} = ${event.value}`
    } else if (event.type === 'pitchbend') {
        details = `bend: ${event.value}`
    }

    entry.innerHTML = `
        <span class="event-time">${time}</span>
        <span class="event-type">${event.type}</span>
        ${details}
    `

    eventLog.insertBefore(entry, eventLog.firstChild)

    while (eventLog.children.length > maxLogEntries) {
        eventLog.removeChild(eventLog.lastChild)
    }
}

// ===========================================
// Timeline / Piano Roll
// ===========================================
const timelineCanvas = document.getElementById('timelineCanvas')
const timelineContainer = document.getElementById('timelineContainer')
const timelineSelection = document.getElementById('timelineSelection')
const timelineRange = document.getElementById('timelineRange')
const timelineStart = document.getElementById('timelineStart')
const timelineEnd = document.getElementById('timelineEnd')
const timelineSelectionInfo = document.getElementById('timelineSelectionInfo')
const ctx = timelineCanvas.getContext('2d')

let timelineEvents = []
let timelineStartTime = 0
let timelineEndTime = 0
let selectionStart = null
let selectionEnd = null
let isDragging = false
let playbackActive = false
let playbackTime = null
let viewingSession = false

const minNote = 21
const maxNote = 108
const noteRange = maxNote - minNote + 1

async function fetchTimelineEvents(start, end) {
    try {
        const res = await fetch(`/api/events/range?start=${start}&end=${end}`)
        timelineEvents = await res.json()
        drawTimeline()
    } catch (err) {
        console.error('Failed to fetch timeline data:', err)
    }
}

async function ensureTimelineDataCovers(start, end) {
    if (timelineEvents.length > 0 && timelineEvents[0].timestamp <= start && timelineEvents[timelineEvents.length - 1].timestamp >= end) return
    await fetchTimelineEvents(start, end)
}

function resizeCanvas() {
    const rect = timelineContainer.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    timelineCanvas.width = rect.width * dpr
    timelineCanvas.height = rect.height * dpr
    timelineCanvas.style.width = rect.width + 'px'
    timelineCanvas.style.height = rect.height + 'px'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    drawTimeline()
}

async function loadTimelineData() {
    const minutes = parseInt(timelineRange.value)
    const now = Date.now()
    timelineEndTime = now
    timelineStartTime = now - minutes * 60 * 1000
    await fetchTimelineEvents(timelineStartTime, timelineEndTime)
    updateTimeLabels()
    drawTimeline()
}

function updateTimeLabels() {
    timelineStart.textContent = new Date(timelineStartTime).toLocaleTimeString()
    timelineEnd.textContent = new Date(timelineEndTime).toLocaleTimeString()
}

function drawTimeline() {
    const width = timelineContainer.clientWidth
    const height = timelineContainer.clientHeight
    const duration = timelineEndTime - timelineStartTime
    ctx.clearRect(0, 0, width, height)

    // Draw background grid (pitch lines)
    ctx.strokeStyle = '#1a1a2e'
    ctx.lineWidth = 1
    for (let i = 0; i <= 12; i++) {
        const y = (i / 12) * height
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
        ctx.stroke()
    }

    // Draw time grid (vertical lines every minute)
    ctx.strokeStyle = '#252550'
    const minuteMs = 60 * 1000
    const startMinute = Math.ceil(timelineStartTime / minuteMs) * minuteMs
    for (let t = startMinute; t < timelineEndTime; t += minuteMs) {
        const x = ((t - timelineStartTime) / duration) * width
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
    }

    // Build note on/off pairs for drawing bars
    const activeNotesMap = new Map()
    const noteBars = []
    for (const event of timelineEvents) {
        if (event.type === 'noteon' && event.velocity > 0) {
            activeNotesMap.set(event.note, { start: event.timestamp, velocity: event.velocity })
        } else if (event.type === 'noteoff' || (event.type === 'noteon' && event.velocity === 0)) {
            const noteStart = activeNotesMap.get(event.note)
            if (noteStart) {
                noteBars.push({
                    note: event.note,
                    start: noteStart.start,
                    end: event.timestamp,
                    velocity: noteStart.velocity
                })
                activeNotesMap.delete(event.note)
            }
        }
    }
    for (const [note, data] of activeNotesMap) {
        noteBars.push({ note, start: data.start, end: timelineEndTime, velocity: data.velocity })
    }

    // Draw note bars
    const noteHeight = height / noteRange
    for (const bar of noteBars) {
        const x1 = ((bar.start - timelineStartTime) / duration) * width
        const x2 = ((bar.end - timelineStartTime) / duration) * width
        const y = height - ((bar.note - minNote + 1) / noteRange) * height
        const brightness = 50 + (bar.velocity / 127) * 50
        const isBlack = [1, 3, 6, 8, 10].includes(bar.note % 12)
        ctx.fillStyle = isBlack ? `hsl(340, 80%, ${brightness}%)` : `hsl(160, 70%, ${brightness}%)`
        const barWidth = Math.max(2, x2 - x1)
        ctx.fillRect(x1, y, barWidth, Math.max(1, noteHeight - 1))
    }

    // Draw selection overlay
    if (selectionStart !== null && selectionEnd !== null) {
        const selX1 = ((Math.min(selectionStart, selectionEnd) - timelineStartTime) / duration) * width
        const selX2 = ((Math.max(selectionStart, selectionEnd) - timelineStartTime) / duration) * width
        ctx.save()
        ctx.globalAlpha = 0.3
        ctx.fillStyle = '#e94560'
        ctx.fillRect(selX1, 0, selX2 - selX1, height)
        ctx.restore()
    }

    // Draw playback line
    if (playbackActive && playbackTime != null) {
        const x = ((playbackTime - timelineStartTime) / duration) * width
        if (x >= 0 && x <= width) {
            ctx.save()
            ctx.strokeStyle = '#FFD700'
            ctx.lineWidth = 3
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, height)
            ctx.stroke()
            ctx.restore()
        }
    }
}

function timeToX(time) {
    const width = timelineContainer.clientWidth
    const duration = timelineEndTime - timelineStartTime
    return ((time - timelineStartTime) / duration) * width
}

function xToTime(x) {
    const width = timelineContainer.clientWidth
    const duration = timelineEndTime - timelineStartTime
    return timelineStartTime + (x / width) * duration
}

function updateSelection() {
    if (selectionStart !== null && selectionEnd !== null) {
        const startTime = Math.min(selectionStart, selectionEnd)
        const endTime = Math.max(selectionStart, selectionEnd)

        const x1 = timeToX(startTime)
        const x2 = timeToX(endTime)
        timelineSelection.style.left = x1 + 'px'
        timelineSelection.style.width = (x2 - x1) + 'px'
        timelineSelection.classList.add('active')

        const start = new Date(startTime)
        const end = new Date(endTime)
        const durationSec = Math.round((endTime - startTime) / 1000)
        const mins = Math.floor(durationSec / 60)
        const secs = durationSec % 60
        timelineSelectionInfo.textContent = `Selected: ${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${mins}:${secs.toString().padStart(2, '0')})`

        window.selectedTimeRange = { start: startTime, end: endTime }
    } else {
        timelineSelection.classList.remove('active')
        timelineSelectionInfo.textContent = ''
        window.selectedTimeRange = null
    }
}

function normalizeSelection() {
    if (selectionStart !== null && selectionEnd !== null) {
        const s = Math.min(selectionStart, selectionEnd)
        const e = Math.max(selectionStart, selectionEnd)
        selectionStart = s
        selectionEnd = e
    }
}

// Timeline mouse handlers
let dragMode = null
const handleLeft = document.getElementById('handleLeft')
const handleRight = document.getElementById('handleRight')

handleLeft.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    e.preventDefault()
    normalizeSelection()
    dragMode = 'left'
    isDragging = true
})

handleRight.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    e.preventDefault()
    normalizeSelection()
    dragMode = 'right'
    isDragging = true
})

timelineContainer.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('timeline-handle')) return

    const rect = timelineContainer.getBoundingClientRect()
    const x = e.clientX - rect.left
    selectionStart = xToTime(x)
    selectionEnd = selectionStart
    dragMode = 'new'
    isDragging = true
    updateSelection()
})

document.addEventListener('mousemove', (e) => {
    if (!isDragging) return
    const rect = timelineContainer.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const time = xToTime(x)

    if (dragMode === 'new') {
        selectionEnd = time
    } else if (dragMode === 'left') {
        selectionStart = Math.min(time, selectionEnd - 1000)
    } else if (dragMode === 'right') {
        selectionEnd = Math.max(time, selectionStart + 1000)
    }
    updateSelection()
})

document.addEventListener('mouseup', () => {
    isDragging = false
    dragMode = null
})

function selectSessionRange(startTime, endTime) {
    viewingSession = true
    selectionStart = startTime
    selectionEnd = endTime
    drawTimeline()
    updateSelection()
}

// Timeline button handlers
document.getElementById('timelineRefresh').addEventListener('click', () => {
    viewingSession = false
    loadTimelineData()
})

document.getElementById('timelineClear').addEventListener('click', () => {
    selectionStart = null
    selectionEnd = null
    updateSelection()
})

document.getElementById('timelinePlaySelection').addEventListener('click', async () => {
    if (selectionStart === null || selectionEnd === null) {
        alert('Select a range first by clicking and dragging on the timeline')
        return
    }

    const start = Math.min(selectionStart, selectionEnd)
    const end = Math.max(selectionStart, selectionEnd)
    const output = document.getElementById('outputSelect').value || undefined

    try {
        await fetch('/api/playback/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start, end, output }),
        })
    } catch (err) {
        console.error('Playback failed:', err)
    }
})

document.getElementById('timelineSaveNew').addEventListener('click', async () => {
    if (selectionStart === null || selectionEnd === null) {
        alert('Select a range first by clicking and dragging on the timeline')
        return
    }

    const start = Math.min(selectionStart, selectionEnd)
    const end = Math.max(selectionStart, selectionEnd)
    const performer = prompt('Performer name (optional):')
    const songName = prompt('Song name (optional):')

    const session = {
        start_time: start,
        end_time: end,
        performer: performer || null,
        song_name: songName || null,
    }

    try {
        const res = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
        })

        if (res.ok) {
            loadSessions()
            alert('Session saved!')
        }
    } catch (err) {
        console.error('Failed to save session:', err)
        alert('Failed to save session')
    }
})

timelineRange.addEventListener('change', () => {
    viewingSession = false
    loadTimelineData()
})

function addEventToTimeline(event) {
    if (viewingSession) return

    timelineEvents.push(event)
    if (event.timestamp >= timelineStartTime && event.timestamp <= timelineEndTime + 60000) {
        timelineEndTime = Math.max(timelineEndTime, Date.now())
        drawTimeline()
    }
}

// Initialize timeline
window.addEventListener('resize', resizeCanvas)
resizeCanvas()
loadTimelineData()

// Refresh timeline periodically
setInterval(() => {
    if (viewingSession) return
    if (Date.now() > timelineEndTime) {
        loadTimelineData()
    } else {
        drawTimeline()
    }
}, 5000)

// ===========================================
// WebSocket Connection
// ===========================================
let ws
let reconnectTimeout
let reconnectAttempts = 0
const maxReconnectDelay = 30000

function connect() {
    clearTimeout(reconnectTimeout)

    if (ws) {
        ws.onclose = null
        ws.close()
    }

    statusDot.className = 'status-dot'
    statusText.textContent = 'Connecting...'

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws`)

    ws.onopen = () => {
        statusDot.className = 'status-dot connected recording'
        statusText.textContent = 'Recording'
        reconnectAttempts = 0
    }

    ws.onclose = () => {
        statusDot.className = 'status-dot'
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay)
        reconnectAttempts++
        statusText.textContent = `Reconnecting in ${Math.round(delay / 1000)}s...`
        reconnectTimeout = setTimeout(connect, delay)
    }

    ws.onerror = () => {}

    ws.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data)
            if (data.type === 'midi') {
                handleMidiEvent(data.event)
            } else if (data.type === 'playback') {
                handlePlaybackStatus(data)
            } else if (data.type === 'playback-event') {
                handlePlaybackEvent(data)
            }
        } catch (err) {
            console.error('WebSocket message error:', err)
        }
    }
}

function handleMidiEvent(event) {
    if (event.type === 'noteon' && event.velocity > 0) {
        activateNote(event.note, false)
    } else if (event.type === 'noteoff' || (event.type === 'noteon' && event.velocity === 0)) {
        deactivateNote(event.note, false)
    }
    addLogEntry(event)
    addEventToTimeline(event)
}

function handlePlaybackStatus(data) {
    const progressContainer = document.getElementById('progressContainer')
    const btnPlayback = document.getElementById('btnPlayback')
    const btnStop = document.getElementById('btnStop')

    if (data.status === 'started') {
        isPlaying = true
        progressContainer.classList.add('active')
        btnPlayback.disabled = true
        btnStop.disabled = false
    } else if (data.status === 'ended') {
        isPlaying = false
        progressContainer.classList.remove('active')
        btnPlayback.disabled = false
        btnStop.disabled = true
        clearPlaybackNotes()
        document.getElementById('progressFill').style.width = '0%'
        document.getElementById('progressText').textContent = 'Complete'
    }
}

function handlePlaybackEvent(data) {
    const event = data.event
    const progress = data.progress

    const percent = Math.round(progress * 100)
    document.getElementById('progressFill').style.width = `${percent}%`
    document.getElementById('progressText').textContent = `${percent}% (${data.eventIndex + 1}/${data.totalEvents})`

    if (event.type === 'noteon' && event.velocity > 0) {
        activateNote(event.note, true)
    } else if (event.type === 'noteoff' || (event.type === 'noteon' && event.velocity === 0)) {
        deactivateNote(event.note, true)
    }

    if (data.sessionStart != null && data.sessionEnd != null) {
        playbackActive = true
        playbackTime = event.timestamp
        drawTimeline()
    }
}

// ===========================================
// Session Management
// ===========================================
const sessionForm = document.getElementById('sessionForm')
const sessionList = document.getElementById('sessionList')
const sessionStartInput = document.getElementById('sessionStart')
const sessionEndInput = document.getElementById('sessionEnd')

function updateSessionTimeFieldsFromSelection() {
    if (window.selectedTimeRange) {
        sessionStartInput.value = Math.round(window.selectedTimeRange.start)
        sessionEndInput.value = Math.round(window.selectedTimeRange.end)
    } else {
        sessionStartInput.value = ''
        sessionEndInput.value = ''
    }
}

// Sync timeline selection with form fields
const origUpdateSelection = updateSelection
window.updateSelection = function() {
    origUpdateSelection()
    updateSessionTimeFieldsFromSelection()
}

function updateSelectionFromFields() {
    const start = parseInt(sessionStartInput.value)
    const end = parseInt(sessionEndInput.value)
    if (!isNaN(start) && !isNaN(end) && start < end) {
        window.selectedTimeRange = { start, end }
        selectionStart = start
        selectionEnd = end
        updateSelection()
    }
}

sessionStartInput.addEventListener('change', updateSelectionFromFields)
sessionEndInput.addEventListener('change', updateSelectionFromFields)

sessionForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = new FormData(sessionForm)
    const startTime = parseInt(sessionStartInput.value)
    const endTime = parseInt(sessionEndInput.value)

    if (isNaN(startTime) || isNaN(endTime) || startTime >= endTime) {
        alert('Please select a valid start and end time.')
        return
    }

    const session = {
        start_time: startTime,
        end_time: endTime,
        performer: form.get('performer') || null,
        song_name: form.get('song') || null,
    }

    try {
        const res = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
        })
        if (res.ok) {
            resetSessionForm()
            loadSessions()
        }
    } catch (err) {
        console.error('Failed to save session:', err)
    }
})

function resetSessionForm() {
    sessionForm.reset()
    sessionForm.elements.id.value = ''
    sessionStartInput.value = ''
    sessionEndInput.value = ''
    document.getElementById('sessionFormTitle').textContent = 'New Session'
    document.getElementById('btnSaveSession').classList.remove('hidden')
    document.getElementById('btnUpdateSession').classList.add('hidden')
    document.getElementById('btnDeleteSession').classList.add('hidden')
    document.getElementById('btnCancelEdit').classList.add('hidden')
    window.selectedTimeRange = null
    selectionStart = null
    selectionEnd = null
    updateSelection()
}

function editSession(session) {
    sessionForm.elements.id.value = session.id
    sessionForm.elements.performer.value = session.performer || ''
    sessionForm.elements.song.value = session.song_name || ''
    sessionStartInput.value = Math.round(session.start_time)
    sessionEndInput.value = Math.round(session.end_time)
    selectionStart = session.start_time
    selectionEnd = session.end_time
    window.selectedTimeRange = { start: session.start_time, end: session.end_time }
    updateSelection()
    document.getElementById('sessionFormTitle').textContent = 'Edit Session'
    document.getElementById('btnSaveSession').classList.add('hidden')
    document.getElementById('btnUpdateSession').classList.remove('hidden')
    document.getElementById('btnDeleteSession').classList.remove('hidden')
    document.getElementById('btnCancelEdit').classList.remove('hidden')
}

document.getElementById('btnUpdateSession').addEventListener('click', async () => {
    const id = sessionForm.elements.id.value
    if (!id) return

    const session = {
        start_time: window.selectedTimeRange?.start || selectionStart,
        end_time: window.selectedTimeRange?.end || selectionEnd,
        performer: sessionForm.elements.performer.value || null,
        song_name: sessionForm.elements.song.value || null,
    }

    try {
        const res = await fetch(`/api/sessions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
        })
        if (res.ok) {
            resetSessionForm()
            loadSessions()
        }
    } catch (err) {
        console.error('Failed to update session:', err)
    }
})

document.getElementById('btnDeleteSession').addEventListener('click', async () => {
    const id = sessionForm.elements.id.value
    if (!id) return
    if (!confirm('Delete this session?')) return

    try {
        const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
        if (res.ok) {
            resetSessionForm()
            loadSessions()
        }
    } catch (err) {
        console.error('Failed to delete session:', err)
    }
})

document.getElementById('btnCancelEdit').addEventListener('click', resetSessionForm)

async function loadSessions() {
    try {
        const res = await fetch('/api/sessions')
        const sessions = await res.json()

        sessionList.innerHTML = sessions.map(s => `
            <div class="session-item" data-id="${s.id}" data-start="${s.start_time}" data-end="${s.end_time}" data-performer="${s.performer || ''}" data-song="${s.song_name || ''}">
                <div class="title">${s.song_name || 'Untitled'}</div>
                <div class="meta">${s.performer || 'Unknown'} · ${new Date(s.start_time).toLocaleDateString()}</div>
            </div>
        `).join('')
    } catch (err) {
        console.error('Failed to load sessions:', err)
    }
}

// ===========================================
// Playback Controls
// ===========================================
document.getElementById('btnRefresh').addEventListener('click', async () => {
    try {
        await fetch('/api/midi/stop', { method: 'POST' })
        await fetch('/api/midi/start', { method: 'POST' })
        await loadOutputs()
    } catch (err) {
        console.error('Failed to refresh MIDI:', err)
    }
})

document.getElementById('btnPlayback').addEventListener('click', async () => {
    const selected = sessionList.querySelector('.session-item.selected')
    if (!selected) {
        alert('Select a session first')
        return
    }

    const output = document.getElementById('outputSelect').value || undefined

    try {
        await fetch('/api/playback/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start: parseInt(selected.dataset.start),
                end: parseInt(selected.dataset.end),
                output
            }),
        })
    } catch (err) {
        console.error('Playback failed:', err)
    }
})

document.getElementById('btnStop').addEventListener('click', async () => {
    try {
        await fetch('/api/playback/stop', { method: 'POST' })
    } catch (err) {
        console.error('Stop failed:', err)
    }
})

async function loadOutputs() {
    const outputSelect = document.getElementById('outputSelect')
    try {
        const res = await fetch('/api/midi/outputs')
        const outputs = await res.json()

        if (outputs.length === 0) {
            outputSelect.innerHTML = '<option value="">No outputs found</option>'
        } else {
            outputSelect.innerHTML = outputs.map((o, i) =>
                `<option value="${o}" ${i === 0 ? 'selected' : ''}>${o.split('/').pop()}</option>`
            ).join('')
        }
    } catch (err) {
        outputSelect.innerHTML = '<option value="">Error loading outputs</option>'
    }
}

// Session selection - click to select and show on timeline
sessionList.addEventListener('click', (e) => {
    const item = e.target.closest('.session-item')
    if (item) {
        sessionList.querySelectorAll('.session-item').forEach(i => {
            i.classList.remove('selected')
            i.style.background = ''
        })
        item.classList.add('selected')

        const startTime = parseInt(item.dataset.start)
        const endTime = parseInt(item.dataset.end)
        const sessionDuration = endTime - startTime
        const windowDuration = timelineEndTime - timelineStartTime

        // Auto-zoom if session doesn't fit in view
        if (sessionDuration > windowDuration * 0.66 || startTime < timelineStartTime || endTime > timelineEndTime) {
            const buffer = Math.round(sessionDuration * 0.25)
            const newStart = Math.max(0, startTime - buffer)
            const newEnd = endTime + buffer
            const targetDuration = Math.max(newEnd - newStart, Math.round(sessionDuration / 0.66))
            const center = (startTime + endTime) / 2
            timelineStartTime = Math.max(0, Math.round(center - targetDuration / 2))
            timelineEndTime = Math.round(center + targetDuration / 2)
            updateTimeLabels()
            drawTimeline()
        }
        selectSessionRange(startTime, endTime)
    }
})

// ===========================================
// MIDI File Upload
// ===========================================
const midiFileInput = document.getElementById('midiFileInput')
const btnSelectFile = document.getElementById('btnSelectFile')
const btnPlayFile = document.getElementById('btnPlayFile')
const fileInfo = document.getElementById('fileInfo')
let selectedMidiFile = null

btnSelectFile.addEventListener('click', () => midiFileInput.click())

midiFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]
    if (file) {
        selectedMidiFile = file
        fileInfo.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`
        btnPlayFile.disabled = false
    }
})

btnPlayFile.addEventListener('click', async () => {
    if (!selectedMidiFile) return

    const output = document.getElementById('outputSelect').value
    const formData = new FormData()
    formData.append('file', selectedMidiFile)
    if (output) formData.append('output', output)

    try {
        btnPlayFile.disabled = true
        btnPlayFile.textContent = '⏳ Loading...'

        const res = await fetch('/api/playback/file', {
            method: 'POST',
            body: formData
        })

        const data = await res.json()
        if (data.error) {
            alert('Error: ' + data.error)
        } else {
            fileInfo.textContent = `Playing: ${data.fileName} (${data.eventCount} events)`
        }
    } catch (err) {
        alert('Failed to play file: ' + err.message)
    } finally {
        btnPlayFile.textContent = '▶ Play File'
        btnPlayFile.disabled = false
    }
})

// ===========================================
// Timeline Zoom/Pan Controls
// ===========================================
const btnZoomIn = document.getElementById('timelineZoomIn')
const btnZoomOut = document.getElementById('timelineZoomOut')
const btnPanLeft = document.getElementById('timelinePanLeft')
const btnPanRight = document.getElementById('timelinePanRight')
const btnResumeAuto = document.getElementById('timelineResumeAuto')
let customZoom = false

btnZoomIn.addEventListener('click', async () => {
    if (window.selectedTimeRange) {
        timelineStartTime = window.selectedTimeRange.start
        timelineEndTime = window.selectedTimeRange.end
        await ensureTimelineDataCovers(timelineStartTime, timelineEndTime)
        updateTimeLabels()
        drawTimeline()
        selectionStart = null
        selectionEnd = null
        updateSelection()
        customZoom = true
        btnResumeAuto.classList.remove('hidden')
    }
})

btnZoomOut.addEventListener('click', async () => {
    let center, range
    if (window.selectedTimeRange) {
        center = (window.selectedTimeRange.start + window.selectedTimeRange.end) / 2
        range = (window.selectedTimeRange.end - window.selectedTimeRange.start)
    } else {
        center = (timelineStartTime + timelineEndTime) / 2
        range = (timelineEndTime - timelineStartTime)
    }
    range = Math.max(1000, range * 2)
    timelineStartTime = Math.max(0, Math.round(center - range / 2))
    timelineEndTime = Math.round(center + range / 2)
    await ensureTimelineDataCovers(timelineStartTime, timelineEndTime)
    updateTimeLabels()
    drawTimeline()
    customZoom = true
    btnResumeAuto.classList.remove('hidden')
})

btnPanLeft.addEventListener('click', async () => {
    const range = timelineEndTime - timelineStartTime
    const shift = Math.round(range / 4)
    timelineStartTime = Math.max(0, timelineStartTime - shift)
    timelineEndTime = timelineEndTime - shift
    await ensureTimelineDataCovers(timelineStartTime, timelineEndTime)
    updateTimeLabels()
    drawTimeline()
    customZoom = true
    btnResumeAuto.classList.remove('hidden')
})

btnPanRight.addEventListener('click', async () => {
    const range = timelineEndTime - timelineStartTime
    const shift = Math.round(range / 4)
    timelineStartTime = timelineStartTime + shift
    timelineEndTime = timelineEndTime + shift
    await ensureTimelineDataCovers(timelineStartTime, timelineEndTime)
    updateTimeLabels()
    drawTimeline()
    customZoom = true
    btnResumeAuto.classList.remove('hidden')
})

btnResumeAuto.addEventListener('click', () => {
    customZoom = false
    btnResumeAuto.classList.add('hidden')
    loadTimelineData()
})

// ===========================================
// Initialize
// ===========================================
connect()
loadSessions()
loadOutputs()
