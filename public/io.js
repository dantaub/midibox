// ===========================================
// Import / Export tab
//
// Loaded after piano-roll.js, imports-db.js, app.js, history.js. Reuses their
// globals ($, escapeHtml, createPianoRoll, isNoteOn, outputSelect,
// saveImport/listImports/getImport/deleteImport, openScoreView,
// scoreHighlightAt, relayoutScoreView).
//
// Layout: a sticky transport bar (Import button + whatever is selected or
// playing: title, date, play/pause, stop, elapsed/total, piano roll, score),
// then the piano-roll and score panels for that item, then the Imports and Sessions
// lists. Rows only carry per-item actions (play, download, delete); clicking a
// row selects it into the bar.
// ===========================================

const ioView = $('viewIO')
const ioSessionList = $('ioSessionList')
const ioRecentList = $('ioRecentList')
const ioPreview = $('ioPreview')
const ioPreviewBody = $('ioPreviewBody')
const ioPreviewTitle = $('ioPreviewTitle')
const ioNowTitle = $('ioNowTitle')
const ioNowMeta = $('ioNowMeta')
const ioPlayPauseBtn = $('ioPlayPause')
const ioStopBtn = $('ioStop')
const ioTimeEl = $('ioTime')
const ioPianoBtn = $('ioPiano')
const ioScoreBtn = $('ioScore')
const ioProgressFill = $('ioProgressFill')
const ioScorePanel = $('ioScorePanel')
const ioScoreBody = $('ioScoreBody')
const ioScoreTitle = $('ioScoreTitle')

// ---- Items -----------------------------------------------------------------
// Every row in either list is an item keyed `import:<id>` or `session:<id>`.
//   { key, kind, id, title, meta, start?, end?, rec? }
const ioItems = new Map()
let ioCurrentKey = null   // last selected row
let ioPlayingKey = null   // item the server is playing (started from this tab)
let ioPaused = false

// The bar shows what's playing; otherwise the selected row.
function barKey() {
    return ioPlayingKey ?? ioCurrentKey
}

// Parsed/fetched events per item, so the bar, preview and score share one fetch.
// Loading them also fills in item.bounds (see ioSongBounds) for the bar's clock.
const ioEventsCache = new Map()

function ioEventsFor(item) {
    if (!ioEventsCache.has(item.key)) {
        const p = (item.kind === 'import'
            ? parseMidiBlob(item.rec.data, item.rec.name)
            : fetchEventsRange(item.start, item.end)
        ).then(evs => {
            // Lists re-render into fresh item objects; set bounds on the live one.
            const live = ioItems.get(item.key) || item
            live.bounds = item.bounds = ioSongBounds(item, evs)
            return evs
        })
        // Don't cache failures - the next click retries.
        ioEventsCache.set(item.key, p.catch(err => { ioEventsCache.delete(item.key); throw err }))
    }
    return ioEventsCache.get(item.key)
}

// Song bounds used by the clock and preview. Imports are 0-based (server
// progress is timeMs / last event); sessions span their first..last event,
// which is what the server's progress is measured over.
function ioSongBounds(item, evs) {
    if (item.kind === 'import') return { start: 0, end: evs.length ? evs[evs.length - 1].timestamp : 0 }
    if (!evs.length) return { start: item.start, end: item.end }
    return { start: evs[0].timestamp, end: evs[evs.length - 1].timestamp }
}

// ---- Transport clock -------------------------------------------------------
// Tracks the playback position between server updates so the bar's time,
// progress line and the preview's playhead glide instead of stepping.
// Only describes the playing item; song length comes from the bar item's bounds.
const clk = {
    segStart: 0, segEnd: 0,     // what the server is playing (moves on seek)
    progress: 0, at: 0,         // last server progress (0..1 over seg) and when
}
let clkRaf = null

function clkPos() {
    const span = Math.max(1, clk.segEnd - clk.segStart)
    let p = clk.progress
    if (ioPlayingKey && !ioPaused) p += (performance.now() - clk.at) / span
    return clk.segStart + Math.max(0, Math.min(1, p)) * (clk.segEnd - clk.segStart)
}

function fmtTime(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function renderClock() {
    const bounds = ioItems.get(barKey())?.bounds
    const total = bounds ? bounds.end - bounds.start : 0
    const elapsed = ioPlayingKey && bounds ? clkPos() - bounds.start : 0
    ioTimeEl.textContent = `${fmtTime(elapsed)} / ${total > 0 ? fmtTime(total) : '–:––'}`
    ioProgressFill.style.width = total > 0 ? `${Math.min(100, (elapsed / total) * 100)}%` : '0%'
    if (ioPlayingKey && ioPreviewInstance && ioPreviewKey === ioPlayingKey) {
        ioPreviewInstance.setPlayhead(clkPos())
    }
    if (ioScoreKey) scoreHighlightAt(ioPlayingKey && ioScoreKey === ioPlayingKey ? clkPos() : -1)
}

function startClock() {
    if (clkRaf != null) return
    const tick = () => {
        renderClock()
        clkRaf = ioPlayingKey && !ioPaused ? requestAnimationFrame(tick) : null
    }
    clkRaf = requestAnimationFrame(tick)
}

function stopClock() {
    if (clkRaf != null) cancelAnimationFrame(clkRaf)
    clkRaf = null
    renderClock()
}

onPlaybackEvent((data) => {
    if (!ioPlayingKey) return
    clk.progress = data.progress
    clk.at = performance.now()
    if (ioPreviewInstance && ioPreviewKey === ioPlayingKey) {
        const ev = data.event
        if (isNoteOn(ev)) ioPreviewInstance.highlight(ev.note, true)
        else if (isNoteOff(ev)) ioPreviewInstance.highlight(ev.note, false)
    }
    startClock()
})

onPlaybackStatus((status) => {
    if (!ioPlayingKey) return
    if (status === 'paused') {
        // Freeze the estimate where it is, so the clock doesn't run on.
        const span = Math.max(1, clk.segEnd - clk.segStart)
        clk.progress = (clkPos() - clk.segStart) / span
        clk.at = performance.now()
        ioPaused = true
        stopClock()
        if (ioPreviewInstance) ioPreviewInstance.clearHighlights()
    } else if (status === 'resumed') {
        clk.at = performance.now()
        ioPaused = false
        startClock()
    } else if (status === 'ended') {
        ioResetPlayback()
    }
    updateIOButtons()
})

// Playback over: the bar falls back to the selected row.
function ioResetPlayback() {
    if (!ioPlayingKey) return
    ioPlayingKey = null
    ioPaused = false
    clk.progress = 0
    stopClock()
    if (ioPreviewInstance) ioPreviewInstance.clearHighlights()
    renderBar()
}

// ---- Playback --------------------------------------------------------------
async function ioPlay(key, { from } = {}) {
    const item = ioItems.get(key)
    if (!item) return
    try {
        const evs = await ioEventsFor(item)
        const song = item.bounds
        const at = from ?? song.start
        if (item.kind === 'import' && from == null) {
            await playMidiBlob(item.rec.data, item.rec.name)
        } else {
            // Sessions are recorded in the DB, so the server slices the range
            // itself. An import has no DB rows, so a seek sends the client-side
            // slice of its parsed events instead.
            const payload = item.kind === 'import'
                ? { events: evs.filter(e => e.timestamp >= at), output: outputSelect.value || undefined }
                : { start: Math.round(at), end: item.end, output: outputSelect.value || undefined }
            await fetch('/api/playback/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
        }
        ioPlayingKey = key
        ioCurrentKey = key
        ioPaused = false
        Object.assign(clk, { segStart: at, segEnd: song.end, progress: 0, at: performance.now() })
        if (ioPreviewInstance) ioPreviewInstance.clearHighlights()
        renderBar()
        startClock()
    } catch (err) {
        console.error('Playback failed:', err)
    }
}

async function ioStop() {
    await fetch('/api/playback/stop', { method: 'POST' })
    // The server only announces 'ended' if something was actually playing
    // (an empty session never starts), so reset here too.
    ioResetPlayback()
}

// Play / pause / resume for one item - shared by the bar and the row buttons.
async function ioToggle(key) {
    if (!key) return
    if (ioPlayingKey !== key) return ioPlay(key)
    await fetch(ioPaused ? '/api/playback/resume' : '/api/playback/pause', { method: 'POST' })
}

// ---- Selection and the bar -------------------------------------------------
// Clicking a row selects it. While something is playing the bar keeps showing
// that; the selection takes over once playback stops.
function selectIOItem(key) {
    const item = ioItems.get(key)
    if (!item) return
    ioCurrentKey = key
    // Total time needs the events; fetch (cached) and fill it in.
    ioEventsFor(item).then(() => { if (barKey() === key) renderClock() }).catch(() => {})
    renderBar()
}

let ioBarShown = null   // item the bar (and open preview) last rendered

function renderBar() {
    const key = barKey()
    const item = ioItems.get(key)
    ioNowTitle.textContent = item ? item.title : 'Nothing selected'
    ioNowMeta.textContent = item ? item.meta : 'Import a .mid file, or pick an import or session below'
    if (key !== ioBarShown) {
        ioBarShown = key
        // Open piano roll / score panels follow the bar.
        if (!ioPreview.classList.contains('hidden')) {
            if (item) openIOPreviewFor(key)
            else closeIOPreview()
        }
        if (ioScoreKey) {
            if (item) openIOScoreFor(key)
            else closeIOScore()
        }
    }
    updateIOButtons()
    renderClock()
}

function setPlayBtn(btn, key) {
    const playing = ioPlayingKey === key && !ioPaused
    btn.innerHTML = playing ? '&#x23F8;' : '&#x25B6;'
    btn.title = playing ? 'Pause' : (ioPlayingKey === key ? 'Resume' : 'Play')
    btn.classList.toggle('playing', ioPlayingKey === key)
}

function updateIOButtons() {
    const has = !!barKey()
    ioPlayPauseBtn.disabled = !has
    ioPianoBtn.disabled = !has
    ioScoreBtn.disabled = !has
    ioStopBtn.disabled = !ioPlayingKey
    setPlayBtn(ioPlayPauseBtn, barKey())
    ioPianoBtn.classList.toggle('active', !ioPreview.classList.contains('hidden'))
    ioScoreBtn.classList.toggle('active', !!ioScoreKey)
    for (const row of ioView.querySelectorAll('.io-item')) {
        row.classList.toggle('selected', row.dataset.key === ioCurrentKey)
        const btn = row.querySelector('.io-row-play')
        if (btn) setPlayBtn(btn, row.dataset.key)
    }
}

ioPlayPauseBtn.addEventListener('click', () => ioToggle(barKey()))
ioStopBtn.addEventListener('click', ioStop)
ioScoreBtn.addEventListener('click', () => {
    if (ioScoreKey) closeIOScore()
    else if (barKey()) openIOScoreFor(barKey(), { scroll: true })
})
ioPianoBtn.addEventListener('click', () => {
    if (!ioPreview.classList.contains('hidden')) closeIOPreview()
    else if (barKey()) openIOPreviewFor(barKey(), { scroll: true })
})

// ---- Piano-roll preview (sits under the bar, shows the selected item) ------
let ioPreviewInstance = null
let ioPreviewKey = null

// Drag the playhead handle to jump playback elsewhere in the song.
function seekIOPreview(t) {
    if (ioPreviewKey) ioPlay(ioPreviewKey, { from: Math.round(t) })
}

// Also used directly by the UI tests with a raw event list.
function openIOPianoRoll(events, { title, start, end, key, scroll = true } = {}) {
    ioPreviewKey = key || null
    ioPreviewTitle.textContent = title ? `Piano roll — ${title}` : 'Piano roll'
    ioPreviewBody.innerHTML = ''
    ioPreviewInstance = createPianoRoll(ioPreviewBody, {
        keyboard: true,
        flipped: false,
        onSeek: key ? seekIOPreview : undefined,
    })
    ioPreview.classList.remove('hidden')
    updateIOButtons()

    const evs = events || []
    const s = start ?? (evs.length ? evs[0].timestamp : 0)
    const e = end ?? (evs.length ? evs[evs.length - 1].timestamp : s + 1000)
    if (scroll) ioView.scrollTo({ top: 0, behavior: 'smooth' })
    requestAnimationFrame(() => {
        if (!ioPreviewInstance) return
        ioPreviewInstance.setData(evs, s, e)
        renderClock()
    })
}

// scroll: bring the preview into view (when opened from the bar, not when it
// just follows a selection made further down the list).
async function openIOPreviewFor(key, { scroll = false } = {}) {
    const item = ioItems.get(key)
    if (!item) return
    const evs = await ioEventsFor(item)
    if (barKey() !== key) return   // bar moved on while loading
    openIOPianoRoll(evs, { title: item.title, start: item.bounds.start, end: item.bounds.end, key, scroll })
}

function closeIOPreview() {
    ioPreviewKey = null
    ioPreview.classList.add('hidden')
    ioPreviewBody.innerHTML = ''
    ioPreviewInstance = null
    updateIOButtons()
}

$('ioPreviewClose').addEventListener('click', closeIOPreview)

// ---- Score (a panel like the piano roll, shows the bar's item) -------------
let ioScoreKey = null

async function openIOScoreFor(key, { scroll = false } = {}) {
    const item = ioItems.get(key)
    if (!item) return
    ioScoreKey = key
    ioScoreTitle.textContent = `Score — ${item.title}`
    ioScorePanel.classList.remove('hidden')
    updateIOButtons()
    if (scroll) ioScorePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const evs = await ioEventsFor(item)
    if (ioScoreKey !== key) return   // closed or moved on while loading
    openScoreView(evs, { host: ioScoreBody })
    renderClock()
}

function closeIOScore() {
    ioScoreKey = null
    ioScorePanel.classList.add('hidden')
    updateIOButtons()
}

$('ioScoreClose').addEventListener('click', closeIOScore)

let ioResizeTimer = null
window.addEventListener('resize', () => {
    if (ioPreviewInstance) ioPreviewInstance.resize()
    // The score lays out measures to the width; re-flow once resizing settles.
    clearTimeout(ioResizeTimer)
    ioResizeTimer = setTimeout(() => { if (ioScoreKey) relayoutScoreView() }, 200)
})

// ---- Shared helpers --------------------------------------------------------
async function fetchEventsRange(start, end) {
    try {
        const res = await fetch(`/api/events/range?start=${start}&end=${end}`)
        return await res.json()
    } catch (err) {
        console.error('Failed to fetch events:', err)
        return []
    }
}

// Parse raw .mid bytes into note events (via the server, no storage).
async function parseMidiBlob(data, name) {
    const fd = new FormData()
    fd.append('file', new File([data], name || 'import.mid', { type: 'audio/midi' }))
    const res = await fetch('/api/midi/file/parse', { method: 'POST', body: fd })
    const json = await res.json()
    if (json.error) throw new Error(json.error)
    return json.events || []
}

// Play raw .mid bytes on the current output.
async function playMidiBlob(data, name) {
    const fd = new FormData()
    fd.append('file', new File([data], name || 'import.mid', { type: 'audio/midi' }))
    if (outputSelect.value) fd.append('output', outputSelect.value)
    await fetch('/api/playback/file', { method: 'POST', body: fd })
}

function rowActions(key, download) {
    return `
        <div class="io-item-actions">
            <button class="btn-icon io-row-play" title="Play">&#x25B6;</button>
            ${download}
            <button class="btn-icon io-row-delete" title="Delete">&#x1F5D1;</button>
        </div>`
}

// Drop items whose rows were re-rendered away; clear the bar if it lost its item.
function pruneIOItems(prefix, keep) {
    for (const key of [...ioItems.keys()]) {
        if (key.startsWith(prefix) && !keep.has(key)) {
            ioItems.delete(key)
            ioEventsCache.delete(key)
        }
    }
    if (ioCurrentKey && !ioItems.has(ioCurrentKey)) ioCurrentKey = null
    renderBar()
}

// ---- Imports (IndexedDB) ---------------------------------------------------
// Called from app.js after a file is imported (with its id, to select it).
async function loadRecentImports(selectId) {
    let imports = []
    try {
        imports = await listImports()
    } catch (err) {
        console.error('Failed to list imports:', err)
    }
    const keep = new Set()
    for (const f of imports) {
        const key = `import:${f.id}`
        keep.add(key)
        ioItems.set(key, {
            key, kind: 'import', id: f.id, rec: f, title: f.name, bounds: ioItems.get(key)?.bounds,
            meta: `Imported ${new Date(f.importedAt).toLocaleString()} · ${(f.size / 1024).toFixed(1)} KB`,
        })
    }
    pruneIOItems('import:', keep)
    ioRecentList.innerHTML = imports.length ? imports.map(f => `
        <div class="io-item" data-key="import:${f.id}">
            <div class="io-item-main">
                <div class="title">${escapeHtml(f.name)}</div>
                <div class="meta">${new Date(f.importedAt).toLocaleString()} &middot; ${(f.size / 1024).toFixed(1)} KB</div>
            </div>
            ${rowActions(`import:${f.id}`, '<button class="btn-icon io-row-download" title="Download .mid">&#x2913; .mid</button>')}
        </div>
    `).join('') : '<div class="history-empty">No imports yet.</div>'

    if (selectId != null) selectIOItem(`import:${selectId}`)
    else if (!ioCurrentKey && imports.length) selectIOItem(`import:${imports[0].id}`)
    updateIOButtons()
}

// ---- Sessions (export) -----------------------------------------------------
async function loadIOSessions() {
    await loadRecentImports()
    try {
        const res = await fetch('/api/sessions')
        const sessions = await res.json()
        const keep = new Set()
        for (const s of sessions) {
            const key = `session:${s.id}`
            keep.add(key)
            const performer = s.performer || 'Unknown'
            ioItems.set(key, {
                key, kind: 'session', id: s.id, start: s.start_time, end: s.end_time, bounds: ioItems.get(key)?.bounds,
                title: s.song_name || 'Untitled',
                meta: `${performer} · ${new Date(s.start_time).toLocaleString()} · ${fmtTime(s.end_time - s.start_time)}`,
            })
        }
        pruneIOItems('session:', keep)
        ioSessionList.innerHTML = sessions.length ? sessions.map(s => `
            <div class="io-item io-session" data-key="session:${s.id}">
                <div class="io-item-main">
                    <div class="title">${escapeHtml(s.song_name || 'Untitled')}</div>
                    <div class="meta">${escapeHtml(s.performer || 'Unknown')} &middot; ${new Date(s.start_time).toLocaleString()} &middot; ${fmtTime(s.end_time - s.start_time)}</div>
                </div>
                ${rowActions(`session:${s.id}`, `<a class="btn-icon io-export" title="Download .mid" href="/api/sessions/${s.id}/export.mid" download>&#x2913; .mid</a>`)}
            </div>
        `).join('') : '<div class="history-empty">No saved sessions yet. Save one from the Live or History tab.</div>'
        if (!ioCurrentKey && sessions.length) selectIOItem(`session:${sessions[0].id}`)
        updateIOButtons()
    } catch (err) {
        console.error('Failed to load sessions:', err)
        ioSessionList.innerHTML = '<div class="history-empty">Failed to load sessions.</div>'
    }
}

// ---- Row clicks (both lists) -----------------------------------------------
// Delete asks for a second click (the button turns into "Delete?") rather
// than deleting on the first.
let ioDeleteArmed = null

ioView.addEventListener('click', async (e) => {
    const row = e.target.closest('.io-item')
    if (!row) return
    const key = row.dataset.key
    const item = ioItems.get(key)
    if (!item) return

    const del = e.target.closest('.io-row-delete')
    if (!del && ioDeleteArmed) {
        ioDeleteArmed.classList.remove('armed')
        ioDeleteArmed.innerHTML = '&#x1F5D1;'
        ioDeleteArmed = null
    }

    if (e.target.closest('.io-row-play')) {
        ioToggle(key)
    } else if (e.target.closest('.io-row-download')) {
        const url = URL.createObjectURL(new Blob([item.rec.data], { type: 'audio/midi' }))
        const a = document.createElement('a')
        a.href = url
        a.download = item.rec.name.endsWith('.mid') ? item.rec.name : `${item.rec.name}.mid`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    } else if (e.target.closest('.io-export')) {
        // <a download>: let it handle itself.
    } else if (del) {
        if (ioDeleteArmed !== del) {
            ioDeleteArmed = del
            del.classList.add('armed')
            del.textContent = 'Delete?'
            return
        }
        ioDeleteArmed = null
        if (ioPlayingKey === key) await ioStop()
        if (item.kind === 'import') {
            await deleteImport(item.id)
            loadRecentImports()
        } else {
            await fetch(`/api/sessions/${item.id}`, { method: 'DELETE' })
            loadIOSessions()
            if (typeof loadSessions === 'function') loadSessions()
        }
    } else {
        selectIOItem(key)
    }
})

renderBar()
