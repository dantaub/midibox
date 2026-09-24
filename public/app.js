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

// Build the 88-key keyboard (A0 to C8) into #piano. Geometry + key creation
// live in piano-roll.js so the popup and this view stay pixel-identical;
// interaction is wired below.
const keys = buildPianoKeys(piano)

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

// ===========================================
// Sustain pedal (CC 64)
//
// Two sources: the MIDI input's pedal, and the on-screen Ped. button (which
// sends CC 64 to the output, like the on-screen keys send notes). Either one
// down lights the button, and keys released meanwhile stay pale green
// ('sustained') until both are up - what the synth is still sounding.
// ===========================================
const btnPedal = $('btnPedal')
let pedalFromMidi = false
let pedalOnScreen = false
let pedalLatched = false
const sustainedNotes = new Set()

function pedalIsDown() {
    return pedalFromMidi || pedalOnScreen
}

function renderPedal() {
    btnPedal.classList.toggle('down', pedalIsDown())
    btnPedal.classList.toggle('latched', pedalLatched)
    if (!pedalIsDown()) {
        sustainedNotes.forEach(note => keys[note] && keys[note].classList.remove('sustained'))
        sustainedNotes.clear()
    }
}

function setOnScreenPedal(down) {
    if (down === pedalOnScreen) return
    pedalOnScreen = down
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pedal', down }))
    renderPedal()
}

// Hold = momentary; a quick click toggles a latch (for a mouse, which can't
// hold the pedal and play a key at once). On touch, hold it with one finger
// and play with the others.
const PEDAL_TAP_MS = 250
let pedalPressAt = 0
btnPedal.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    btnPedal.setPointerCapture(e.pointerId)
    pedalPressAt = performance.now()
    setOnScreenPedal(true)
})
function pedalRelease() {
    if (!pedalPressAt) return
    const tap = performance.now() - pedalPressAt < PEDAL_TAP_MS
    pedalPressAt = 0
    if (tap) pedalLatched = !pedalLatched
    else pedalLatched = false
    setOnScreenPedal(pedalLatched)
    renderPedal()
}
btnPedal.addEventListener('pointerup', pedalRelease)
btnPedal.addEventListener('pointercancel', pedalRelease)

// Hold P for the pedal (a latched pedal stays down after P is let go).
function pedalKeyEvent(e) {
    return (e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey &&
        e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT'
}
document.addEventListener('keydown', (e) => {
    if (!pedalKeyEvent(e)) return
    e.preventDefault()
    if (!e.repeat) setOnScreenPedal(true)
})
document.addEventListener('keyup', (e) => {
    if (pedalKeyEvent(e)) setOnScreenPedal(pedalLatched)
})
// Letting go of P in another window never sends keyup here.
window.addEventListener('blur', () => { if (!pedalLatched) setOnScreenPedal(false) })

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

// Hold exactly the keys under the fingers still down
function syncPianoTouches(e) {
    const currentNotes = new Set()
    for (const touch of e.touches) {
        const key = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.white-key, .black-key')
        if (key) currentNotes.add(parseInt(key.dataset.note))
    }
    pressedKeys.forEach(note => { if (!currentNotes.has(note)) sendNoteOff(note) })
    currentNotes.forEach(note => sendNoteOn(note))
}

piano.addEventListener('touchmove', (e) => {
    e.preventDefault()
    syncPianoTouches(e)
}, { passive: false })

// iOS cancels touches (a system gesture, an alert, the app switcher); without
// this the keys under them would stay held.
piano.addEventListener('touchcancel', syncPianoTouches)

// ===========================================
// Note Visualization
// ===========================================
const playbackNotes = new Set()

function activateNote(note, isPlayback = false) {
    if (!keys[note]) return
    const cls = isPlayback ? 'playback' : 'active'
    keys[note].classList.add(cls)
    if (isPlayback) playbackNotes.add(note)
    else {
        // Struck again: it's held by the key now, not the pedal
        keys[note].classList.remove('sustained')
        sustainedNotes.delete(note)
    }
}

function deactivateNote(note, isPlayback = false) {
    if (!keys[note]) return
    const cls = isPlayback ? 'playback' : 'active'
    keys[note].classList.remove(cls)
    if (isPlayback) playbackNotes.delete(note)
    else if (pedalIsDown()) {
        keys[note].classList.add('sustained')
        sustainedNotes.add(note)
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
const timelineCanvas = $('timelineCanvas')
const timelineContainer = $('timelineContainer')
const timelineSelection = $('timelineSelection')
const timelineStart = $('timelineStart')
const timelineEnd = $('timelineEnd')
const timelineDuration = $('timelineDuration')
const timelineSelectionInfo = $('timelineSelectionInfo')
const ctx = timelineCanvas.getContext('2d')

// Unified timeline state
const timeline = {
    // View configuration - separate durations for live vs detached modes
    liveDuration: 1 * 60 * 1000,  // time span in ms for live mode (default 1 minute)
    detachedDuration: 30 * 60 * 1000,  // time span in ms for detached/frozen mode (default 30 minutes)
    startTime: null,           // if null = live mode (end is now), if set = detached

    // Playback mode (separate from live/detached)
    isPlaying: false,

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

    // Direction: false = time runs downward, true = upward
    flipped: false,

    // Render-only chord alignment: draw a chord's onsets at a shared time. Notes
    // are chained into one chord while each consecutive onset is within
    // alignGapMs of the last (chord notes arrive at a near-constant serial rate,
    // ~5 ms on a USB-DIN adapter, whereas deliberate notes are tens of ms apart),
    // capped at alignMaxSpanMs so a fast run can't collapse entirely. The
    // events/DB are never changed.
    alignChords: false,
    alignGapMs: 12,
    alignMaxSpanMs: 60,

    // Live update rate: a note length (in beats) at a tempo, or a free-running
    // 60Hz redraw when `smooth` is on
    tempo: 120,
    rateBeats: 1,
    smooth: false,

    // Data cache
    events: [],
    sessions: [],

    // Canvas rendering
    dpr: window.devicePixelRatio || 1
}

// Helper functions for view bounds
function getDuration() {
    return timeline.startTime === null ? timeline.liveDuration : timeline.detachedDuration
}

function getViewStart() {
    if (timeline.startTime === null) {
        return Date.now() - timeline.liveDuration
    }
    return timeline.startTime
}

function getViewEnd() {
    if (timeline.startTime === null) {
        return Date.now()
    }
    return timeline.startTime + timeline.detachedDuration
}

function isLive() {
    return timeline.startTime === null
}

// Freeze the live view into detached mode, pinning "now" at the bottom edge so
// the last detachedDuration of real data stays in view (no empty future). A
// no-op when already detached.
function freezeView() {
    if (isLive()) timeline.startTime = getViewEnd() - timeline.detachedDuration
}

// Pitch bounds for the octave grid; the layout + noteToX live in piano-roll.js.
const minNote = PITCH_MIN
const maxNote = PITCH_MAX

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

// Save/restore timeline view state from localStorage
let lastSavedView = null

function saveTimelineView() {
    const state = JSON.stringify({
        liveDuration: timeline.liveDuration,
        detachedDuration: timeline.detachedDuration,
        startTime: timeline.startTime
    })

    // Called on every redraw, so don't write what's already stored
    if (state === lastSavedView) return
    lastSavedView = state

    console.log('[Timeline] Saving state:', state)
    localStorage.setItem('midibox-timeline-view', state)
}

function loadSavedTimelineView() {
    try {
        const raw = localStorage.getItem('midibox-timeline-view')
        console.log('[Timeline] Raw localStorage:', raw)
        if (raw) {
            const state = JSON.parse(raw)

            // Handle backward compatibility: old format had a single 'duration' field
            if (state.duration !== undefined && state.liveDuration === undefined) {
                console.log('[Timeline] Migrating old format with single duration')
                state.detachedDuration = state.duration
                state.liveDuration = 1 * 60 * 1000  // default to 1 minute for live
                delete state.duration
            }

            // Validate format
            if (typeof state.liveDuration !== 'number' || state.liveDuration <= 0 ||
                typeof state.detachedDuration !== 'number' || state.detachedDuration <= 0) {
                console.log('[Timeline] Invalid/old localStorage format, clearing')
                localStorage.removeItem('midibox-timeline-view')
                return null
            }

            // Only restore detached views if recent enough (within last 30 days)
            if (state.startTime !== null) {
                const now = Date.now()
                const maxAge = 30 * 24 * 60 * 60 * 1000
                const viewEnd = state.startTime + state.detachedDuration
                if (now - viewEnd > maxAge) {
                    console.log('[Timeline] Saved view too old, ignoring')
                    return null  // Too old, go to live mode
                }
            }
            console.log('[Timeline] Loaded valid state:', JSON.stringify(state))
            return state
        }
        console.log('[Timeline] No saved state found')
    } catch (e) {
        console.error('[Timeline] Failed to load saved view:', e)
    }
    return null
}

// Which way time runs is remembered on its own, so it survives a view state
// that has gone stale
function saveTimelineDirection() {
    localStorage.setItem('midibox-timeline-flip', timeline.flipped ? '1' : '0')
}

function loadTimelineDirection() {
    timeline.flipped = localStorage.getItem('midibox-timeline-flip') === '1'
}

async function loadTimelineData() {
    console.log('[Timeline] loadTimelineData called')
    loadTimelineDirection()
    const saved = loadSavedTimelineView()

    if (saved) {
        console.log('[Timeline] Applying saved state:', JSON.stringify(saved))
        timeline.liveDuration = saved.liveDuration
        timeline.detachedDuration = saved.detachedDuration
        timeline.startTime = saved.startTime
    } else {
        console.log('[Timeline] No saved state, using defaults (live mode)')
    }

    console.log('[Timeline] After load - liveDuration:', timeline.liveDuration, 'detachedDuration:', timeline.detachedDuration, 'startTime:', timeline.startTime, 'isLive:', isLive())

    updateLiveButton()

    await fetchTimelineEvents(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
}

// Force return to live mode (used by Resume button and Home key)
async function returnToLive() {
    timeline.startTime = null
    // Note: liveDuration is already in timeline, no need to restore from saved state
    updateLiveButton()

    await fetchTimelineEvents(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
}

// Compact human-readable span, e.g. "5m", "1h 40s", "1m 30s"
function formatDuration(ms) {
    const total = Math.round(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const parts = []
    if (h) parts.push(`${h}h`)
    if (m) parts.push(`${m}m`)
    if (s || parts.length === 0) parts.push(`${s}s`)
    return parts.join(' ')
}

function updateTimeLabels() {
    // Label the top and bottom edges of the view, whichever way time runs
    const top = timeline.flipped ? getViewEnd() : getViewStart()
    const bottom = timeline.flipped ? getViewStart() : getViewEnd()
    timelineStart.textContent = `\u2191 ${new Date(top).toLocaleTimeString()}`
    timelineEnd.textContent = `${new Date(bottom).toLocaleTimeString()} \u2193`
    // Center label: the span currently in view
    timelineDuration.textContent = `\u2195 ${formatDuration(getDuration())}`
    // Persist view state
    saveTimelineView()
}

// Session overlay colors
const sessionColors = [
    { bg: 'rgba(59, 130, 246, 0.25)', border: 'rgba(59, 130, 246, 0.8)' },   // blue
    { bg: 'rgba(16, 185, 129, 0.25)', border: 'rgba(16, 185, 129, 0.8)' },   // green
    { bg: 'rgba(245, 158, 11, 0.25)', border: 'rgba(245, 158, 11, 0.8)' },   // amber
    { bg: 'rgba(139, 92, 246, 0.25)', border: 'rgba(139, 92, 246, 0.8)' },   // purple
    { bg: 'rgba(236, 72, 153, 0.25)', border: 'rgba(236, 72, 153, 0.8)' },   // pink
]

// Calculate lane assignments for overlapping sessions.
// The timeline runs top-to-bottom, so lanes are side-by-side columns.
function assignOverlapLanes(sessions) {
    const lanes = []
    const laneEnds = []  // tracks when each lane becomes free

    sessions.forEach(session => {
        let lane = 0
        while (laneEnds[lane] && laneEnds[lane] > session.start_time) {
            lane++
        }
        lanes.push(lane)
        laneEnds[lane] = session.end_time
    })

    return lanes
}

// Geometry of session lanes, shared by drawing and hit testing
function getSessionLayout(width, height, viewStart, viewEnd) {
    if (!timeline.sessions || timeline.sessions.length === 0) return null
    const duration = viewEnd - viewStart

    const visibleSessions = timeline.sessions.filter(s =>
        s.end_time >= viewStart && s.start_time <= viewEnd
    )
    if (visibleSessions.length === 0) return null

    const sorted = [...visibleSessions].sort((a, b) => a.start_time - b.start_time)
    const lanes = assignOverlapLanes(sorted)
    const laneCount = Math.max(...lanes) + 1
    const laneWidth = Math.min(110, width / Math.max(2, laneCount + 1))

    const ty = (t) => {
        const ratio = (t - viewStart) / duration
        return timeline.flipped ? height - ratio * height : ratio * height
    }

    const bands = sorted.map((session, i) => {
        const yA = ty(session.start_time)
        const yB = ty(session.end_time)
        return {
            session,
            x: lanes[i] * laneWidth,
            laneWidth,
            y1: Math.max(0, Math.min(yA, yB)),
            y2: Math.min(height, Math.max(yA, yB)),
        }
    })

    return { bands, laneWidth }
}

function drawSessionOverlays(width, height, viewStart, viewEnd) {
    const layout = getSessionLayout(width, height, viewStart, viewEnd)
    if (!layout) return

    layout.bands.forEach(({ session, x, laneWidth, y1, y2 }) => {
        const colorIndex = session.id % sessionColors.length
        const colors = sessionColors[colorIndex]
        const isSelected = session.id === timeline.selectedSessionId
        const bandWidth = laneWidth - 2
        const bandHeight = Math.max(2, y2 - y1)

        // Draw background
        ctx.fillStyle = isSelected ? colors.bg.replace('0.25', '0.4') : colors.bg
        ctx.fillRect(x, y1, bandWidth, bandHeight)

        // Draw border for selected session
        if (isSelected) {
            // Only draw resize handles when in edit mode (edit panel is open)
            const isEditing = !$('editPanel').classList.contains('hidden')
            const EDIT_COLOR = '#ff2fd0'  // bright pink, distinct from any session's own color

            ctx.strokeStyle = isEditing ? EDIT_COLOR : colors.border
            ctx.lineWidth = isEditing ? 3 : 2
            ctx.strokeRect(x + 1, y1 + 1, bandWidth - 2, bandHeight - 2)

            if (isEditing) {
                const handleHeight = 6
                ctx.fillStyle = EDIT_COLOR

                // Start (top) handle
                ctx.fillRect(x, y1, bandWidth, handleHeight)

                // End (bottom) handle
                ctx.fillRect(x, y2 - handleHeight, bandWidth, handleHeight)

                // Store selected session bounds for hit testing (only in edit mode)
                timeline.selectedSessionBounds = { x, laneWidth, y1, y2, sessionId: session.id }
            } else {
                // Clear bounds when not editing
                timeline.selectedSessionBounds = null
            }
        }

        // Draw label if tall enough
        if (bandHeight > 16) {
            ctx.fillStyle = '#fff'
            ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
            const label = session.song_name || session.performer || `Session ${session.id}`
            ctx.save()
            ctx.beginPath()
            ctx.rect(x, y1, bandWidth, bandHeight)
            ctx.clip()
            ctx.fillText(label, x + 4, y1 + 13, bandWidth - 8)
            ctx.restore()
        }
    })
}

function drawTimeline() {
    const width = timelineContainer.clientWidth
    const height = timelineContainer.clientHeight
    const viewStart = getViewStart()
    const viewEnd = getViewEnd()
    const duration = getDuration()
    ctx.clearRect(0, 0, width, height)

    // Pitch runs left to right, matching the piano above; time runs down the
    // screen, or up when flipped.
    const ty = (t) => {
        const ratio = (t - viewStart) / duration
        return timeline.flipped ? height - ratio * height : ratio * height
    }

    // Draw background grid (pitch lines, one per octave)
    ctx.strokeStyle = '#1a1a2e'
    ctx.lineWidth = 1
    for (let note = minNote; note <= maxNote; note++) {
        if (note % 12 !== 0) continue  // C of each octave
        const { x } = noteToX(note, width)
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
    }

    // Draw time grid (horizontal lines every minute)
    ctx.strokeStyle = '#252550'
    const minuteMs = 60 * 1000
    const startMinute = Math.ceil(viewStart / minuteMs) * minuteMs
    for (let t = startMinute; t < viewEnd; t += minuteMs) {
        const y = ty(t)
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
        ctx.stroke()
    }

    // Draw session overlays as colored backgrounds
    drawSessionOverlays(width, height, viewStart, viewEnd)

    // Note bars: pair on/off, optionally align chords (display-only), then draw.
    // The pairing/align/draw live in piano-roll.js, shared with the popup.
    const noteBars = pairNoteBars(timeline.events, viewEnd)
    // Pedal tails, as on the Import/Export roll. Live, a pedal still down
    // runs to the end of the view (now), so the tails grow as you play.
    applySustain(noteBars, timeline.events, viewEnd)
    if (timeline.alignChords) {
        alignChordBars(noteBars, timeline.alignGapMs, timeline.alignMaxSpanMs)
    }
    drawNoteBarsVertical(ctx, noteBars, width, ty)

    // Draw selection overlay (a horizontal band spanning all pitches)
    if (timeline.selection) {
        const selY1 = ty(timeline.selection.start)
        const selY2 = ty(timeline.selection.end)
        ctx.save()
        ctx.globalAlpha = 0.3
        ctx.fillStyle = '#e94560'
        ctx.fillRect(0, Math.min(selY1, selY2), width, Math.abs(selY2 - selY1))
        ctx.restore()
    }

    // Draw playback indicator
    if (timeline.isPlaying && timeline.playbackPosition != null) {
        const y = ty(timeline.playbackPosition)
        if (y >= 0 && y <= height) {
            ctx.save()
            // Red playback line
            ctx.strokeStyle = '#ef4444'
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.moveTo(0, y)
            ctx.lineTo(width, y)
            ctx.stroke()
            // Playhead triangle at the left edge
            ctx.beginPath()
            ctx.moveTo(0, y - 6)
            ctx.lineTo(0, y + 6)
            ctx.lineTo(8, y)
            ctx.closePath()
            ctx.fillStyle = '#ef4444'
            ctx.fill()
            ctx.restore()
        }
    }

    // Update the selection overlay position (HTML element with handles)
    updateSelectionUI()
}

function timeToY(time) {
    const height = timelineContainer.clientHeight
    const ratio = (time - getViewStart()) / getDuration()
    return timeline.flipped ? height - ratio * height : ratio * height
}

function yToTime(y) {
    const height = timelineContainer.clientHeight
    const ratio = timeline.flipped ? (height - y) / height : y / height
    return getViewStart() + ratio * getDuration()
}

// Sign of "later" on screen: +1 when time runs downward, -1 when flipped.
// Used so scrolling and the pan buttons keep moving the view the same way.
function timeDirection() {
    return timeline.flipped ? -1 : 1
}

function updateSelectionUI() {
    if (timeline.selection) {
        const y1 = timeToY(timeline.selection.start)
        const y2 = timeToY(timeline.selection.end)
        timelineSelection.style.top = Math.min(y1, y2) + 'px'
        timelineSelection.style.height = Math.abs(y2 - y1) + 'px'
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
        }
    }

    updatePlayButtons()
}

// True between playback start/end, whatever started it. Declared here because
// the timeline draws (and reconciles the buttons) during startup.
let playbackActive = false

function hasPlayableRange() {
    return !!timeline.selection || timeline.selectedSessionId != null
}

// Play is available only with something selected, and never mid-playback
// (including MIDI file playback, which doesn't drive the timeline animation)
function updatePlayButtons() {
    const enabled = hasPlayableRange() && !timeline.isPlaying && !playbackActive
    btnPlayback.disabled = !enabled
    $('timelinePlaySelection').disabled = !enabled
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
let pinchState = null  // two-finger touch pan/zoom, see below
const handleLeft = $('handleLeft')
const handleRight = $('handleRight')

// The Live button reflects whether the view follows "now", and decides which
// half of the controls row is on show: the update rate while live, or
// navigation and selection tools once the view is frozen.
function updateLiveButton() {
    const live = isLive()
    const btn = $('btnLiveToggle')
    btn.classList.toggle('active', live)
    btn.title = live
        ? 'Following live - click to freeze the view'
        : 'Frozen - click to follow live (Home)'

    $('liveRateControls').classList.toggle('hidden', !live)
    $('timelineNavControls').classList.toggle('hidden', live)
}


// Find session at a given pixel position on the timeline
function getSessionAtPosition(x, y) {
    const layout = getSessionLayout(
        timelineContainer.clientWidth,
        timelineContainer.clientHeight,
        getViewStart(),
        getViewEnd()
    )
    if (!layout) return null

    for (const band of layout.bands) {
        if (x >= band.x && x <= band.x + band.laneWidth && y >= band.y1 && y <= band.y2) {
            return band.session
        }
    }

    return null
}

// True when the point is on a selected session's start/end resize handle
function sessionHandleAt(x, y) {
    const b = timeline.selectedSessionBounds
    if (!b) return null
    const grab = 8  // slightly larger hit area than visual
    if (x < b.x || x > b.x + b.laneWidth) return null
    if (y >= b.y1 - grab && y <= b.y1 + grab) return 'session-left'
    if (y >= b.y2 - grab && y <= b.y2 + grab) return 'session-right'
    return null
}

// Touch events give coordinates on touches/changedTouches instead of the
// event itself; this normalizes both so the drag/pinch logic below can share
// one code path between mouse and single-finger touch input.
function eventPoint(e) {
    if (e.touches && e.touches.length) return e.touches[0]
    if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0]
    return e
}

function startLeftHandleDrag(e) {
    e.stopPropagation()
    e.preventDefault()
    if (!timeline.selection) return
    dragState = { mode: 'left' }
}
handleLeft.addEventListener('mousedown', startLeftHandleDrag)
handleLeft.addEventListener('touchstart', startLeftHandleDrag, { passive: false })

function startRightHandleDrag(e) {
    e.stopPropagation()
    e.preventDefault()
    if (!timeline.selection) return
    dragState = { mode: 'right' }
}
handleRight.addEventListener('mousedown', startRightHandleDrag)
handleRight.addEventListener('touchstart', startRightHandleDrag, { passive: false })

function startTimelineDrag(e) {
    if (e.target.classList.contains('timeline-handle')) return

    const p = eventPoint(e)
    const rect = timelineContainer.getBoundingClientRect()
    const x = p.clientX - rect.left
    const y = p.clientY - rect.top

    // Check if clicking on session handles
    const handleMode = sessionHandleAt(x, y)
    if (handleMode) {
        e.preventDefault()
        dragState = { mode: handleMode, sessionId: timeline.selectedSessionBounds.sessionId }
        return
    }

    const time = yToTime(y)
    dragState = { mode: 'new', startTime: time, startY: y, dragging: false }
}
timelineContainer.addEventListener('mousedown', startTimelineDrag)
timelineContainer.addEventListener('touchstart', (e) => {
    // A second finger means a pinch/pan gesture is starting instead (below);
    // bail out of any single-finger drag that may have just begun.
    if (e.touches.length !== 1) { dragState = null; return }
    startTimelineDrag(e)
}, { passive: false })

function moveTimelineDrag(e) {
    if (!dragState) return
    const p = eventPoint(e)
    const rect = timelineContainer.getBoundingClientRect()
    const y = Math.max(0, Math.min(rect.height, p.clientY - rect.top))
    const time = yToTime(y)

    if (dragState.mode === 'new') {
        // Only start selection after dragging a few pixels
        const dy = Math.abs(y - dragState.startY)
        if (dy > 5) dragState.dragging = true

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
}
document.addEventListener('mousemove', moveTimelineDrag)
document.addEventListener('touchmove', (e) => {
    if (pinchState) return  // two-finger pinch/pan is handled separately, below
    if (dragState) { e.preventDefault(); moveTimelineDrag(e) }
}, { passive: false })

function updateEditPanelTimeInfo(session) {
    const start = new Date(session.start_time)
    const end = new Date(session.end_time)
    const durationSec = Math.round((session.end_time - session.start_time) / 1000)
    const mins = Math.floor(durationSec / 60)
    const secs = durationSec % 60
    $('editTimeInfo').textContent = `${start.toLocaleTimeString()} - ${end.toLocaleTimeString()} (${mins}:${secs.toString().padStart(2, '0')})`
}

// Tracks the last tap's time/position so a quick second tap in roughly the
// same spot can stand in for dblclick (touch has no double-click event).
let lastTapAt = 0
let lastTapPos = null

function endTimelineDrag(e) {
    if (!dragState) return

    // If we dragged, switch to detached mode
    if (dragState.dragging) {
        freezeView()  // pin "now" at the bottom edge (no-op if already detached)
        updateLiveButton()  // reconcile the controls either way
    }

    // If we clicked (not dragged), check if we clicked on a session
    if (!dragState.dragging && dragState.mode === 'new') {
        const p = eventPoint(e)
        const rect = timelineContainer.getBoundingClientRect()
        const x = p.clientX - rect.left
        const y = p.clientY - rect.top

        const isTouch = e.type === 'touchend'
        const now = Date.now()
        const isDoubleTap = isTouch && now - lastTapAt < 350 && lastTapPos &&
            Math.abs(p.clientX - lastTapPos.x) < 30 && Math.abs(p.clientY - lastTapPos.y) < 30
        lastTapAt = isDoubleTap ? 0 : now
        lastTapPos = isDoubleTap ? null : { x: p.clientX, y: p.clientY }

        const session = getSessionAtPosition(x, y)
        if (session) {
            // Select this session
            const selected = selectSession(session.id, session.start_time, session.end_time)

            // Also highlight in the sidebar list
            sessionList.querySelectorAll('.session-item').forEach(item => {
                item.classList.toggle('selected', parseInt(item.dataset.id, 10) === session.id)
            })

            // A double-tap on a session opens it for editing, mirroring dblclick
            if (isDoubleTap) {
                selected.then(() => {
                    showEditPanel(session.id)
                    $('editPerformer').focus()
                })
            }
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
}
document.addEventListener('mouseup', endTimelineDrag)
document.addEventListener('touchend', endTimelineDrag)
// A cancelled touch isn't a tap: just drop the drag. A drag left behind would
// keep swallowing touchmove page-wide and treat the next touchend anywhere
// (say, on the edit panel's Save) as a tap on the timeline.
document.addEventListener('touchcancel', () => { dragState = null })

// Double-click on session to open edit panel (desktop; touch uses double-tap
// detection inside endTimelineDrag above)
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

        if (sessionHandleAt(x, y)) {
            timelineContainer.style.cursor = 'ns-resize'
            return
        }
    }
    timelineContainer.style.cursor = 'crosshair'
})

// Mouse wheel: scroll = pan through time, ctrl/shift+scroll = zoom
timelineCanvas.addEventListener('wheel', async (e) => {
    e.preventDefault()

    // Enter detached mode if currently live
    if (isLive()) {
        freezeView()
        updateLiveButton()
    }

    const zooming = e.ctrlKey || e.shiftKey || e.metaKey

    // Plain scroll = pan (time runs down the screen)
    if (!zooming) {
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        const panAmount = (delta / 500) * timeline.detachedDuration * timeDirection()
        timeline.startTime = Math.max(0, timeline.startTime + panAmount)

        await ensureTimelineDataCovers(getViewStart(), getViewEnd())
        updateTimeLabels()
        drawTimeline()
        return
    }

    if (Math.abs(e.deltaY) < 5) return  // Ignore tiny movements

    // Zoom around the time under the pointer
    const rect = timelineCanvas.getBoundingClientRect()
    let ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    if (timeline.flipped) ratio = 1 - ratio
    const centerTime = timeline.startTime + timeline.detachedDuration * ratio

    // Gentler zoom factor (1.1 instead of 1.2)
    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9
    const newDuration = Math.max(5000, timeline.detachedDuration * zoomFactor)  // Min 5 seconds

    let newStart = centerTime - newDuration * ratio

    // Try to keep selection visible when zooming
    if (timeline.selection) {
        const sel = timeline.selection
        const newEnd = newStart + newDuration
        if (sel.start < newStart) {
            newStart = sel.start - newDuration * 0.05
        } else if (sel.end > newEnd) {
            newStart = sel.end - newDuration + newDuration * 0.05
        }
    }

    timeline.startTime = Math.max(0, newStart)
    timeline.detachedDuration = newDuration

    await ensureTimelineDataCovers(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
}, { passive: false })

// Two-finger touch: pinch to zoom, drag the midpoint to pan (touch has no
// wheel event, so this is the mobile equivalent of the handler above).
function touchMidpoint(t0, t1, rect) {
    let ratio = Math.max(0, Math.min(1, ((t0.clientY + t1.clientY) / 2 - rect.top) / rect.height))
    if (timeline.flipped) ratio = 1 - ratio
    return ratio
}

timelineContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return
    e.preventDefault()
    dragState = null  // a pinch overrides any single-finger drag just started

    if (isLive()) {
        freezeView()
        updateLiveButton()
    }

    const rect = timelineContainer.getBoundingClientRect()
    const ratio = touchMidpoint(e.touches[0], e.touches[1], rect)
    pinchState = {
        startDist: Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY),
        startDuration: timeline.detachedDuration,
        // The instant under the fingers' midpoint at gesture start; keeping
        // this locked under the (moving) midpoint gives both pan and zoom.
        centerTime: timeline.startTime + timeline.detachedDuration * ratio,
    }
}, { passive: false })

document.addEventListener('touchmove', async (e) => {
    if (!pinchState || e.touches.length !== 2) return
    e.preventDefault()

    const rect = timelineContainer.getBoundingClientRect()
    const dist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY)
    const scale = dist / pinchState.startDist
    const newDuration = Math.max(5000, pinchState.startDuration / scale)
    const ratio = touchMidpoint(e.touches[0], e.touches[1], rect)

    timeline.startTime = Math.max(0, pinchState.centerTime - newDuration * ratio)
    timeline.detachedDuration = newDuration

    await ensureTimelineDataCovers(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
}, { passive: false })

function endPinch(e) {
    if (e.touches.length < 2) pinchState = null
}
document.addEventListener('touchend', endPinch)
document.addEventListener('touchcancel', endPinch)

// Keyboard navigation
document.addEventListener('keydown', async (e) => {
    // Escape should end a session edit even while a text field inside the
    // edit panel is focused - it's the only shortcut that needs to reach
    // through typing.
    if (e.key === 'Escape' && !editPanel.classList.contains('hidden')) {
        e.preventDefault()
        $('btnEditCancel').click()
        return
    }

    // Don't handle keys when in input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

    switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
            e.preventDefault()
            await panTimeline(-1 * timeDirection())  // toward the top of the view
            break
        case 'ArrowDown':
        case 'ArrowRight':
            e.preventDefault()
            await panTimeline(1 * timeDirection())   // toward the bottom
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
            returnToLive()
            break
        case ' ':  // Space - toggle playback
            e.preventDefault()
            if (timeline.isPlaying) {
                await fetch('/api/playback/stop', { method: 'POST' })
            } else if (timeline.selection || timeline.selectedSessionId != null) {
                $('timelinePlaySelection').click()
            }
            break
        case 'Escape':
            e.preventDefault()
            if (timeline.isPlaying) {
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

    if (playStart == null || playEnd == null) return

    const output = outputSelect.value || undefined

    // Set view to show the selection with some padding
    const selDuration = playEnd - playStart
    const padding = selDuration * 0.1
    timeline.startTime = playStart - padding
    timeline.detachedDuration = selDuration + padding * 2

    await ensureTimelineDataCovers(getViewStart(), getViewEnd())
    updateTimeLabels()

    try {
        // Start smooth playback animation
        startPlaybackAnimation(playStart, playEnd)
        $('timelineStop').disabled = false
        $('timelinePlaySelection').disabled = true

        const res = await fetch('/api/playback/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start: playStart,
                end: playEnd,
                output
            }),
        })

        if (!res.ok) {
            const info = await res.json().catch(() => ({}))
            stopPlaybackAnimation()
            $('timelineStop').disabled = true
            updateSelectionUI()
            drawTimeline()
            alert(`Playback failed: ${info.error || res.status}`)
        }
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
    if (!isLive()) return

    timeline.events.push(event)

    // Nothing refetches the window while live, so drop events that have
    // scrolled well past the top of the view to bound memory. The margin
    // leaves room to zoom out a little without a round trip.
    const keepFrom = getViewStart() - timeline.liveDuration * 2
    if (timeline.events.length > 2000 && timeline.events[0].timestamp < keepFrom) {
        timeline.events = timeline.events.filter(e => e.timestamp >= keepFrom)
    }

    // In live mode, the view auto-updates, just redraw
    drawTimeline()
}

// Initialize timeline
window.addEventListener('resize', resizeCanvas)
resizeCanvas()
loadTimelineData()

// ===========================================
// Live update rate (musical: a note length at a tempo)
// ===========================================
const timelineRate = $('timelineRate')
const timelineTempo = $('timelineTempo')
const tempoReadout = $('tempoReadout')

// How often the live view redraws, in milliseconds
function liveIntervalMs() {
    return (60000 / timeline.tempo) * timeline.rateBeats
}

function updateTempoReadout() {
    const ms = Math.round(liveIntervalMs())
    tempoReadout.textContent = `${timeline.tempo} BPM`
    tempoReadout.title = `${timelineRate.selectedOptions[0]?.textContent.trim()} at ${timeline.tempo} BPM = ${ms} ms`
    timelineTempo.title = `Tempo: ${timeline.tempo} BPM (updates every ${ms} ms)`
}

function saveLiveRate() {
    localStorage.setItem('midibox-live-rate', JSON.stringify({
        tempo: timeline.tempo,
        beats: timeline.rateBeats,
    }))
}

function loadLiveRate() {
    try {
        const saved = JSON.parse(localStorage.getItem('midibox-live-rate') || 'null')
        if (saved) {
            if (Number.isFinite(saved.tempo)) timeline.tempo = Math.min(220, Math.max(40, saved.tempo))
            if (Number.isFinite(saved.beats) && saved.beats > 0) timeline.rateBeats = saved.beats
        }
    } catch (e) {
        console.error('Failed to load live rate:', e)
    }

    timelineTempo.value = String(timeline.tempo)
    // Match the stored note length to an option (floating point, so compare loosely)
    const option = [...timelineRate.options].find(o => Math.abs(parseFloat(o.value) - timeline.rateBeats) < 1e-6)
    if (option) timelineRate.value = option.value
    updateTempoReadout()
}

const btnSmooth = $('timelineSmooth')
let smoothFrameId = null

function smoothFrame() {
    smoothFrameId = requestAnimationFrame(smoothFrame)
    if (!isLive()) return
    updateTimeLabels()
    drawTimeline()
}

// 60Hz redraw (whatever the display runs at) instead of stepping on the note
function setSmooth(on) {
    timeline.smooth = on
    btnSmooth.classList.toggle('active', on)
    btnSmooth.title = on
        ? 'Redrawing continuously - click to step on the note again'
        : 'Redraw continuously at 60 Hz instead of on the note'

    // The note length and tempo have no effect while this runs
    timelineRate.disabled = on
    timelineTempo.disabled = on
    localStorage.setItem('midibox-smooth', on ? '1' : '0')

    if (on) {
        clearTimeout(liveTickTimer)
        liveTickTimer = null
        if (smoothFrameId == null) smoothFrameId = requestAnimationFrame(smoothFrame)
    } else {
        if (smoothFrameId != null) cancelAnimationFrame(smoothFrameId)
        smoothFrameId = null
        scheduleLiveTick()
    }
}

btnSmooth.addEventListener('click', () => setSmooth(!timeline.smooth))

timelineRate.addEventListener('change', () => {
    timeline.rateBeats = parseFloat(timelineRate.value)
    saveLiveRate()
    updateTempoReadout()
    scheduleLiveTick()
})

timelineTempo.addEventListener('input', () => {
    timeline.tempo = parseInt(timelineTempo.value, 10)
    saveLiveRate()
    updateTempoReadout()
    scheduleLiveTick()
})

// While live, keep the view moving at the chosen rate. No database reads are
// needed: every captured event arrives over the WebSocket and is appended to
// the cache, so a redraw is all that's left to do.
let liveTickTimer = null

function liveTick() {
    liveTickTimer = null

    if (isLive()) {
        updateTimeLabels()
        drawTimeline()
    }

    scheduleLiveTick()
}

function scheduleLiveTick() {
    clearTimeout(liveTickTimer)
    if (timeline.smooth) return  // the animation frame loop is driving instead
    liveTickTimer = setTimeout(liveTick, liveIntervalMs())
}

loadLiveRate()
setSmooth(localStorage.getItem('midibox-smooth') === '1')
scheduleLiveTick()

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
            } else if (data.type === 'output') {
                setOutputStatus(data.output)
            } else if (data.type === 'input') {
                setCurrentInput(data.input)
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

// Other views (see history.js) can observe the live MIDI stream
const liveEventHooks = []
function onLiveEvent(fn) {
    liveEventHooks.push(fn)
}

// ...and the playback stream (see io.js: the inline preview's moving playhead)
const playbackEventHooks = []
function onPlaybackEvent(fn) {
    playbackEventHooks.push(fn)
}
const playbackStatusHooks = []
function onPlaybackStatus(fn) {
    playbackStatusHooks.push(fn)
}

function handleMidiEvent(event) {
    if (isNoteOn(event)) activateNote(event.note, false)
    else if (isNoteOff(event)) deactivateNote(event.note, false)
    else if (event.type === 'cc' && event.control === 64) {
        pedalFromMidi = event.value >= 64
        renderPedal()
    }
    addLogEntry(event)
    addEventToTimeline(event)
    for (const fn of liveEventHooks) {
        try {
            fn(event)
        } catch (err) {
            console.error('Live event hook failed:', err)
        }
    }
}

// Smooth playback animation
function startPlaybackAnimation(startTime, endTime) {
    timeline.playbackBounds = { start: startTime, end: endTime }
    timeline.playbackStartedAt = null  // Will be calibrated by first server event
    timeline.isPlaying = true
    timeline.playbackPosition = startTime

    function animate() {
        if (!timeline.isPlaying || !timeline.playbackBounds) return

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
    timeline.isPlaying = false
}

function handlePlaybackStatus(data) {
    if (data.status === 'started') {
        playbackActive = true
        progressContainer.classList.add('active')
        btnPlayback.disabled = true
        btnStop.disabled = false
        $('timelineStop').disabled = false
        $('timelinePlaySelection').disabled = true
    } else if (data.status === 'ended') {
        playbackActive = false
        stopPlaybackAnimation()
        progressContainer.classList.remove('active')
        btnPlayback.disabled = false
        btnStop.disabled = true
        $('timelineStop').disabled = true
        updatePlayButtons()
        clearPlaybackNotes()
        progressFill.style.width = '0%'
        progressText.textContent = 'Complete'
        drawTimeline()
    }

    for (const fn of playbackStatusHooks) {
        try { fn(data.status) } catch (err) { console.error('Playback status hook failed:', err) }
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

    for (const fn of playbackEventHooks) {
        try { fn(data) } catch (err) { console.error('Playback hook failed:', err) }
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
btnPlayback.addEventListener('click', async () => {
    // Use the same logic as the timeline play button
    $('timelinePlaySelection').click()
})

btnStop.addEventListener('click', async () => {
    try {
        await fetch('/api/playback/stop', { method: 'POST' })
    } catch (err) {
        console.error('Stop failed:', err)
    }
})

// Settings persistence
function saveSettings() {
    const settings = {
        outputDevice: outputSelect.value,
        thruEnabled: thruToggle.checked
    }
    localStorage.setItem('midibox-settings', JSON.stringify(settings))
}

function loadSettings() {
    try {
        const saved = localStorage.getItem('midibox-settings')
        if (saved) {
            return JSON.parse(saved)
        }
    } catch (e) {
        console.error('Failed to load settings:', e)
    }
    return null
}

async function loadOutputs() {
    try {
        const res = await fetch('/api/midi/outputs')
        const outputs = await res.json()
        const settings = loadSettings()

        if (outputs.length === 0) {
            outputSelect.innerHTML = '<option value="">No outputs found</option>'
        } else {
            // Try to restore saved output device
            const savedOutput = settings?.outputDevice
            outputSelect.innerHTML = outputs.map((o) => {
                const isSelected = savedOutput ? o === savedOutput : false
                return `<option value="${o}" ${isSelected ? 'selected' : ''}>${o.split('/').pop()}</option>`
            }).join('')

            // If saved output wasn't found, select the first one
            if (savedOutput && !outputs.includes(savedOutput)) {
                outputSelect.selectedIndex = 0
            }
        }
    } catch (err) {
        outputSelect.innerHTML = '<option value="">Error loading outputs</option>'
    }
}

// ===========================================
// Input Device Selection (dropdown beside the status text)
// ===========================================
const btnInputMenu = $('btnInputMenu')
const inputMenu = $('inputMenu')

// Device the server is currently recording from, or null
let currentInput = null

function setCurrentInput(name) {
    currentInput = name || null
    btnInputMenu.title = currentInput
        ? `Input: ${currentInput.split('/').pop()} - click to change`
        : 'Select MIDI input'
}

async function loadInputStatus() {
    try {
        const res = await fetch('/api/midi/input')
        const data = await res.json()
        setCurrentInput(data.input)
    } catch (err) {
        console.error('Failed to load input status:', err)
    }
}

async function renderInputMenu() {
    let inputs = []
    try {
        const res = await fetch('/api/midi/inputs')
        inputs = await res.json()
    } catch (err) {
        console.error('Failed to list inputs:', err)
    }

    const items = inputs.map(name => {
        const selected = name === currentInput ? ' selected' : ''
        return `<div class="input-menu-item${selected}" data-input="${name}">${name.split('/').pop()}</div>`
    })
    if (inputs.length === 0) {
        items.push('<div class="input-menu-item">No inputs found</div>')
    }
    inputMenu.innerHTML = items.join('')
        + '<div class="input-menu-sep"></div>'
        + '<div class="input-menu-item input-menu-refresh" data-refresh="1">&#x21BB; Refresh</div>'
}

function closeInputMenu() {
    inputMenu.classList.add('hidden')
}

btnInputMenu.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (inputMenu.classList.contains('hidden')) {
        await renderInputMenu()
        inputMenu.classList.remove('hidden')
    } else {
        closeInputMenu()
    }
})

// Close when clicking anywhere outside the menu. pointerdown, not click: iOS
// Safari sends no click for a tap on plain page content.
document.addEventListener('pointerdown', (e) => {
    if (inputMenu.classList.contains('hidden')) return
    if (!inputMenu.contains(e.target) && !btnInputMenu.contains(e.target)) closeInputMenu()
})

inputMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.input-menu-item')
    if (!item) return
    if (item.dataset.refresh) {
        await refreshDevices()
        await renderInputMenu()  // keep the menu open, showing the fresh list
        return
    }
    const name = item.dataset.input
    closeInputMenu()
    if (!name || name === currentInput) return
    await selectInput(name)
})

async function selectInput(name) {
    try {
        const res = await fetch('/api/midi/input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: name }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        setCurrentInput(data.input)
        defaultOutputToInput(data.input)
    } catch (err) {
        console.error('Failed to select input:', err)
        alert(`Could not open MIDI input: ${err.message}`)
    }
}

// Playback follows the chosen input by default, but only when a same-named
// output exists. The output dropdown stays independently changeable.
function defaultOutputToInput(inputName) {
    if (!inputName) return
    const match = [...outputSelect.options].find(o => o.value === inputName)
    if (!match) return  // no matching output - leave playback untouched
    outputSelect.value = inputName
    saveSettings()
    if (connectedOutput) connectOutput()  // follow only if already connected
}

// Re-scan devices (replaces the old MIDI Devices > Refresh button)
async function refreshDevices() {
    await loadOutputs()
    await loadInputStatus()
}

// ===========================================
// MIDI Output Connection
// ===========================================
const outStatus = $('outStatus')
const btnConnectOut = $('btnConnectOut')

// Device currently open on the server, or null
let connectedOutput = null

function setOutputStatus(device) {
    connectedOutput = device || null
    const name = device ? device.split('/').pop() : ''

    btnConnectOut.innerHTML = device ? '&#x1F50C; Connected' : '&#x1F50C; Connect Out'
    btnConnectOut.classList.toggle('connected', !!device)
    btnConnectOut.title = device
        ? `Connected to ${name} - click to disconnect`
        : 'Open the selected MIDI output'

    outStatus.textContent = name
    outStatus.classList.toggle('active', !!device)
}

async function loadOutputStatus() {
    try {
        const res = await fetch('/api/midi/output')
        const data = await res.json()
        setOutputStatus(data.output)
    } catch (err) {
        console.error('Failed to load output status:', err)
    }
}

// Open the selected output so click-to-play and playback can sound
async function connectOutput() {
    const output = outputSelect.value
    if (!output) {
        alert('No MIDI output available - plug in a device and hit Refresh')
        return false
    }

    try {
        const res = await fetch('/api/midi/output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ output }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        setOutputStatus(data.output)
        return true
    } catch (err) {
        console.error('Failed to connect output:', err)
        setOutputStatus(null)
        alert(`Could not connect MIDI output: ${err.message}`)
        return false
    }
}

async function disconnectOutput() {
    try {
        await fetch('/api/midi/output', { method: 'DELETE' })
        setOutputStatus(null)
    } catch (err) {
        console.error('Failed to disconnect output:', err)
    }
}

btnConnectOut.addEventListener('click', () => {
    if (connectedOutput) {
        disconnectOutput()
    } else {
        connectOutput()
    }
})

// Save output device when changed, and follow it if already connected
outputSelect.addEventListener('change', () => {
    saveSettings()
    if (connectedOutput) connectOutput()
})

// MIDI Thru
const thruToggle = $('thruToggle')
const thruStatus = $('thruStatus')

async function loadThruStatus() {
    try {
        const res = await fetch('/api/midi/thru')
        const data = await res.json()

        // If server says thru is disabled but we had it enabled before, re-enable it
        const settings = loadSettings()
        if (!data.enabled && settings?.thruEnabled) {
            // Try to re-enable thru with the saved output device
            const output = settings.outputDevice || outputSelect.value
            try {
                const enableRes = await fetch('/api/midi/thru', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ output })
                })
                const enableData = await enableRes.json()
                thruToggle.checked = true
                updateThruStatus(true, enableData.output)
                return
            } catch {
                // Failed to re-enable, fall through to show server state
            }
        }

        thruToggle.checked = data.enabled
        updateThruStatus(data.enabled, data.output)
    } catch (err) {
        console.error('Failed to load thru status:', err)
    }
}

function updateThruStatus(enabled, output) {
    if (enabled) {
        thruStatus.textContent = output ? output.split('/').pop() : 'On'
        thruStatus.classList.add('active')
    } else {
        thruStatus.textContent = 'Off'
        thruStatus.classList.remove('active')
    }
}

thruToggle.addEventListener('change', async () => {
    try {
        if (thruToggle.checked) {
            const output = outputSelect.value
            const res = await fetch('/api/midi/thru', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ output })
            })
            const data = await res.json()
            updateThruStatus(true, data.output)
        } else {
            await fetch('/api/midi/thru', { method: 'DELETE' })
            updateThruStatus(false, null)
        }
        saveSettings()
    } catch (err) {
        console.error('Failed to toggle thru:', err)
        thruToggle.checked = !thruToggle.checked
    }
})

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

    const viewStart = getViewStart()
    const viewEnd = getViewEnd()
    const sessionDuration = endTime - startTime

    // Check if session is already fully visible
    const isVisible = startTime >= viewStart && endTime <= viewEnd

    if (isVisible) {
        // Already in view - just highlight, don't change viewport
        drawTimeline()
        return
    }

    // Need to scroll - switch to detached mode if in live
    freezeView()

    if (sessionDuration <= timeline.detachedDuration) {
        // Session fits in current zoom - center it
        const center = (startTime + endTime) / 2
        timeline.startTime = center - timeline.detachedDuration / 2
    } else {
        // Session too large for current zoom - show start near left edge
        const padding = timeline.detachedDuration * 0.1
        timeline.startTime = startTime - padding
    }

    // Clamp to valid range
    if (timeline.startTime < 0) {
        timeline.startTime = 0
    }

    await ensureTimelineDataCovers(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
    updateLiveButton()
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

// A second click on the same row soon after opens the edit panel. Counted
// here rather than with dblclick, which iPad Safari doesn't reliably send.
let lastSessionClick = { id: null, at: 0 }

sessionList.addEventListener('click', async (e) => {
    const item = e.target.closest('.session-item')
    if (item) {
        sessionList.querySelectorAll('.session-item').forEach(i => {
            i.classList.remove('selected')
        })
        item.classList.add('selected')

        const sessionId = parseInt(item.dataset.id)
        const startTime = parseInt(item.dataset.start)
        const endTime = parseInt(item.dataset.end)
        const now = Date.now()
        const isDouble = lastSessionClick.id === sessionId && now - lastSessionClick.at < 400
        lastSessionClick = isDouble ? { id: null, at: 0 } : { id: sessionId, at: now }

        await selectSession(sessionId, startTime, endTime)
        if (isDouble) {
            showEditPanel(sessionId)
            $('editPerformer').focus()
        }
    }
})

// ===========================================
// MIDI File Upload
//
// Selecting a file just imports it: it's stored in the browser and added to the
// Imports list, where each row plays it and opens its piano roll / score. There
// are no separate top-level file controls - the list rows are the interaction.
// ===========================================
const midiFileInput = $('midiFileInput')
const btnSelectFile = $('btnSelectFile')
const fileInfo = $('fileInfo')

btnSelectFile.addEventListener('click', () => midiFileInput.click())

midiFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0]
    if (!file) return
    midiFileInput.value = ''  // so re-picking the same file fires change again
    fileInfo.textContent = `Importing ${file.name}…`

    // Parse first so a broken file is reported instead of stored.
    try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch('/api/midi/file/parse', { method: 'POST', body: formData })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
    } catch (err) {
        fileInfo.textContent = `Could not import ${file.name}: ${err.message}`
        return
    }

    // Remember the import in the browser (not on the server), refresh the
    // list and select it in the transport bar, ready to play.
    try {
        const id = await saveImport(file)
        if (typeof loadRecentImports === 'function') await loadRecentImports(id)
        fileInfo.textContent = ''
    } catch (err) {
        console.error('Failed to store import:', err)
        fileInfo.textContent = `Could not save ${file.name}: ${err.message}`
    }
})

// ===========================================
// Timeline Zoom/Pan Controls
// ===========================================
const btnZoomIn = $('timelineZoomIn')
const btnZoomOut = $('timelineZoomOut')
const btnPanLeft = $('timelinePanLeft')
const btnPanRight = $('timelinePanRight')
const btnLiveToggle = $('btnLiveToggle')
const btnFlip = $('timelineFlip')
const btnAlign = $('timelineAlign')
const alignGapGroup = $('alignGapGroup')
const alignGapInput = $('timelineAlignGap')
const alignGapReadout = $('alignGapReadout')

// Render-only chord alignment toggle (see drawTimeline; DB is never changed).
// The gap slider appears beside it only while alignment is on.
function setAlignChords(on) {
    timeline.alignChords = on
    btnAlign.classList.toggle('active', on)
    btnAlign.title = on
        ? `Chords aligned (notes within ${timeline.alignGapMs} ms, display only) - click to show true timing`
        : 'Align near-simultaneous notes as chords (display only)'
    alignGapGroup.classList.toggle('hidden', !on)
    localStorage.setItem('midibox-align-chords', on ? '1' : '0')
    drawTimeline()
}

// The max onset gap (ms) that still counts as one chord, persisted on its own.
function loadAlignGap() {
    const saved = parseInt(localStorage.getItem('midibox-align-gap') || '', 10)
    if (Number.isFinite(saved) && saved >= 2 && saved <= 40) timeline.alignGapMs = saved
    alignGapInput.value = String(timeline.alignGapMs)
    alignGapReadout.textContent = `${timeline.alignGapMs}ms`
}

alignGapInput.addEventListener('input', () => {
    timeline.alignGapMs = parseInt(alignGapInput.value, 10) || timeline.alignGapMs
    alignGapReadout.textContent = `${timeline.alignGapMs}ms`
    btnAlign.title = `Chords aligned (notes within ${timeline.alignGapMs} ms, display only) - click to show true timing`
    localStorage.setItem('midibox-align-gap', String(timeline.alignGapMs))
    if (timeline.alignChords) drawTimeline()
})

btnAlign.addEventListener('click', () => setAlignChords(!timeline.alignChords))

// Zoom to selection or zoom in on center
btnZoomIn.addEventListener('click', async () => {
    // Enter detached mode if live
    freezeView()

    if (timeline.selection) {
        // Zoom to fit selection
        timeline.startTime = timeline.selection.start
        timeline.detachedDuration = timeline.selection.end - timeline.selection.start
    } else {
        // Zoom in on center (halve the duration)
        const center = timeline.startTime + timeline.detachedDuration / 2
        timeline.detachedDuration = timeline.detachedDuration / 2
        timeline.startTime = center - timeline.detachedDuration / 2
    }

    await ensureTimelineDataCovers(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
    updateLiveButton()
})

// Zoom out, keeping selection in view if present
btnZoomOut.addEventListener('click', async () => {
    // Enter detached mode if live
    freezeView()

    let center
    if (timeline.selection) {
        center = (timeline.selection.start + timeline.selection.end) / 2
    } else {
        center = timeline.startTime + timeline.detachedDuration / 2
    }
    timeline.detachedDuration = Math.max(1000, timeline.detachedDuration * 2)
    timeline.startTime = Math.max(0, center - timeline.detachedDuration / 2)

    await ensureTimelineDataCovers(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
    updateLiveButton()
})

async function panTimeline(direction) {
    // Enter detached mode if live
    freezeView()

    const shift = Math.round(timeline.detachedDuration / 4) * direction
    timeline.startTime = Math.max(0, timeline.startTime + shift)

    await ensureTimelineDataCovers(getViewStart(), getViewEnd())
    updateTimeLabels()
    drawTimeline()
    updateLiveButton()
}

btnPanLeft.addEventListener('click', () => panTimeline(-1))
btnPanRight.addEventListener('click', () => panTimeline(1))

// Live is a toggle: on = follow "now" continuously, off = freeze the window
btnLiveToggle.addEventListener('click', () => {
    if (isLive()) {
        freezeView()  // freeze, pinning "now" at the bottom edge
        updateTimeLabels()
        updateLiveButton()
        drawTimeline()
    } else {
        returnToLive()
    }
})

// Flip which way time runs on the timeline
function updateDirectionControls() {
    btnFlip.classList.toggle('active', timeline.flipped)
    btnFlip.title = timeline.flipped
        ? 'Time runs upward - click for downward'
        : 'Time runs downward - click for upward'
    // The pan buttons move the view, so their arrows follow the direction
    btnPanLeft.innerHTML = timeline.flipped ? '&#x2193;' : '&#x2191;'
    btnPanRight.innerHTML = timeline.flipped ? '&#x2191;' : '&#x2193;'
}

// ===========================================
// Fullscreen
//
// Uses the Fullscreen API where it exists, and a CSS mode everywhere else -
// iPhone Safari won't fullscreen anything but a <video> (iPad Safari only
// has the webkit-prefixed API before 16.4), so the class is what actually
// does the work there.
// ===========================================
const btnFullscreen = $('timelineFullscreen')

function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null
}

function setFullscreen(on) {
    document.body.classList.toggle('fullscreen-mode', on)
    btnFullscreen.classList.toggle('active', on)
    btnFullscreen.title = on ? 'Leave fullscreen' : 'Fullscreen'
    localStorage.setItem('midibox-fullscreen', on ? '1' : '0')

    const el = document.documentElement
    const request = el.requestFullscreen || el.webkitRequestFullscreen
    const exit = document.exitFullscreen || document.webkitExitFullscreen
    if (on && request && !fullscreenElement()) {
        // Denied without a gesture; the CSS mode still applies. Older
        // Safari's prefixed call returns nothing rather than a promise.
        Promise.resolve(request.call(el)).catch(() => {})
    } else if (!on && fullscreenElement() && exit) {
        Promise.resolve(exit.call(document)).catch(() => {})
    }

    // The canvas can only be measured once the layout has settled
    requestAnimationFrame(() => {
        resizeCanvas()
        updateTimeLabels()
    })
}

btnFullscreen.addEventListener('click', () => {
    setFullscreen(!document.body.classList.contains('fullscreen-mode'))
})

// Leaving via Esc or the browser's own control should drop the CSS mode too
function onFullscreenChange() {
    if (!fullscreenElement() && document.body.classList.contains('fullscreen-mode')) {
        setFullscreen(false)
    }
}
document.addEventListener('fullscreenchange', onFullscreenChange)
document.addEventListener('webkitfullscreenchange', onFullscreenChange)

btnFlip.addEventListener('click', () => {
    timeline.flipped = !timeline.flipped
    saveTimelineDirection()
    updateDirectionControls()
    updateTimeLabels()
    updateSelectionUI()
    drawTimeline()
})

// ===========================================
// Floating Event Log Window
// ===========================================
const eventLogPanel = $('eventLogPanel')
const eventLogHeader = $('eventLogHeader')
const btnToggleEventLog = $('btnToggleEventLog')

function saveEventLogState() {
    const state = {
        open: !eventLogPanel.classList.contains('hidden'),
        left: eventLogPanel.style.left || null,
        top: eventLogPanel.style.top || null,
    }
    localStorage.setItem('midibox-event-log', JSON.stringify(state))
}

function setEventLogOpen(open) {
    eventLogPanel.classList.toggle('hidden', !open)
    btnToggleEventLog.classList.toggle('active', open)
    saveEventLogState()
}

function loadEventLogState() {
    try {
        const saved = JSON.parse(localStorage.getItem('midibox-event-log') || 'null')
        if (!saved) return
        if (saved.left && saved.top) {
            eventLogPanel.style.left = saved.left
            eventLogPanel.style.top = saved.top
            eventLogPanel.style.right = 'auto'
            eventLogPanel.style.bottom = 'auto'
        }
        eventLogPanel.classList.toggle('hidden', !saved.open)
        btnToggleEventLog.classList.toggle('active', !!saved.open)
    } catch (e) {
        console.error('Failed to restore event log state:', e)
    }
}

btnToggleEventLog.addEventListener('click', () => {
    setEventLogOpen(eventLogPanel.classList.contains('hidden'))
})

$('eventLogClose').addEventListener('click', () => setEventLogOpen(false))

// Drag the floating window by its header (mouse + touch)
let logDrag = null

function startLogDrag(clientX, clientY) {
    const rect = eventLogPanel.getBoundingClientRect()
    logDrag = { dx: clientX - rect.left, dy: clientY - rect.top }
}

function moveLogDrag(clientX, clientY) {
    if (!logDrag) return
    const width = eventLogPanel.offsetWidth
    const height = eventLogPanel.offsetHeight
    const left = Math.max(0, Math.min(window.innerWidth - width, clientX - logDrag.dx))
    const top = Math.max(0, Math.min(window.innerHeight - height, clientY - logDrag.dy))
    eventLogPanel.style.left = left + 'px'
    eventLogPanel.style.top = top + 'px'
    eventLogPanel.style.right = 'auto'
    eventLogPanel.style.bottom = 'auto'
}

function endLogDrag() {
    if (!logDrag) return
    logDrag = null
    saveEventLogState()
}

eventLogHeader.addEventListener('mousedown', (e) => {
    if (e.target.closest('.floating-panel-close')) return
    e.preventDefault()
    startLogDrag(e.clientX, e.clientY)
})

document.addEventListener('mousemove', (e) => {
    if (logDrag) moveLogDrag(e.clientX, e.clientY)
})

document.addEventListener('mouseup', endLogDrag)

eventLogHeader.addEventListener('touchstart', (e) => {
    if (e.target.closest('.floating-panel-close')) return
    const touch = e.touches[0]
    if (touch) startLogDrag(touch.clientX, touch.clientY)
}, { passive: true })

eventLogHeader.addEventListener('touchmove', (e) => {
    const touch = e.touches[0]
    if (logDrag && touch) {
        e.preventDefault()
        moveLogDrag(touch.clientX, touch.clientY)
    }
}, { passive: false })

eventLogHeader.addEventListener('touchend', endLogDrag)
eventLogHeader.addEventListener('touchcancel', endLogDrag)

// ===========================================
// Initialize
// ===========================================
updateLiveButton()
updateDirectionControls()
loadAlignGap()
setAlignChords(localStorage.getItem('midibox-align-chords') === '1')
setFullscreen(localStorage.getItem('midibox-fullscreen') === '1')
connect()
loadSessions()
loadOutputs().then(loadOutputStatus)
loadInputStatus()
loadThruStatus()
loadEventLogState()
updatePlayButtons()
