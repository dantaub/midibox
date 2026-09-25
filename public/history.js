// ===========================================
// Tabs + History view
//
// Loaded after app.js and reuses its globals ($, noteName, isNoteOn,
// outputSelect, onLiveEvent, resizeCanvas, loadSessions, ...).
// ===========================================

// ===========================================
// Tab switching
// ===========================================
const viewLive = $('viewLive')
const viewHistory = $('viewHistory')
const views = { live: viewLive, history: viewHistory, io: $('viewIO') }

function switchView(name) {
    for (const [n, el] of Object.entries(views)) el.classList.toggle('hidden', n !== name)
    document.querySelectorAll('#tabs .tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === name)
    })
    localStorage.setItem('midibox-view', name)
    // The transport bar shows on every tab while something plays (io.js,
    // loaded later - the first switchView runs before it exists)
    if (typeof updateTransportBar === 'function') updateTransportBar()

    // Canvases can't be measured while hidden - size them on reveal
    if (name === 'live') {
        resizeCanvas()
    } else if (name === 'history') {
        resizeHistoryCanvas()
        if (hist.days.length === 0) loadHistoryDays()
    } else if (name === 'io') {
        loadIOSessions()
    }
}

document.querySelectorAll('#tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view))
})

// ===========================================
// History state
// ===========================================
const hist = {
    days: [],
    date: null,          // 'YYYY-MM-DD' of the selected day
    segments: [],
    sessions: [],
    gap: 60 * 1000,      // silence that splits two stretches of activity
    selection: null,     // { start, end, label } currently previewed
    region: null,        // { start, end } dragged out on the preview: what Play / Save use
    editing: null,       // saved session being edited here (its span is the region)
    segmentStart: null,  // the listed stretch that's open (the preview can reach past it)
    scrub: null,         // time the playhead is being dragged to (preview only)
    followLive: false,   // preview is tracking the in-progress stretch
    previewEvents: [],
    redrawTimer: null,
}

const dayList = $('dayList')
const segmentList = $('segmentList')
const historyGap = $('historyGap')
const historyCanvas = $('historyCanvas')
const historyCanvasWrap = $('historyCanvasWrap')
const historyCtx = historyCanvas.getContext('2d')
const historyLivePill = $('historyLivePill')

// ===========================================
// Formatting helpers
// ===========================================
const pad2 = n => String(n).padStart(2, '0')

function dayKey(ts) {
    const d = new Date(ts)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function dayBounds(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number)
    const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
    const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
    return { start, end }
}

function dayLabel(dateStr) {
    const today = dayKey(Date.now())
    const yesterday = dayKey(Date.now() - 24 * 60 * 60 * 1000)
    if (dateStr === today) return 'Today'
    if (dateStr === yesterday) return 'Yesterday'
    const { start } = dayBounds(dateStr)
    return new Date(start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    if (h > 0) return `${h}h ${pad2(m)}m`
    if (m > 0) return `${m}m ${pad2(s)}s`
    return `${s}s`
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ))
}

// ===========================================
// Day list
// ===========================================
async function loadHistoryDays() {
    try {
        const tz = new Date().getTimezoneOffset()
        const res = await fetch(`/api/history/days?tz=${tz}`)
        hist.days = await res.json()
    } catch (err) {
        console.error('Failed to load history days:', err)
        hist.days = []
    }

    renderDays()

    // Keep the current day selected if it's still in the list, else pick the newest
    if (hist.date && hist.days.some(d => d.date === hist.date)) {
        await loadHistorySegments()
    } else if (hist.days.length > 0) {
        await selectDay(hist.days[0].date)
    } else {
        hist.date = null
        hist.segments = []
        renderSegments()
        $('historyDayTitle').textContent = 'No activity recorded'
        $('historyDayStats').textContent = ''
    }
}

function renderDays() {
    if (hist.days.length === 0) {
        dayList.innerHTML = '<div class="history-empty">Nothing recorded yet.</div>'
        return
    }

    const maxNotes = Math.max(...hist.days.map(d => d.note_count || 0), 1)

    dayList.innerHTML = hist.days.map(day => {
        const width = Math.max(2, Math.round(((day.note_count || 0) / maxNotes) * 100))
        return `
            <div class="day-item ${day.date === hist.date ? 'selected' : ''}" data-date="${day.date}">
                <div class="day-item-top">
                    <span class="day-label">${dayLabel(day.date)}</span>
                    <span class="day-count">${(day.note_count || 0).toLocaleString()} notes</span>
                </div>
                <div class="day-bar"><span style="width:${width}%"></span></div>
                <div class="day-item-meta">
                    <span>${fmtClock(day.first_event)} &ndash; ${fmtClock(day.last_event)}</span>
                    ${day.session_count ? `<span class="day-sessions">${day.session_count} session${day.session_count === 1 ? '' : 's'}</span>` : ''}
                </div>
            </div>
        `
    }).join('')
}

dayList.addEventListener('click', (e) => {
    const item = e.target.closest('.day-item')
    if (item) selectDay(item.dataset.date)
})

async function selectDay(date) {
    hist.date = date
    hist.selection = null
    hist.followLive = false
    hist.previewEvents = []
    renderDays()
    await loadHistorySegments()
    drawHistoryPreview()
    updatePreviewButtons()
    $('historyPreviewTitle').textContent = 'Preview'
    $('historyPreviewInfo').textContent = 'Select a stretch of activity to preview it.'
}

// ===========================================
// Segments for the selected day
// ===========================================
async function loadHistorySegments() {
    if (!hist.date) return
    const { start, end } = dayBounds(hist.date)
    try {
        const res = await fetch(`/api/history/segments?start=${start}&end=${end}&gap=${hist.gap}`)
        const data = await res.json()
        hist.segments = data.segments || []
        hist.sessions = data.sessions || []
    } catch (err) {
        console.error('Failed to load activity:', err)
        hist.segments = []
        hist.sessions = []
    }
    renderSegments()
}

function sessionsForSegment(segment) {
    return hist.sessions.filter(s => s.end_time >= segment.start && s.start_time <= segment.end)
}

function renderSegments() {
    const isToday = hist.date === dayKey(Date.now())
    historyLivePill.classList.toggle('hidden', !isToday)

    $('historyDayTitle').textContent = hist.date ? dayLabel(hist.date) : 'Select a day'

    const totalNotes = hist.segments.reduce((sum, s) => sum + s.note_count, 0)
    const totalTime = hist.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
    $('historyDayStats').textContent = hist.segments.length
        ? `${hist.segments.length} stretches · ${totalNotes.toLocaleString()} notes · ${fmtDuration(totalTime)} played`
        : ''

    if (hist.segments.length === 0) {
        segmentList.innerHTML = '<div class="history-empty">No activity on this day.</div>'
        return
    }

    // Newest first - the most recent playing is usually what you're after
    const ordered = [...hist.segments].sort((a, b) => b.start - a.start)
    const maxDensity = Math.max(1, ...ordered.flatMap(s => s.density || [0]))

    segmentList.innerHTML = ordered.map(segment => {
        const spark = (segment.density || []).map(v =>
            `<span style="height:${Math.max(6, Math.round((v / maxDensity) * 100))}%"></span>`
        ).join('')
        const sessions = sessionsForSegment(segment)
        const sessionTags = sessions.map(s =>
            `<button class="segment-session ${hist.editing?.id === s.id ? 'editing' : ''}" data-session-id="${s.id}" title="Edit this session">${escapeHtml(sessionName(s))}</button>`
        ).join('')
        const range = segment.min_note != null
            ? `${noteName(segment.min_note)}&ndash;${noteName(segment.max_note)}`
            : ''
        const selected = hist.segmentStart === segment.start

        return `
            <div class="segment-item ${selected ? 'selected' : ''}" data-start="${segment.start}" data-end="${segment.end}">
                <div class="segment-main">
                    <div class="segment-time">
                        ${fmtClock(segment.start)}
                        <span class="segment-duration">${fmtDuration(segment.end - segment.start)}</span>
                    </div>
                    <div class="segment-spark">${spark}</div>
                    <div class="segment-meta">
                        <span>${segment.note_count.toLocaleString()} note${segment.note_count === 1 ? '' : 's'}</span>
                        ${range ? `<span>${range}</span>` : ''}
                        <span>vel ${segment.avg_velocity}</span>
                        ${sessionTags}
                    </div>
                </div>
                <div class="segment-actions">
                    <button class="btn-icon segment-play" title="Play this stretch">&#x25B6;</button>
                </div>
            </div>
        `
    }).join('')
    markPlayingSegment()
}

segmentList.addEventListener('click', (e) => {
    const item = e.target.closest('.segment-item')
    if (!item) return
    const start = parseInt(item.dataset.start, 10)
    const end = parseInt(item.dataset.end, 10)

    const tag = e.target.closest('.segment-session')
    if (tag) {
        editHistorySession(parseInt(tag.dataset.sessionId, 10), { start, end })
        return
    }

    if (e.target.closest('.segment-play')) {
        selectSegment(start, end)
        playHistorySelection()
        return
    }
    selectSegment(start, end)
})

const sessionName = s => s.song_name || s.performer || `Session ${s.id}`

async function selectSegment(start, end) {
    hist.selection = { start, end }
    hist.segmentStart = start
    hist.region = null
    closeHistorySaveForm()
    // The last stretch of today keeps growing while you play
    hist.followLive = hist.date === dayKey(Date.now()) &&
        hist.segments.length > 0 &&
        end === Math.max(...hist.segments.map(s => s.end))

    renderSegments()
    updatePreviewButtons()
    $('historyPreviewTitle').textContent = `${fmtClock(start)} – ${fmtClock(end)}`
    $('historyPreviewInfo').textContent = `${fmtDuration(end - start)} · loading…`

    try {
        const res = await fetch(`/api/events/range?start=${start}&end=${end}`)
        hist.previewEvents = await res.json()
    } catch (err) {
        console.error('Failed to load preview events:', err)
        hist.previewEvents = []
    }

    updatePreviewInfo()
    drawHistoryPreview()
}

function updatePreviewInfo() {
    if (!hist.selection) return
    const { start, end } = hist.selection
    const notes = hist.previewEvents.filter(isNoteOn).length
    let text = `${fmtDuration(end - start)} · ${notes.toLocaleString()} notes${hist.followLive ? ' · following live' : ''}`
    if (hist.region) {
        const r = hist.region
        text += ` · selected ${fmtClock(r.start)} – ${fmtClock(r.end)} (${fmtDuration(r.end - r.start)})`
    } else {
        text += ' · drag across to select part of it'
    }
    $('historyPreviewInfo').textContent = text
}

// What Play and Save act on: the dragged-out region, else the whole stretch
function historyRange() {
    return hist.region || hist.selection
}

// ===========================================
// Preview piano roll (time runs left to right)
// ===========================================
function resizeHistoryCanvas() {
    const rect = historyCanvasWrap.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dpr = window.devicePixelRatio || 1
    historyCanvas.width = rect.width * dpr
    historyCanvas.height = rect.height * dpr
    historyCanvas.style.width = rect.width + 'px'
    historyCanvas.style.height = rect.height + 'px'
    historyCtx.setTransform(1, 0, 0, 1, 0, 0)
    historyCtx.scale(dpr, dpr)
    drawHistoryPreview()
}

window.addEventListener('resize', resizeHistoryCanvas)

function drawHistoryPreview() {
    const width = historyCanvasWrap.clientWidth
    const height = historyCanvasWrap.clientHeight
    if (!width || !height) return

    historyCtx.clearRect(0, 0, width, height)

    if (!hist.selection || hist.previewEvents.length === 0) {
        historyCtx.fillStyle = '#4a4a6a'
        historyCtx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif'
        historyCtx.fillText('No preview', 8, 18)
        return
    }

    const viewStart = hist.selection.start
    const viewEnd = Math.max(hist.selection.end, viewStart + 1000)
    const span = viewEnd - viewStart

    // Octave grid
    historyCtx.strokeStyle = '#1a1a2e'
    historyCtx.lineWidth = 1
    for (let note = 24; note <= 108; note += 12) {
        const y = height - ((note - 21) / 88) * height
        historyCtx.beginPath()
        historyCtx.moveTo(0, y)
        historyCtx.lineTo(width, y)
        historyCtx.stroke()
    }

    // Pair note on/off into bars (shared with the Live view; see piano-roll.js).
    // Redrawn every frame while a playhead moves, so the pairing is cached.
    const cacheKey = `${hist.previewEvents.length}:${viewEnd}`
    if (hist.barsKey !== cacheKey || hist.barsFor !== hist.previewEvents) {
        hist.bars = pairNoteBars(hist.previewEvents, viewEnd)
        hist.barsKey = cacheKey
        hist.barsFor = hist.previewEvents
    }
    const bars = hist.bars

    const noteHeight = height / 88
    for (const bar of bars) {
        const x1 = ((bar.start - viewStart) / span) * width
        const x2 = ((bar.end - viewStart) / span) * width
        const y = height - ((bar.note - 21 + 1) / 88) * height
        const brightness = 50 + (bar.velocity / 127) * 50
        const isBlack = [1, 3, 6, 8, 10].includes(bar.note % 12)
        historyCtx.fillStyle = isBlack ? `hsl(340, 80%, ${brightness}%)` : `hsl(160, 70%, ${brightness}%)`
        historyCtx.fillRect(x1, y, Math.max(2, x2 - x1), Math.max(1, noteHeight - 1))
    }

    // Sessions already covering this stretch
    for (const session of hist.sessions) {
        if (session.end_time < viewStart || session.start_time > viewEnd) continue
        const x1 = Math.max(0, ((session.start_time - viewStart) / span) * width)
        const x2 = Math.min(width, ((session.end_time - viewStart) / span) * width)
        historyCtx.fillStyle = 'rgba(59, 130, 246, 0.18)'
        historyCtx.fillRect(x1, 0, x2 - x1, height)
        historyCtx.fillStyle = '#93c5fd'
        historyCtx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
        historyCtx.fillText(session.song_name || session.performer || `Session ${session.id}`, x1 + 4, 13, Math.max(10, x2 - x1 - 8))
    }

    const toX = t => ((t - viewStart) / span) * width

    // The selected region: the rest dims, the region gets edges to drag
    if (hist.region) {
        const x1 = toX(hist.region.start)
        const x2 = toX(hist.region.end)
        historyCtx.fillStyle = 'rgba(13, 17, 23, 0.55)'
        historyCtx.fillRect(0, 0, Math.max(0, x1), height)
        historyCtx.fillRect(x2, 0, Math.max(0, width - x2), height)
        historyCtx.fillStyle = 'rgba(233, 69, 96, 0.14)'
        historyCtx.fillRect(x1, 0, x2 - x1, height)
        historyCtx.fillStyle = '#e94560'
        historyCtx.fillRect(x1 - 1, 0, 2, height)
        historyCtx.fillRect(x2 - 1, 0, 2, height)
    }

    // Playhead: whatever is playing inside this stretch, or where it's being dragged
    const at = hist.scrub ?? historyPlayhead()
    if (at != null) {
        const x = toX(at)
        historyCtx.fillStyle = '#ff4d6d'
        historyCtx.fillRect(x - 1, 0, 2, height)
        historyCtx.beginPath()
        historyCtx.arc(x, 7, 6, 0, Math.PI * 2)
        historyCtx.fill()
    }
}

// Position of what's playing, when it's a recording inside this stretch
function historyPlayhead() {
    const clip = player.state.clip
    if (!hist.selection || player.state.status === 'idle' || clip?.kind !== 'range') return null
    const viewEnd = Math.max(hist.selection.end, hist.selection.start + 1000)
    if (clip.end < hist.selection.start || clip.start > viewEnd) return null
    return player.position()
}

// ---- Dragging on the preview ------------------------------------------------
// Drag across it to select a region (drag an edge to adjust it; a tap clears
// it). The playhead's handle drags to seek, and a tap while something here is
// playing jumps playback there.
const HISTORY_GRAB_PX = 10
let histDrag = null

function historyTimeAt(clientX) {
    const rect = historyCanvas.getBoundingClientRect()
    const viewStart = hist.selection.start
    const span = Math.max(hist.selection.end, viewStart + 1000) - viewStart
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.round(viewStart + ratio * span)
}

function historyXOf(t) {
    const rect = historyCanvas.getBoundingClientRect()
    const viewStart = hist.selection.start
    const span = Math.max(hist.selection.end, viewStart + 1000) - viewStart
    return rect.left + ((t - viewStart) / span) * rect.width
}

// Play from `t`: seek if it's inside what's playing, otherwise start the
// region (or stretch) there
function historySeek(t) {
    const clip = player.state.clip
    if (player.state.status !== 'idle' && clip?.kind === 'range' && t >= clip.start && t <= clip.end) {
        player.seek(t)
        return
    }
    const range = hist.region && t >= hist.region.start && t <= hist.region.end ? hist.region : hist.selection
    playHistoryRange(range, t)
}

historyCanvas.addEventListener('pointerdown', (e) => {
    if (!hist.selection || hist.previewEvents.length === 0) return
    const t = historyTimeAt(e.clientX)
    const near = (time) => time != null && Math.abs(historyXOf(time) - e.clientX) <= HISTORY_GRAB_PX
    const playhead = historyPlayhead()

    if (near(playhead)) histDrag = { mode: 'scrub' }
    else if (hist.region && near(hist.region.start)) histDrag = { mode: 'start' }
    else if (hist.region && near(hist.region.end)) histDrag = { mode: 'end' }
    else histDrag = { mode: 'new', from: t, x: e.clientX, moved: false }

    historyCanvas.setPointerCapture(e.pointerId)
    e.preventDefault()
    if (histDrag.mode === 'scrub') {
        hist.scrub = t
        drawHistoryPreview()
    }
})

historyCanvas.addEventListener('pointermove', (e) => {
    if (!histDrag) {
        // Show what a press here would grab
        if (!hist.selection || e.pointerType !== 'mouse') return
        const near = (time) => time != null && Math.abs(historyXOf(time) - e.clientX) <= HISTORY_GRAB_PX
        const edge = near(historyPlayhead()) || (hist.region && (near(hist.region.start) || near(hist.region.end)))
        historyCanvas.style.cursor = edge ? 'ew-resize' : 'crosshair'
        return
    }
    const t = historyTimeAt(e.clientX)
    if (histDrag.mode === 'scrub') {
        hist.scrub = t
    } else if (histDrag.mode === 'start') {
        hist.region.start = Math.min(t, hist.region.end - 100)
    } else if (histDrag.mode === 'end') {
        hist.region.end = Math.max(t, hist.region.start + 100)
    } else {
        if (!histDrag.moved && Math.abs(e.clientX - histDrag.x) < 5) return
        histDrag.moved = true
        hist.region = { start: Math.min(histDrag.from, t), end: Math.max(histDrag.from, t) }
    }
    updatePreviewInfo()
    drawHistoryPreview()
})

function endHistoryDrag(e) {
    if (!histDrag) return
    const drag = histDrag
    histDrag = null
    if (e.type === 'pointercancel') {
        hist.scrub = null
    } else if (drag.mode === 'scrub') {
        const t = hist.scrub
        hist.scrub = null
        if (t != null) historySeek(t)
    } else if (drag.mode === 'new' && !drag.moved) {
        // A tap: jump playback here if something in this stretch is playing,
        // otherwise clear the region
        if (historyPlayhead() != null) historySeek(historyTimeAt(e.clientX))
        else hist.region = null
    } else if (hist.region && hist.region.end - hist.region.start < 250) {
        hist.region = null  // too small to mean anything
    }
    updatePreviewButtons()
    updatePreviewInfo()
    drawHistoryPreview()
}
historyCanvas.addEventListener('pointerup', endHistoryDrag)
historyCanvas.addEventListener('pointercancel', endHistoryDrag)

// Keep the playhead moving while this tab shows
player.onTick(() => {
    if (viewHistory.classList.contains('hidden') || !hist.selection) return
    if (historyPlayhead() != null || hist.playheadShown) drawHistoryPreview()
    hist.playheadShown = historyPlayhead() != null
})

// ===========================================
// Preview actions: play / stop / save
// ===========================================
function updatePreviewButtons() {
    const hasSelection = !!hist.selection
    $('historyPlay').disabled = !hasSelection
    $('historySave').disabled = !hasSelection
    $('historyClearRegion').disabled = !hist.region
}

$('historyClearRegion').addEventListener('click', () => {
    hist.region = null
    updatePreviewButtons()
    updatePreviewInfo()
    drawHistoryPreview()
})

const historyKey = (start, end) => `history:${start}-${end}`

async function playHistorySelection() {
    const range = historyRange()
    if (range) await playHistoryRange(range)
}

async function playHistoryRange({ start, end }, from) {
    await player.playRange({
        start, end, from,
        title: `${fmtClock(start)} – ${fmtClock(end)}`,
        key: historyKey(start, end),
        source: 'history',
    })
}

$('historyPlay').addEventListener('click', playHistorySelection)
$('historyStop').addEventListener('click', () => player.stop())
$('historyLoop').addEventListener('click', () => player.setLoop(!player.state.loop))

// Stop and loop follow the shared player, whatever view started the playback;
// the stretch that's playing is marked in the list.
player.on((state) => {
    $('historyStop').disabled = state.status === 'idle'
    const loopBtn = $('historyLoop')
    loopBtn.classList.toggle('active', state.loop)
    loopBtn.setAttribute('aria-pressed', String(state.loop))
    markPlayingSegment()
    if (!viewHistory.classList.contains('hidden')) drawHistoryPreview()
})

// The stretch playing from here - whole, or a region of it
function markPlayingSegment() {
    const clip = player.state.status !== 'idle' ? player.state.clip : null
    const fromHere = clip?.key?.startsWith('history:')
    for (const item of segmentList.querySelectorAll('.segment-item')) {
        const start = Number(item.dataset.start)
        const end = Number(item.dataset.end)
        item.classList.toggle('playing', !!fromHere && clip.start >= start && clip.end <= end)
    }
}

$('historySave').addEventListener('click', () => {
    if (!hist.selection) return
    openHistorySaveForm(null)
})

$('historySaveCancel').addEventListener('click', () => {
    // Leaving an edit drops the session's span it had selected
    if (hist.editing) hist.region = null
    closeHistorySaveForm()
    refreshHistoryPreview()
})

// The form saves a new session from the selection, or - with `session` -
// edits that one (song, performer, and its span as the selection)
function openHistorySaveForm(session) {
    hist.editing = session
    $('historySaveLabel').textContent = session ? `Editing ${sessionName(session)}` : 'New session'
    $('historySaveSong').value = session?.song_name || ''
    $('historySavePerformer').value = session?.performer || ''
    $('historySaveConfirm').textContent = session ? 'Update session' : 'Save session'
    $('historyDeleteSession').classList.toggle('hidden', !session)
    $('historySaveForm').classList.remove('hidden')
    renderSegments()
    if (!session) $('historySaveSong').focus()
}

function closeHistorySaveForm() {
    const wasEditing = !!hist.editing
    hist.editing = null
    $('historySaveForm').classList.add('hidden')
    if (wasEditing) renderSegments()
}

function refreshHistoryPreview() {
    updatePreviewButtons()
    updatePreviewInfo()
    drawHistoryPreview()
}

// Open a saved session for editing: the preview spans the stretch (and all of
// the session, if it reaches past it), with the session as the selected region
// - drag its edges to resize it - and the form filled in
async function editHistorySession(id, segment) {
    const session = hist.sessions.find(s => s.id === id)
    if (!session) return
    await selectSegment(Math.min(segment.start, session.start_time), Math.max(segment.end, session.end_time))
    hist.segmentStart = segment.start
    hist.region = { start: session.start_time, end: session.end_time }
    openHistorySaveForm(session)
    refreshHistoryPreview()
}

// Sessions changed: reload them everywhere they're listed
async function afterHistorySessionChange() {
    await loadHistorySegments()
    drawHistoryPreview()
    loadSessions()  // Live tab's list and overlays
    loadHistoryDays()
    if (typeof loadIOSessions === 'function') loadIOSessions()
}

$('historySaveConfirm').addEventListener('click', async () => {
    const editing = hist.editing
    // Editing with the selection cleared keeps the session's own span
    const range = editing
        ? hist.region || { start: editing.start_time, end: editing.end_time }
        : historyRange()
    if (!range) return
    const session = {
        start_time: range.start,
        end_time: range.end,
        song_name: $('historySaveSong').value || null,
        performer: $('historySavePerformer').value || null,
    }

    try {
        const res = await fetch(editing ? `/api/sessions/${editing.id}` : '/api/sessions', {
            method: editing ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        closeHistorySaveForm()
        if (editing) hist.region = null
        await afterHistorySessionChange()
        refreshHistoryPreview()
    } catch (err) {
        console.error('Failed to save session:', err)
        alert('Failed to save session')
    }
})

$('historyDeleteSession').addEventListener('click', async () => {
    const editing = hist.editing
    if (!editing) return
    if (!confirm(`Delete "${sessionName(editing)}"?`)) return
    try {
        const res = await fetch(`/api/sessions/${editing.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        closeHistorySaveForm()
        hist.region = null
        await afterHistorySessionChange()
        refreshHistoryPreview()
    } catch (err) {
        console.error('Failed to delete session:', err)
        alert('Failed to delete session')
    }
})

// ===========================================
// Filters
// ===========================================
historyGap.addEventListener('change', async () => {
    hist.gap = parseInt(historyGap.value, 10)
    localStorage.setItem('midibox-history-gap', String(hist.gap))
    await loadHistorySegments()
})

$('historyRefresh').addEventListener('click', () => loadHistoryDays())

// ===========================================
// Live updates
// ===========================================
function scheduleHistoryRedraw() {
    if (hist.redrawTimer) return
    hist.redrawTimer = setTimeout(() => {
        hist.redrawTimer = null
        renderSegments()
        if (hist.followLive) drawHistoryPreview()
    }, 400)
}

// Extend (or open) the newest stretch of activity as notes come in
function onLiveHistoryEvent(event) {
    const today = dayKey(Date.now())

    // Keep the day list's counters live even when another day is open
    const todayEntry = hist.days.find(d => d.date === today)
    if (todayEntry) {
        todayEntry.event_count++
        if (isNoteOn(event)) todayEntry.note_count++
        todayEntry.last_event = event.timestamp
    }

    if (hist.date !== today) return

    const last = hist.segments.length ? hist.segments[hist.segments.length - 1] : null
    if (last && event.timestamp - last.end <= hist.gap) {
        last.end = event.timestamp
        last.event_count++
        if (isNoteOn(event)) {
            last.note_count++
            if (event.note != null) {
                last.min_note = last.min_note == null ? event.note : Math.min(last.min_note, event.note)
                last.max_note = last.max_note == null ? event.note : Math.max(last.max_note, event.note)
            }
            // Roll the sparkline forward so the newest playing is visible
            last.density = (last.density || []).slice(1).concat(1)
        }
        if (hist.followLive && hist.selection) {
            hist.selection.end = event.timestamp
            hist.previewEvents.push(event)
        }
    } else if (isNoteOn(event)) {
        hist.segments.push({
            start: event.timestamp,
            end: event.timestamp,
            event_count: 1,
            note_count: 1,
            min_note: event.note ?? null,
            max_note: event.note ?? null,
            avg_velocity: event.velocity ?? 0,
            density: new Array(48).fill(0),
        })
    } else {
        return
    }

    if (!viewHistory.classList.contains('hidden')) {
        scheduleHistoryRedraw()
    }
}

onLiveEvent((event) => {
    if (hist.days.length === 0) return  // history never opened yet
    onLiveHistoryEvent(event)
})

// ===========================================
// Initialize
// ===========================================
const savedGap = parseInt(localStorage.getItem('midibox-history-gap') || '', 10)
if (Number.isFinite(savedGap) && savedGap > 0) {
    hist.gap = savedGap
    historyGap.value = String(savedGap)
}

switchView(localStorage.getItem('midibox-view') === 'history' ? 'history' : 'live')
