// ===========================================
// Import / Export tab
//
// Loaded after piano-roll.js, imports-db.js, app.js, history.js. Reuses their
// globals ($, escapeHtml, createPianoRoll, isNoteOn, outputSelect,
// saveImport/listImports/getImport/deleteImport, openScoreView,
// scoreHighlightAt, relayoutScoreView).
//
// Layout: a transport bar under the header (Import button + whatever is
// selected or playing: title, date, play/pause, stop, loop, elapsed/total,
// piano roll, score), then the piano-roll and score panels for that item, then
// the Imports and Sessions lists. Rows only carry per-item actions (play,
// download, delete); clicking a row selects it into the bar.
//
// The bar is the app's one transport: on the other tabs it shows (without the
// Import button) when something plays, with the piano-roll / score panels
// under it, and stays until closed. Something playing that has no row
// here - a History stretch, a timeline selection - gets a stand-in item, an
// "Unsaved session"; its piano roll and score work like a saved one's.
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
const ioRepeatBtn = $('ioRepeat')
const ioTimeEl = $('ioTime')
const ioPianoBtn = $('ioPiano')
const ioScoreBtn = $('ioScore')
const ioProgressFill = $('ioProgressFill')
const ioScorePanel = $('ioScorePanel')
const ioScoreBody = $('ioScoreBody')
const ioScoreTitle = $('ioScoreTitle')
const ioToolbar = $('ioToolbar')
const ioTransport = $('transport')        // the bar + its panels
const ioTransportPanels = $('transportPanels')
const ioBarClose = $('ioBarClose')

// ---- Items -----------------------------------------------------------------
// Every row in either list is an item keyed `import:<id>` or `session:<id>`.
//   { key, kind, id, title, meta, start?, end?, rec? }
// Stand-ins for playing clips without a row use the clip's own key (kind
// 'unsaved': a recorded range; 'external': a file imported in another browser,
// which this page can play the controls of but not show).
const ioItems = new Map()
let ioCurrentKey = null   // last selected row
// Mirrors of the shared player (player.js), kept by the listener below:
let ioPlayingKey = null   // this tab's item the player has loaded (whoever started it)
let ioPaused = false

// The bar shows what's playing; otherwise the selected row.
function barKey() {
    return ioPlayingKey ?? ioCurrentKey
}

// Parsed/fetched events per item, so the bar, preview and score share one fetch.
// Loading them also fills in item.bounds (see ioSongBounds) for the bar's clock.
const ioEventsCache = new Map()

function ioEventsFor(item) {
    if (item.kind === 'external') return Promise.reject(new Error('Not in this browser'))
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
// The shared player keeps the (gliding) position; the bar's time, progress
// line, the preview's playhead and the score's highlight follow it.
function fmtTime(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function renderClock() {
    const bounds = ioItems.get(barKey())?.bounds
    const total = bounds ? bounds.end - bounds.start : 0
    const pos = ioPlayingKey ? player.position() : null
    const elapsed = pos != null && bounds ? pos - bounds.start : 0
    ioTimeEl.textContent = `${fmtTime(elapsed)} / ${total > 0 ? fmtTime(total) : '–:––'}`
    ioProgressFill.style.width = total > 0 ? `${Math.min(100, (elapsed / total) * 100)}%` : '0%'
    if (pos != null && ioPreviewInstance && ioPreviewKey === ioPlayingKey) {
        ioPreviewInstance.setPlayhead(pos)
    }
    if (ioScoreKey) scoreHighlightAt(pos != null && ioScoreKey === ioPlayingKey ? pos : -1)
}

player.onTick(() => {
    if (ioPlayingKey) renderClock()
})

onPlaybackEvent((data) => {
    if (ioPlayingKey && ioPreviewInstance && ioPreviewKey === ioPlayingKey) {
        ioPreviewInstance.playbackEvent(data.event)
    }
})

// A playing clip with no row here gets a stand-in item so the bar can show it.
function ioStandIn(clip) {
    if (!clip?.key || ioItems.has(clip.key)) return
    const span = `${new Date(clip.start).toLocaleString()} · ${fmtTime(clip.end - clip.start)}`
    const from = { history: 'From History', live: 'Timeline selection' }[clip.source]
    ioItems.set(clip.key, clip.kind === 'range'
        ? {
            key: clip.key, kind: 'unsaved', start: clip.start, end: clip.end,
            title: 'Unsaved session',
            meta: [from, span].filter(Boolean).join(' · '),
        }
        : {
            key: clip.key, kind: 'external', bounds: { start: clip.start, end: clip.end },
            title: clip.title || 'MIDI file',
            meta: 'Imported in another browser',
        })
}

// Shown on Import / Export always. Elsewhere it appears whenever something is
// started (not for a loop's next pass) or is found playing on connect, and
// stays, drawer and all, until closed with its X - playing or not.
let ioBarDismissed = true

function updateTransportBar() {
    const onIO = !ioView.classList.contains('hidden')
    const shown = onIO || !ioBarDismissed
    const revealed = shown && ioTransport.classList.contains('hidden')
    ioToolbar.classList.toggle('elsewhere', !onIO)
    ioTransport.classList.toggle('elsewhere', !onIO)
    ioTransport.classList.toggle('hidden', !shown)
    ioBarClose.classList.toggle('hidden', onIO)  // its home tab: always there
    // Panels can't be measured while hidden: size them on reveal
    if (revealed) {
        requestAnimationFrame(() => {
            if (ioPreviewInstance) ioPreviewInstance.resize()
            if (ioScoreKey) relayoutScoreView()
        })
    }
}

ioBarClose.addEventListener('click', () => {
    ioBarDismissed = true
    closeIOPreview()
    closeIOScore()
    updateTransportBar()
})

player.on((state, reason, message) => {
    if ((reason === 'started' && !message?.restart) || (reason === 'state' && state.status !== 'idle')) {
        ioBarDismissed = false
    }
    if (state.status !== 'idle') {
        ioStandIn(state.clip)
        // The clip knows its length before the item's events are fetched
        const item = ioItems.get(state.clip?.key)
        if (item && !item.bounds) item.bounds = { start: state.clip.start, end: state.clip.end }
    }
    const key = state.status !== 'idle' && state.clip?.key
    const wasPlaying = ioPlayingKey
    ioPlayingKey = key && ioItems.has(key) ? key : null
    ioPaused = state.status === 'paused'
    if (ioPlayingKey) ioCurrentKey = ioPlayingKey

    // The server silences everything when a pass starts, pauses or ends, and
    // the preview's keys follow; the final render puts the playhead back.
    if (reason !== 'resumed' && reason !== 'loop' && ioPreviewInstance) ioPreviewInstance.clearHighlights()
    if (ioPlayingKey !== wasPlaying) renderBar()
    else {
        updateIOButtons()
        renderClock()
    }
    // A file from another browser can't be replayed from here once it's over
    if (!ioPlayingKey && ioItems.get(ioCurrentKey)?.kind === 'external') {
        ioItems.delete(ioCurrentKey)
        ioCurrentKey = null
        renderBar()
    }
    updateTransportBar()
})

// ---- Playback --------------------------------------------------------------
// Starts `key` on the shared player (from the top, or from clip time `from`).
async function ioPlay(key, { from } = {}) {
    const item = ioItems.get(key)
    if (!item || item.kind === 'external') return
    ioCurrentKey = key
    if (ioPreviewInstance) ioPreviewInstance.clearHighlights()
    const clip = { title: item.title, key, source: 'io', from }
    if (item.kind === 'import') await player.playFile({ ...clip, data: item.rec.data, name: item.rec.name })
    else await player.playRange({ ...clip, start: item.start, end: item.end })
}

function ioStop() {
    return player.stop()
}

// Play / pause / resume for one item - shared by the bar and the row buttons.
async function ioToggle(key) {
    if (!key) return
    if (ioPlayingKey !== key) return ioPlay(key)
    await player.toggle()
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
    const viewable = has && ioItems.get(barKey())?.kind !== 'external'
    ioPlayPauseBtn.disabled = !has
    ioPianoBtn.disabled = !viewable
    ioScoreBtn.disabled = !viewable
    ioStopBtn.disabled = player.state.status === 'idle'   // stops whatever is playing
    ioRepeatBtn.classList.toggle('active', player.state.loop)
    ioRepeatBtn.setAttribute('aria-pressed', String(player.state.loop))
    setPlayBtn(ioPlayPauseBtn, barKey())
    ioPianoBtn.classList.toggle('active', !ioPreview.classList.contains('hidden'))
    ioScoreBtn.classList.toggle('active', !!ioScoreKey)
    ioTransportPanels.classList.toggle('open', !ioPreview.classList.contains('hidden') || !!ioScoreKey)
    for (const row of ioView.querySelectorAll('.io-item')) {
        row.classList.toggle('selected', row.dataset.key === ioCurrentKey)
        const btn = row.querySelector('.io-row-play')
        if (btn) setPlayBtn(btn, row.dataset.key)
    }
}

ioPlayPauseBtn.addEventListener('click', () => ioToggle(barKey()))
ioStopBtn.addEventListener('click', ioStop)

ioRepeatBtn.addEventListener('click', () => player.setLoop(!player.state.loop))
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
    if (!ioPreviewKey) return
    if (ioPlayingKey === ioPreviewKey) player.seek(t)
    else ioPlay(ioPreviewKey, { from: Math.round(t) })
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
        sustain: true,
    })
    ioPreview.classList.remove('hidden')
    updateIOButtons()

    const evs = events || []
    const s = start ?? (evs.length ? evs[0].timestamp : 0)
    const e = end ?? (evs.length ? evs[evs.length - 1].timestamp : s + 1000)
    if (scroll) ioTransportPanels.scrollTo({ top: 0, behavior: 'smooth' })
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
updateTransportBar()
