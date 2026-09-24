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
            `<span class="segment-session">${escapeHtml(s.song_name || s.performer || `Session ${s.id}`)}</span>`
        ).join('')
        const range = segment.min_note != null
            ? `${noteName(segment.min_note)}&ndash;${noteName(segment.max_note)}`
            : ''
        const selected = hist.selection && hist.selection.start === segment.start && hist.selection.end === segment.end

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

    if (e.target.closest('.segment-play')) {
        selectSegment(start, end)
        playHistorySelection()
        return
    }
    selectSegment(start, end)
})

async function selectSegment(start, end) {
    hist.selection = { start, end }
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

    const notes = hist.previewEvents.filter(isNoteOn).length
    $('historyPreviewInfo').textContent =
        `${fmtDuration(end - start)} · ${notes.toLocaleString()} notes${hist.followLive ? ' · following live' : ''}`
    drawHistoryPreview()
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

    // Pair note on/off into bars (shared with the Live view; see piano-roll.js)
    const bars = pairNoteBars(hist.previewEvents, viewEnd)

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
}

// ===========================================
// Preview actions: play / stop / save
// ===========================================
function updatePreviewButtons() {
    const hasSelection = !!hist.selection
    $('historyPlay').disabled = !hasSelection
    $('historySave').disabled = !hasSelection
}

const historyKey = (start, end) => `history:${start}-${end}`

async function playHistorySelection() {
    if (!hist.selection) return
    const { start, end } = hist.selection
    await player.playRange({
        start, end,
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
})

function markPlayingSegment() {
    for (const item of segmentList.querySelectorAll('.segment-item')) {
        item.classList.toggle('playing', player.isCurrent(historyKey(item.dataset.start, item.dataset.end)))
    }
}

$('historySave').addEventListener('click', () => {
    if (!hist.selection) return
    $('historySaveForm').classList.remove('hidden')
    $('historySaveSong').focus()
})

$('historySaveCancel').addEventListener('click', () => {
    $('historySaveForm').classList.add('hidden')
})

$('historySaveConfirm').addEventListener('click', async () => {
    if (!hist.selection) return
    const session = {
        start_time: hist.selection.start,
        end_time: hist.selection.end,
        song_name: $('historySaveSong').value || null,
        performer: $('historySavePerformer').value || null,
    }

    try {
        const res = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
        })
        if (!res.ok) throw new Error('Save failed')
        $('historySaveForm').classList.add('hidden')
        $('historySaveSong').value = ''
        $('historySavePerformer').value = ''
        await loadHistorySegments()
        drawHistoryPreview()
        // Keep the Live tab's session list and overlays in sync
        loadSessions()
        loadHistoryDays()
    } catch (err) {
        console.error('Failed to save session:', err)
        alert('Failed to save session')
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
