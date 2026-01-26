// ===========================================
// DOM Elements
// ===========================================
const $ = id => document.getElementById(id)
const piano = $('piano')
const eventLog = $('eventLog')
const statusDot = $('statusDot')
const statusText = $('statusText')
const outputSelect = $('outputSelect')
const progressContainer = $('progressContainer')
const progressFill = $('progressFill')
const progressText = $('progressText')
const btnPlayback = $('btnPlayback')
const btnStop = $('btnStop')

// ===========================================
// Helpers
// ===========================================
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const isNoteOn = (e) => e.type === 'noteon' && e.velocity > 0
const isNoteOff = (e) => e.type === 'noteoff' || (e.type === 'noteon' && e.velocity === 0)
const noteName = (note) => `${noteNames[note % 12]}${Math.floor(note / 12) - 1}`

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
const playbackNotes = new Set()

function activateNote(note, isPlayback = false) {
    if (!keys[note]) return
    const cls = isPlayback ? 'playback' : 'active'
    keys[note].classList.add(cls)
    if (isPlayback) playbackNotes.add(note)
}

function deactivateNote(note, isPlayback = false) {
    if (!keys[note]) return
    const cls = isPlayback ? 'playback' : 'active'
    keys[note].classList.remove(cls)
    if (isPlayback) playbackNotes.delete(note)
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
const timelineCanvas = $('timelineCanvas')
const timelineContainer = $('timelineContainer')
const timelineSelection = $('timelineSelection')
const timelineStart = $('timelineStart')
const timelineEnd = $('timelineEnd')
const timelineSelectionInfo = $('timelineSelectionInfo')
const ctx = timelineCanvas.getContext('2d')

// Unified timeline state
const timeline = {
    // View bounds (wall-clock timestamps in ms)
    viewStart: 0,
    viewEnd: 0,

    // Mode: 'live' | 'detached' | 'playback'
    mode: 'live',

    // Selection (null when no selection)
    selection: null,  // { start: ms, end: ms }

    // Currently selected session (for editing)
    selectedSessionId: null,
    selectedSessionBounds: null,  // { x1, x2, y, rowHeight, sessionId } for hit testing
    originalSessionBounds: null,  // { start_time, end_time } to restore on cancel

    // Playback position (null when not playing)
    playbackPosition: null,
    playbackBounds: null,      // { start, end } - the time range being played
    playbackStartedAt: null,   // Date.now() when playback started
    playbackAnimationId: null, // requestAnimationFrame ID

    // Data cache
    events: [],
    sessions: [],

    // Canvas rendering
    dpr: window.devicePixelRatio || 1
}

const minNote = 21
const maxNote = 108
const noteRange = maxNote - minNote + 1

async function fetchTimelineEvents(start, end) {
    try {
        const res = await fetch(`/api/events/range?start=${start}&end=${end}`)
        timeline.events = await res.json()
    } catch (err) {
        console.error('Failed to fetch timeline data:', err)
    }
}

async function ensureTimelineDataCovers(start, end) {
    if (timeline.events.length > 0 && timeline.events[0].timestamp <= start && timeline.events[timeline.events.length - 1].timestamp >= end) return
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
    const now = Date.now()
    // Default to 30 minutes view
    const defaultMinutes = 30
    timeline.viewEnd = now
    timeline.viewStart = now - defaultMinutes * 60 * 1000
    timeline.mode = 'live'
    await fetchTimelineEvents(timeline.viewStart, timeline.viewEnd)
    updateTimeLabels()
    drawTimeline()
}

function updateTimeLabels() {
    timelineStart.textContent = new Date(timeline.viewStart).toLocaleTimeString()
    timelineEnd.textContent = new Date(timeline.viewEnd).toLocaleTimeString()
}

// Session overlay colors
const sessionColors = [
    { bg: 'rgba(59, 130, 246, 0.25)', border: 'rgba(59, 130, 246, 0.8)' },   // blue
    { bg: 'rgba(16, 185, 129, 0.25)', border: 'rgba(16, 185, 129, 0.8)' },   // green
    { bg: 'rgba(245, 158, 11, 0.25)', border: 'rgba(245, 158, 11, 0.8)' },   // amber
    { bg: 'rgba(139, 92, 246, 0.25)', border: 'rgba(139, 92, 246, 0.8)' },   // purple
    { bg: 'rgba(236, 72, 153, 0.25)', border: 'rgba(236, 72, 153, 0.8)' },   // pink
]

// Calculate row assignments for overlapping sessions
function assignOverlapRows(sessions) {
    const rows = []
    const rowEnds = []  // tracks when each row becomes free

    sessions.forEach(session => {
        let row = 0
        while (rowEnds[row] && rowEnds[row] > session.start_time) {
            row++
        }
        rows.push(row)
        rowEnds[row] = session.end_time
    })

    return rows
}

function drawSessionOverlays(width, height, duration) {
    if (!timeline.sessions || timeline.sessions.length === 0) return

    // Filter to visible sessions
    const visibleSessions = timeline.sessions.filter(s =>
        s.end_time >= timeline.viewStart && s.start_time <= timeline.viewEnd
    )

    if (visibleSessions.length === 0) return

    // Sort by start time for overlap calculation
    const sorted = [...visibleSessions].sort((a, b) => a.start_time - b.start_time)
    const rows = assignOverlapRows(sorted)
    const maxRows = Math.max(...rows) + 1
    const rowHeight = Math.min(24, height / (maxRows + 1))

    sorted.forEach((session, i) => {
        const x1 = Math.max(0, ((session.start_time - timeline.viewStart) / duration) * width)
        const x2 = Math.min(width, ((session.end_time - timeline.viewStart) / duration) * width)
        const row = rows[i]
        const y = row * rowHeight

        const colorIndex = session.id % sessionColors.length
        const colors = sessionColors[colorIndex]
        const isSelected = session.id === timeline.selectedSessionId

        // Draw background
        ctx.fillStyle = isSelected ? colors.bg.replace('0.25', '0.4') : colors.bg
        ctx.fillRect(x1, y, x2 - x1, rowHeight - 2)

        // Draw border for selected session
        if (isSelected) {
            ctx.strokeStyle = colors.border
            ctx.lineWidth = 2
            ctx.strokeRect(x1 + 1, y + 1, x2 - x1 - 2, rowHeight - 4)

            // Only draw resize handles when in edit mode (edit panel is open)
            const isEditing = !$('editPanel').classList.contains('hidden')
            if (isEditing) {
                const handleWidth = 6
                const handleHeight = rowHeight - 2
                ctx.fillStyle = colors.border

                // Left handle
                ctx.fillRect(x1, y, handleWidth, handleHeight)

                // Right handle
                ctx.fillRect(x2 - handleWidth, y, handleWidth, handleHeight)

                // Store selected session bounds for hit testing (only in edit mode)
                timeline.selectedSessionBounds = { x1, x2, y, rowHeight, sessionId: session.id }
            } else {
                // Clear bounds when not editing
                timeline.selectedSessionBounds = null
            }
        }

        // Draw label if wide enough
        const labelWidth = x2 - x1
        if (labelWidth > 50) {
            ctx.fillStyle = '#fff'
            ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
            const label = session.song_name || session.performer || `Session ${session.id}`
            const maxTextWidth = labelWidth - 8
            ctx.save()
            ctx.beginPath()
            ctx.rect(x1, y, labelWidth, rowHeight)
            ctx.clip()
            ctx.fillText(label, x1 + 4, y + 14, maxTextWidth)
            ctx.restore()
        }
    })
}

function drawTimeline() {
    const width = timelineContainer.clientWidth
    const height = timelineContainer.clientHeight
    const duration = timeline.viewEnd - timeline.viewStart
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
    const startMinute = Math.ceil(timeline.viewStart / minuteMs) * minuteMs
    for (let t = startMinute; t < timeline.viewEnd; t += minuteMs) {
        const x = ((t - timeline.viewStart) / duration) * width
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
    }

    // Draw session overlays as colored backgrounds
    drawSessionOverlays(width, height, duration)

    // Build note on/off pairs for drawing bars
    const activeNotesMap = new Map()
    const noteBars = []
    for (const event of timeline.events) {
        if (isNoteOn(event)) {
            activeNotesMap.set(event.note, { start: event.timestamp, velocity: event.velocity })
        } else if (isNoteOff(event)) {
            const noteStart = activeNotesMap.get(event.note)
            if (noteStart) {
                noteBars.push({ note: event.note, start: noteStart.start, end: event.timestamp, velocity: noteStart.velocity })
                activeNotesMap.delete(event.note)
            }
        }
    }
    for (const [note, data] of activeNotesMap) {
        noteBars.push({ note, start: data.start, end: timeline.viewEnd, velocity: data.velocity })
    }

    // Draw note bars
    const noteHeight = height / noteRange
    for (const bar of noteBars) {
        const x1 = ((bar.start - timeline.viewStart) / duration) * width
        const x2 = ((bar.end - timeline.viewStart) / duration) * width
        const y = height - ((bar.note - minNote + 1) / noteRange) * height
        const brightness = 50 + (bar.velocity / 127) * 50
        const isBlack = [1, 3, 6, 8, 10].includes(bar.note % 12)
        ctx.fillStyle = isBlack ? `hsl(340, 80%, ${brightness}%)` : `hsl(160, 70%, ${brightness}%)`
        const barWidth = Math.max(2, x2 - x1)
        ctx.fillRect(x1, y, barWidth, Math.max(1, noteHeight - 1))
    }

    // Draw selection overlay
    if (timeline.selection) {
        const selX1 = ((timeline.selection.start - timeline.viewStart) / duration) * width
        const selX2 = ((timeline.selection.end - timeline.viewStart) / duration) * width
        ctx.save()
        ctx.globalAlpha = 0.3
        ctx.fillStyle = '#e94560'
        ctx.fillRect(selX1, 0, selX2 - selX1, height)
        ctx.restore()
    }

    // Draw playback indicator
    if (timeline.mode === 'playback' && timeline.playbackPosition != null) {
        const x = ((timeline.playbackPosition - timeline.viewStart) / duration) * width
        if (x >= 0 && x <= width) {
            ctx.save()
            // Red playback line
            ctx.strokeStyle = '#ef4444'
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, height)
            ctx.stroke()
            // Playhead triangle at top
            ctx.beginPath()
            ctx.moveTo(x - 6, 0)
            ctx.lineTo(x + 6, 0)
            ctx.lineTo(x, 8)
            ctx.closePath()
            ctx.fillStyle = '#ef4444'
            ctx.fill()
            ctx.restore()
        }
    }

    // Update the selection overlay position (HTML element with handles)
    updateSelectionUI()
}

function timeToX(time) {
    const width = timelineContainer.clientWidth
    const duration = timeline.viewEnd - timeline.viewStart
    return ((time - timeline.viewStart) / duration) * width
}

function xToTime(x) {
    const width = timelineContainer.clientWidth
    const duration = timeline.viewEnd - timeline.viewStart
    return timeline.viewStart + (x / width) * duration
}

function updateSelectionUI() {
    if (timeline.selection) {
        const x1 = timeToX(timeline.selection.start)
        const x2 = timeToX(timeline.selection.end)
        timelineSelection.style.left = x1 + 'px'
        timelineSelection.style.width = (x2 - x1) + 'px'
        timelineSelection.classList.add('active')

        const start = new Date(timeline.selection.start)
        const end = new Date(timeline.selection.end)
        const durationSec = Math.round((timeline.selection.end - timeline.selection.start) / 1000)
        const mins = Math.floor(durationSec / 60)
        const secs = durationSec % 60
        timelineSelectionInfo.textContent = `Selected: ${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${mins}:${secs.toString().padStart(2, '0')})`

        // Enable play, save, and clear buttons when there's a selection
        $('timelinePlaySelection').disabled = false
        $('timelineSaveNew').disabled = false
        $('timelineClear').disabled = false

        // Keep legacy support for session form
        window.selectedTimeRange = { start: timeline.selection.start, end: timeline.selection.end }
    } else {
        timelineSelection.classList.remove('active')
        timelineSelectionInfo.textContent = ''
        window.selectedTimeRange = null

        // Disable save and clear buttons when no selection
        $('timelineSaveNew').disabled = true
        $('timelineClear').disabled = true

        // Enable play if a session is selected, otherwise disable
        if (timeline.selectedSessionId != null) {
            const session = timeline.sessions.find(s => s.id === timeline.selectedSessionId)
            if (session) {
                $('timelinePlaySelection').disabled = false
                const start = new Date(session.start_time)
                const end = new Date(session.end_time)
                const durationSec = Math.round((session.end_time - session.start_time) / 1000)
                const mins = Math.floor(durationSec / 60)
                const secs = durationSec % 60
                timelineSelectionInfo.textContent = `Session: ${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${mins}:${secs.toString().padStart(2, '0')})`
            } else {
                $('timelinePlaySelection').disabled = true
            }
        } else {
            $('timelinePlaySelection').disabled = true
        }
    }
}

function setSelection(startTime, endTime) {
    if (startTime != null && endTime != null) {
        timeline.selection = {
            start: Math.min(startTime, endTime),
            end: Math.max(startTime, endTime)
        }
    } else {
        timeline.selection = null
    }
    updateSelectionUI()
}

function clearSelection() {
    timeline.selection = null
    timeline.selectedSessionId = null
    // Hide edit panel if open
    $('editPanel').classList.add('hidden')
    sessionList.querySelectorAll('.session-item').forEach(i => { i.classList.remove('selected') })
    updateSelectionUI()
    drawTimeline()
}

// Timeline mouse/drag handlers
let dragState = null  // { mode: 'new'|'left'|'right', startTime: number }
const handleLeft = $('handleLeft')
const handleRight = $('handleRight')

function showResumeButton() {
    $('timelineResumeAuto').classList.remove('hidden')
}

// Find session at a given pixel position on the timeline
function getSessionAtPosition(x, y) {
    if (!timeline.sessions || timeline.sessions.length === 0) return null

    const width = timelineContainer.clientWidth
    const height = timelineContainer.clientHeight
    const duration = timeline.viewEnd - timeline.viewStart

    // Filter to visible sessions
    const visibleSessions = timeline.sessions.filter(s =>
        s.end_time >= timeline.viewStart && s.start_time <= timeline.viewEnd
    )

    if (visibleSessions.length === 0) return null

    // Sort by start time for overlap calculation (same as drawing)
    const sorted = [...visibleSessions].sort((a, b) => a.start_time - b.start_time)
    const rows = assignOverlapRows(sorted)
    const maxRows = Math.max(...rows) + 1
    const rowHeight = Math.min(24, height / (maxRows + 1))

    // Check each session
    for (let i = 0; i < sorted.length; i++) {
        const session = sorted[i]
        const x1 = Math.max(0, ((session.start_time - timeline.viewStart) / duration) * width)
        const x2 = Math.min(width, ((session.end_time - timeline.viewStart) / duration) * width)
        const row = rows[i]
        const sessionY = row * rowHeight

        if (x >= x1 && x <= x2 && y >= sessionY && y <= sessionY + rowHeight) {
            return session
        }
    }

    return null
}

handleLeft.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!timeline.selection) return
    dragState = { mode: 'left' }
})

handleRight.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!timeline.selection) return
    dragState = { mode: 'right' }
})

timelineContainer.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('timeline-handle')) return

    const rect = timelineContainer.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // Check if clicking on session handles
    if (timeline.selectedSessionBounds) {
        const b = timeline.selectedSessionBounds
        const handleWidth = 8  // slightly larger hit area than visual

        // Left handle
        if (x >= b.x1 - handleWidth && x <= b.x1 + handleWidth && y >= b.y && y <= b.y + b.rowHeight) {
            e.preventDefault()
            dragState = { mode: 'session-left', sessionId: b.sessionId }
            return
        }

        // Right handle
        if (x >= b.x2 - handleWidth && x <= b.x2 + handleWidth && y >= b.y && y <= b.y + b.rowHeight) {
            e.preventDefault()
            dragState = { mode: 'session-right', sessionId: b.sessionId }
            return
        }
    }

    const time = xToTime(x)
    dragState = { mode: 'new', startTime: time, startX: x, dragging: false }
})

document.addEventListener('mousemove', (e) => {
    if (!dragState) return
    const rect = timelineContainer.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const time = xToTime(x)

    if (dragState.mode === 'new') {
        // Only start selection after dragging a few pixels
        const dx = Math.abs(x - dragState.startX)
        if (dx > 5) dragState.dragging = true

        if (dragState.dragging) {
            // Clear selected session when manually creating a new selection
            if (timeline.selectedSessionId != null) {
                timeline.selectedSessionId = null
                // Also deselect in sidebar and hide edit panel
                sessionList.querySelectorAll('.session-item').forEach(i => { i.classList.remove('selected') })
                $('editPanel').classList.add('hidden')
            }
            setSelection(dragState.startTime, time)
            drawTimeline()
        }
    } else if (dragState.mode === 'left' && timeline.selection) {
        timeline.selection.start = Math.min(time, timeline.selection.end - 1000)
        updateSelectionUI()
        drawTimeline()
    } else if (dragState.mode === 'right' && timeline.selection) {
        timeline.selection.end = Math.max(time, timeline.selection.start + 1000)
        updateSelectionUI()
        drawTimeline()
    } else if (dragState.mode === 'session-left') {
        // Dragging left handle of selected session
        const session = timeline.sessions.find(s => s.id === dragState.sessionId)
        if (session) {
            session.start_time = Math.min(time, session.end_time - 1000)
            updateEditPanelTimeInfo(session)
            drawTimeline()
        }
    } else if (dragState.mode === 'session-right') {
        // Dragging right handle of selected session
        const session = timeline.sessions.find(s => s.id === dragState.sessionId)
        if (session) {
            session.end_time = Math.max(time, session.start_time + 1000)
            updateEditPanelTimeInfo(session)
            drawTimeline()
        }
    }
})

function updateEditPanelTimeInfo(session) {
    const start = new Date(session.start_time)
    const end = new Date(session.end_time)
    const durationSec = Math.round((session.end_time - session.start_time) / 1000)
    const mins = Math.floor(durationSec / 60)
    const secs = durationSec % 60
    $('editTimeInfo').textContent = `${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${mins}:${secs.toString().padStart(2, '0')})`
}

document.addEventListener('mouseup', (e) => {
    if (!dragState) return

    // If we dragged, switch to detached mode
    if (dragState.dragging && timeline.mode === 'live') {
        timeline.mode = 'detached'
        showResumeButton()
    }

    // If we clicked (not dragged), check if we clicked on a session
    if (!dragState.dragging && dragState.mode === 'new') {
        const rect = timelineContainer.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top

        const session = getSessionAtPosition(x, y)
        if (session) {
            // Select this session
            selectSession(session.id, session.start_time, session.end_time)

            // Also highlight in the sidebar list
            sessionList.querySelectorAll('.session-item').forEach(item => {
                item.classList.toggle('selected', parseInt(item.dataset.id, 10) === session.id)
            })
        } else {
            // Clicked on empty space - cancel edit mode if active
            if (timeline.selectedSessionId != null && timeline.originalSessionBounds) {
                const oldSession = timeline.sessions.find(s => s.id === timeline.selectedSessionId)
                if (oldSession) {
                    oldSession.start_time = timeline.originalSessionBounds.start_time
                    oldSession.end_time = timeline.originalSessionBounds.end_time
                }
                timeline.originalSessionBounds = null
            }
            hideEditPanel()
        }
    }

    dragState = null
})

// Double-click on session to open edit panel
timelineContainer.addEventListener('dblclick', async (e) => {
    const rect = timelineContainer.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const session = getSessionAtPosition(x, y)
    if (session) {
        await selectSession(session.id, session.start_time, session.end_time)
        showEditPanel(session.id)
        $('editPerformer').focus()
    }
})

// Cursor change when hovering over session handles
timelineContainer.addEventListener('mousemove', (e) => {
    if (dragState) return  // Don't change cursor while dragging

    if (timeline.selectedSessionBounds) {
        const rect = timelineContainer.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        const b = timeline.selectedSessionBounds
        const handleWidth = 8

        const onLeftHandle = x >= b.x1 - handleWidth && x <= b.x1 + handleWidth && y >= b.y && y <= b.y + b.rowHeight
        const onRightHandle = x >= b.x2 - handleWidth && x <= b.x2 + handleWidth && y >= b.y && y <= b.y + b.rowHeight

        if (onLeftHandle || onRightHandle) {
            timelineContainer.style.cursor = 'ew-resize'
            return
        }
    }
    timelineContainer.style.cursor = 'crosshair'
})

// Mouse wheel: vertical = zoom, horizontal = pan
timelineCanvas.addEventListener('wheel', async (e) => {
    e.preventDefault()

    if (timeline.mode === 'live') {
        timeline.mode = 'detached'
        showResumeButton()
    }

    const currentDuration = timeline.viewEnd - timeline.viewStart

    // Horizontal scroll = pan
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const panAmount = (e.deltaX / 500) * currentDuration
        timeline.viewStart = Math.max(0, timeline.viewStart + panAmount)
        timeline.viewEnd = timeline.viewEnd + panAmount

        await ensureTimelineDataCovers(timeline.viewStart, timeline.viewEnd)
        updateTimeLabels()
        drawTimeline()
        return
    }

    // Vertical scroll = zoom (with reduced sensitivity)
    if (Math.abs(e.deltaY) < 5) return  // Ignore tiny movements

    const rect = timelineCanvas.getBoundingClientRect()
    const ratio = e.offsetX / rect.width
    const centerTime = timeline.viewStart + currentDuration * ratio

    // Gentler zoom factor (1.1 instead of 1.2)
    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9
    const newDuration = Math.max(5000, currentDuration * zoomFactor)  // Min 5 seconds

    let newStart = centerTime - newDuration * ratio
    let newEnd = centerTime + newDuration * (1 - ratio)

    // Try to keep selection visible when zooming
    if (timeline.selection) {
        const sel = timeline.selection
        if (sel.start < newStart) {
            const shift = newStart - sel.start + newDuration * 0.05
            newStart -= shift
            newEnd -= shift
        } else if (sel.end > newEnd) {
            const shift = sel.end - newEnd + newDuration * 0.05
            newStart += shift
            newEnd += shift
        }
    }

    timeline.viewStart = Math.max(0, newStart)
    timeline.viewEnd = newEnd

    await ensureTimelineDataCovers(timeline.viewStart, timeline.viewEnd)
    updateTimeLabels()
    drawTimeline()
}, { passive: false })

// Keyboard navigation
document.addEventListener('keydown', async (e) => {
    // Don't handle keys when in input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

    switch (e.key) {
        case 'ArrowLeft':
            e.preventDefault()
            await panTimeline(-1)
            break
        case 'ArrowRight':
            e.preventDefault()
            await panTimeline(1)
            break
        case '+':
        case '=':
            e.preventDefault()
            btnZoomIn.click()
            break
        case '-':
            e.preventDefault()
            btnZoomOut.click()
            break
        case 'Home':
            e.preventDefault()
            loadTimelineData()
            $('timelineResumeAuto').classList.add('hidden')
            break
        case ' ':  // Space - toggle playback
            e.preventDefault()
            if (timeline.mode === 'playback') {
                await fetch('/api/playback/stop', { method: 'POST' })
            } else if (timeline.selection || timeline.selectedSessionId != null) {
                $('timelinePlaySelection').click()
            }
            break
        case 'Escape':
            e.preventDefault()
            if (timeline.mode === 'playback') {
                await fetch('/api/playback/stop', { method: 'POST' })
            } else {
                clearSelection()
            }
            break
    }
})

// Timeline button handlers
$('timelineRefresh').addEventListener('click', () => {
    loadTimelineData()
})

$('timelineClear').addEventListener('click', () => {
    clearSelection()
})

$('timelineStop').addEventListener('click', async () => {
    try {
        await fetch('/api/playback/stop', { method: 'POST' })
    } catch (err) {
        console.error('Stop failed:', err)
    }
})

$('timelinePlaySelection').addEventListener('click', async () => {
    // Determine what to play: manual selection or selected session
    let playStart, playEnd
    if (timeline.selection) {
        playStart = timeline.selection.start
        playEnd = timeline.selection.end
    } else if (timeline.selectedSessionId != null) {
        const session = timeline.sessions.find(s => s.id === timeline.selectedSessionId)
        if (session) {
            playStart = session.start_time
            playEnd = session.end_time
        }
    }

    if (playStart == null || playEnd == null) {
        alert('Select a range or session first')
        return
    }

    const output = outputSelect.value || undefined

    // Set view to show the selection with some padding
    const selDuration = playEnd - playStart
    const padding = selDuration * 0.1
    timeline.viewStart = playStart - padding
    timeline.viewEnd = playEnd + padding

    await ensureTimelineDataCovers(timeline.viewStart, timeline.viewEnd)
    updateTimeLabels()

    try {
        // Start smooth playback animation
        startPlaybackAnimation(playStart, playEnd)
        $('timelineStop').disabled = false
        $('timelinePlaySelection').disabled = true

        await fetch('/api/playback/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start: playStart,
                end: playEnd,
                output
            }),
        })
    } catch (err) {
        console.error('Playback failed:', err)
    }
})

$('timelineSaveNew').addEventListener('click', () => {
    if (!timeline.selection) {
        alert('Select a range first by clicking and dragging on the timeline')
        return
    }

    // Show edit panel for creating a new session
    showEditPanelForNewSession()
})

function addEventToTimeline(event) {
    // Only update in live mode
    if (timeline.mode !== 'live') return

    timeline.events.push(event)
    if (event.timestamp >= timeline.viewStart && event.timestamp <= timeline.viewEnd + 60000) {
        timeline.viewEnd = Math.max(timeline.viewEnd, Date.now())
        drawTimeline()
    }
}

// Initialize timeline
window.addEventListener('resize', resizeCanvas)
resizeCanvas()
loadTimelineData()

// Refresh timeline periodically (only in live mode)
setInterval(() => {
    if (timeline.mode !== 'live') return
    if (Date.now() > timeline.viewEnd) {
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
    if (isNoteOn(event)) activateNote(event.note, false)
    else if (isNoteOff(event)) deactivateNote(event.note, false)
    addLogEntry(event)
    addEventToTimeline(event)
}

// Smooth playback animation
function startPlaybackAnimation(startTime, endTime) {
    timeline.playbackBounds = { start: startTime, end: endTime }
    timeline.playbackStartedAt = null  // Will be calibrated by first server event
    timeline.mode = 'playback'
    timeline.playbackPosition = startTime

    function animate() {
        if (timeline.mode !== 'playback' || !timeline.playbackBounds) return

        // Only animate if we've been calibrated by server
        if (timeline.playbackStartedAt != null) {
            const elapsed = Date.now() - timeline.playbackStartedAt
            const position = timeline.playbackBounds.start + elapsed

            if (position >= timeline.playbackBounds.end) {
                timeline.playbackPosition = timeline.playbackBounds.end
            } else {
                timeline.playbackPosition = position
            }
        }

        drawTimeline()
        timeline.playbackAnimationId = requestAnimationFrame(animate)
    }

    timeline.playbackAnimationId = requestAnimationFrame(animate)
}

// Calibrate playback animation based on actual event timestamp
function calibratePlayback(eventTimestamp) {
    if (!timeline.playbackBounds || eventTimestamp == null) return

    // Calculate when playback must have started based on the event's actual timestamp
    const elapsed = eventTimestamp - timeline.playbackBounds.start
    timeline.playbackStartedAt = Date.now() - elapsed
}

function stopPlaybackAnimation() {
    if (timeline.playbackAnimationId) {
        cancelAnimationFrame(timeline.playbackAnimationId)
        timeline.playbackAnimationId = null
    }
    timeline.playbackBounds = null
    timeline.playbackStartedAt = null
    timeline.playbackPosition = null
    timeline.mode = 'detached'
}

function handlePlaybackStatus(data) {
    if (data.status === 'started') {
        progressContainer.classList.add('active')
        btnPlayback.disabled = true
        btnStop.disabled = false
        $('timelineStop').disabled = false
        $('timelinePlaySelection').disabled = true
    } else if (data.status === 'ended') {
        stopPlaybackAnimation()
        progressContainer.classList.remove('active')
        btnPlayback.disabled = false
        btnStop.disabled = true
        $('timelineStop').disabled = true
        // Re-enable play if there's a selection or selected session
        $('timelinePlaySelection').disabled = !timeline.selection && timeline.selectedSessionId == null
        clearPlaybackNotes()
        progressFill.style.width = '0%'
        progressText.textContent = 'Complete'
        drawTimeline()
    }
}

function handlePlaybackEvent(data) {
    const event = data.event
    const percent = Math.round(data.progress * 100)
    progressFill.style.width = `${percent}%`
    progressText.textContent = `${percent}% (${data.eventIndex + 1}/${data.totalEvents})`

    if (isNoteOn(event)) activateNote(event.note, true)
    else if (isNoteOff(event)) deactivateNote(event.note, true)

    // Calibrate animation timing based on actual event timestamp
    if (event.timestamp != null) {
        calibratePlayback(event.timestamp)
    }
}

// ===========================================
// Session Management
// ===========================================
const sessionForm = $('sessionForm')
const sessionList = $('sessionList')
const sessionStartInput = $('sessionStart')
const sessionEndInput = $('sessionEnd')

function updateSelectionFromFields() {
    const start = parseInt(sessionStartInput.value, 10)
    const end = parseInt(sessionEndInput.value, 10)
    if (!Number.isNaN(start) && !Number.isNaN(end) && start < end) {
        setSelection(start, end)
        drawTimeline()
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
    $('sessionFormTitle').textContent = 'New Session'
    $('btnSaveSession').classList.remove('hidden')
    $('btnUpdateSession').classList.add('hidden')
    $('btnDeleteSession').classList.add('hidden')
    $('btnCancelEdit').classList.add('hidden')
    clearSelection()
}

$('btnUpdateSession').addEventListener('click', async () => {
    const id = sessionForm.elements.id.value
    if (!id || !timeline.selection) return

    const session = {
        start_time: timeline.selection.start,
        end_time: timeline.selection.end,
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

$('btnDeleteSession').addEventListener('click', async () => {
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

$('btnCancelEdit').addEventListener('click', resetSessionForm)

async function loadSessions() {
    try {
        const res = await fetch('/api/sessions')
        const sessions = await res.json()

        // Store in timeline state for overlay rendering
        timeline.sessions = sessions

        // Render session list
        sessionList.innerHTML = sessions.map(s => `
            <div class="session-item ${s.id === timeline.selectedSessionId ? 'selected' : ''}"
                 data-id="${s.id}" data-start="${s.start_time}" data-end="${s.end_time}"
                 data-performer="${s.performer || ''}" data-song="${s.song_name || ''}">
                <div class="title">${s.song_name || 'Untitled'}</div>
                <div class="meta">${s.performer || 'Unknown'} · ${new Date(s.start_time).toLocaleDateString()}</div>
            </div>
        `).join('')

        // Redraw timeline to show session overlays
        drawTimeline()
    } catch (err) {
        console.error('Failed to load sessions:', err)
    }
}

// ===========================================
// Playback Controls
// ===========================================
$('btnRefresh').addEventListener('click', async () => {
    try {
        await fetch('/api/midi/stop', { method: 'POST' })
        await fetch('/api/midi/start', { method: 'POST' })
        await loadOutputs()
    } catch (err) {
        console.error('Failed to refresh MIDI:', err)
    }
})

btnPlayback.addEventListener('click', async () => {
    const selected = sessionList.querySelector('.session-item.selected')
    if (!selected) {
        alert('Select a session first')
        return
    }

    const output = outputSelect.value || undefined

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

btnStop.addEventListener('click', async () => {
    try {
        await fetch('/api/playback/stop', { method: 'POST' })
    } catch (err) {
        console.error('Stop failed:', err)
    }
})

async function loadOutputs() {
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
async function selectSession(sessionId, startTime, endTime) {
    // If we're already editing a different session, cancel that edit first (revert bounds)
    if (timeline.selectedSessionId != null && timeline.selectedSessionId !== sessionId && timeline.originalSessionBounds) {
        const oldSession = timeline.sessions.find(s => s.id === timeline.selectedSessionId)
        if (oldSession) {
            oldSession.start_time = timeline.originalSessionBounds.start_time
            oldSession.end_time = timeline.originalSessionBounds.end_time
        }
        timeline.originalSessionBounds = null
        hideEditPanel()
    }

    timeline.selectedSessionId = sessionId
    // Don't create red selection - just highlight the session overlay
    // Clear any existing new-selection
    timeline.selection = null
    updateSelectionUI()

    const viewDuration = timeline.viewEnd - timeline.viewStart
    const sessionDuration = endTime - startTime

    // Check if session is already fully visible
    const isVisible = startTime >= timeline.viewStart && endTime <= timeline.viewEnd

    if (isVisible) {
        // Already in view - just highlight, don't change viewport
        drawTimeline()
        return
    }

    // Need to scroll - switch to detached mode
    timeline.mode = 'detached'

    if (sessionDuration <= viewDuration) {
        // Session fits in current zoom - center it
        const center = (startTime + endTime) / 2
        timeline.viewStart = center - viewDuration / 2
        timeline.viewEnd = center + viewDuration / 2
    } else {
        // Session too large for current zoom - show start near left edge
        const padding = viewDuration * 0.1  // 10% padding from left
        timeline.viewStart = startTime - padding
        timeline.viewEnd = timeline.viewStart + viewDuration
    }

    // Clamp to valid range
    if (timeline.viewStart < 0) {
        timeline.viewEnd -= timeline.viewStart
        timeline.viewStart = 0
    }

    await ensureTimelineDataCovers(timeline.viewStart, timeline.viewEnd)
    updateTimeLabels()
    drawTimeline()
    showResumeButton()
}

// ===========================================
// Session Edit Panel (sidebar)
// ===========================================
const editPanel = $('editPanel')
const editPerformer = $('editPerformer')
const editSong = $('editSong')
const editTimeInfo = $('editTimeInfo')

function showEditPanel(sessionId) {
    const session = timeline.sessions.find(s => s.id === sessionId)
    if (!session) return

    // Store original bounds for cancel/revert
    timeline.originalSessionBounds = {
        start_time: session.start_time,
        end_time: session.end_time
    }

    editPerformer.value = session.performer || ''
    editSong.value = session.song_name || ''

    // Show time info
    const start = new Date(session.start_time)
    const end = new Date(session.end_time)
    const durationSec = Math.round((session.end_time - session.start_time) / 1000)
    const mins = Math.floor(durationSec / 60)
    const secs = durationSec % 60
    editTimeInfo.textContent = `${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${mins}:${secs.toString().padStart(2, '0')})`

    // Update panel title and show delete button for existing sessions
    editPanel.querySelector('h2').textContent = 'Edit Session'
    $('btnEditDelete').style.display = ''

    editPanel.classList.remove('hidden')
    // Redraw timeline to show resize handles
    drawTimeline()
}

function showEditPanelForNewSession() {
    if (!timeline.selection) return

    // Clear any selected session - this is a new one
    timeline.selectedSessionId = null
    timeline.originalSessionBounds = null

    editPerformer.value = ''
    editSong.value = ''

    // Show time info from selection
    const start = new Date(timeline.selection.start)
    const end = new Date(timeline.selection.end)
    const durationSec = Math.round((timeline.selection.end - timeline.selection.start) / 1000)
    const mins = Math.floor(durationSec / 60)
    const secs = durationSec % 60
    editTimeInfo.textContent = `${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${mins}:${secs.toString().padStart(2, '0')})`

    // Update panel title and hide delete button for new sessions
    editPanel.querySelector('h2').textContent = 'New Session'
    $('btnEditDelete').style.display = 'none'

    editPanel.classList.remove('hidden')
    editPerformer.focus()
}

function hideEditPanel() {
    editPanel.classList.add('hidden')
    timeline.selectedSessionId = null
    timeline.originalSessionBounds = null
    sessionList.querySelectorAll('.session-item').forEach(i => { i.classList.remove('selected') })
    drawTimeline()
}

$('btnEditSave').addEventListener('click', async () => {
    const isNewSession = !timeline.selectedSessionId

    let sessionData
    if (isNewSession) {
        // Creating a new session from selection
        if (!timeline.selection) {
            alert('No selection')
            return
        }
        sessionData = {
            start_time: timeline.selection.start,
            end_time: timeline.selection.end,
            performer: editPerformer.value || null,
            song_name: editSong.value || null,
        }
    } else {
        // Updating an existing session
        const session = timeline.sessions.find(s => s.id === timeline.selectedSessionId)
        if (!session) return

        sessionData = {
            start_time: session.start_time,
            end_time: session.end_time,
            performer: editPerformer.value || null,
            song_name: editSong.value || null,
        }
    }

    try {
        let res
        if (isNewSession) {
            res = await fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sessionData),
            })
        } else {
            res = await fetch(`/api/sessions/${timeline.selectedSessionId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sessionData),
            })
        }

        if (res.ok) {
            if (isNewSession) {
                // Clear selection after creating
                timeline.selection = null
                updateSelectionUI()
            }
            // Clear original bounds since we saved successfully
            timeline.originalSessionBounds = null
            hideEditPanel()
            await loadSessions()
        } else {
            alert('Failed to save session')
        }
    } catch (err) {
        console.error('Failed to save session:', err)
        alert('Failed to save session')
    }
})

$('btnEditCancel').addEventListener('click', () => {
    // Restore original session bounds if they were modified
    if (timeline.selectedSessionId && timeline.originalSessionBounds) {
        const session = timeline.sessions.find(s => s.id === timeline.selectedSessionId)
        if (session) {
            session.start_time = timeline.originalSessionBounds.start_time
            session.end_time = timeline.originalSessionBounds.end_time
        }
    }
    timeline.originalSessionBounds = null
    hideEditPanel()
})

$('btnEditDelete').addEventListener('click', async () => {
    if (!timeline.selectedSessionId) return
    if (!confirm('Delete this session?')) return

    try {
        const res = await fetch(`/api/sessions/${timeline.selectedSessionId}`, { method: 'DELETE' })
        if (res.ok) {
            timeline.originalSessionBounds = null
            hideEditPanel()
            loadSessions()
        } else {
            alert('Failed to delete session')
        }
    } catch (err) {
        console.error('Failed to delete session:', err)
        alert('Failed to delete session')
    }
})

sessionList.addEventListener('click', (e) => {
    const item = e.target.closest('.session-item')
    if (item) {
        sessionList.querySelectorAll('.session-item').forEach(i => {
            i.classList.remove('selected')
        })
        item.classList.add('selected')

        const sessionId = parseInt(item.dataset.id)
        const startTime = parseInt(item.dataset.start)
        const endTime = parseInt(item.dataset.end)
        selectSession(sessionId, startTime, endTime)
    }
})

// Double-click on session in sidebar to open edit panel
sessionList.addEventListener('dblclick', async (e) => {
    const item = e.target.closest('.session-item')
    if (item) {
        const sessionId = parseInt(item.dataset.id)
        const startTime = parseInt(item.dataset.start)
        const endTime = parseInt(item.dataset.end)
        await selectSession(sessionId, startTime, endTime)
        showEditPanel(sessionId)
        $('editPerformer').focus()
    }
})

// ===========================================
// MIDI File Upload
// ===========================================
const midiFileInput = $('midiFileInput')
const btnSelectFile = $('btnSelectFile')
const btnPlayFile = $('btnPlayFile')
const fileInfo = $('fileInfo')
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

    const output = outputSelect.value
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
const btnZoomIn = $('timelineZoomIn')
const btnZoomOut = $('timelineZoomOut')
const btnPanLeft = $('timelinePanLeft')
const btnPanRight = $('timelinePanRight')
const btnResumeAuto = $('timelineResumeAuto')

// Zoom to selection or zoom in on center
btnZoomIn.addEventListener('click', async () => {
    if (timeline.mode === 'live') {
        timeline.mode = 'detached'
    }

    if (timeline.selection) {
        // Zoom to fit selection
        timeline.viewStart = timeline.selection.start
        timeline.viewEnd = timeline.selection.end
    } else {
        // Zoom in on center
        const center = (timeline.viewStart + timeline.viewEnd) / 2
        const range = (timeline.viewEnd - timeline.viewStart) / 2
        timeline.viewStart = center - range / 2
        timeline.viewEnd = center + range / 2
    }

    await ensureTimelineDataCovers(timeline.viewStart, timeline.viewEnd)
    updateTimeLabels()
    drawTimeline()
    showResumeButton()
})

// Zoom out, keeping selection in view if present
btnZoomOut.addEventListener('click', async () => {
    if (timeline.mode === 'live') {
        timeline.mode = 'detached'
    }

    let center, range
    if (timeline.selection) {
        center = (timeline.selection.start + timeline.selection.end) / 2
        range = (timeline.selection.end - timeline.selection.start)
    } else {
        center = (timeline.viewStart + timeline.viewEnd) / 2
        range = (timeline.viewEnd - timeline.viewStart)
    }
    range = Math.max(1000, range * 2)
    timeline.viewStart = Math.max(0, Math.round(center - range / 2))
    timeline.viewEnd = Math.round(center + range / 2)

    await ensureTimelineDataCovers(timeline.viewStart, timeline.viewEnd)
    updateTimeLabels()
    drawTimeline()
    showResumeButton()
})

async function panTimeline(direction) {
    if (timeline.mode === 'live') {
        timeline.mode = 'detached'
    }

    const shift = Math.round((timeline.viewEnd - timeline.viewStart) / 4) * direction
    timeline.viewStart = Math.max(0, timeline.viewStart + shift)
    timeline.viewEnd += shift

    await ensureTimelineDataCovers(timeline.viewStart, timeline.viewEnd)
    updateTimeLabels()
    drawTimeline()
    showResumeButton()
}

btnPanLeft.addEventListener('click', () => panTimeline(-1))
btnPanRight.addEventListener('click', () => panTimeline(1))

btnResumeAuto.addEventListener('click', () => {
    btnResumeAuto.classList.add('hidden')
    loadTimelineData()
})

// ===========================================
// Initialize
// ===========================================
connect()
loadSessions()
loadOutputs()
