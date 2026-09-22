// ===========================================
// Import / Export tab
//
// Loaded after piano-roll.js, imports-db.js, app.js, history.js. Reuses their
// globals ($, escapeHtml, createPianoRoll, isNoteOn, outputSelect,
// saveImport/listImports/getImport/deleteImport, openScoreView).
// ===========================================

const ioSessionList = $('ioSessionList')
const ioRecentList = $('ioRecentList')
const ioPreview = $('ioPreview')
const ioPreviewBody = $('ioPreviewBody')
const ioPreviewTitle = $('ioPreviewTitle')

// ---- Inline piano-roll preview (expands on the page; no modal) -------------
let ioPreviewInstance = null
// Identifies which "Piano roll" button opened the preview, so clicking that
// same button again toggles it closed instead of just re-rendering it.
let ioPreviewAnchorKey = null

function placeIOPreviewAfter(el) {
    if (el) el.insertAdjacentElement('afterend', ioPreview)
}

// Drag the playhead handle to jump playback elsewhere in the song. Only
// meaningful when start/end are real timestamps in the recorded-event store
// (true for sessions; not for an uploaded/parsed .mid file's own 0-based
// timestamps), so callers opt in with `seekable`.
async function seekIOPreview(t) {
    const newStart = Math.round(t)
    // Notes highlighted from before the jump no longer reflect what's
    // playing at the new position - drop them so the keyboard doesn't
    // show stale/stuck-on keys until fresh noteon/noteoff events arrive.
    if (ioPreviewInstance) ioPreviewInstance.clearHighlights()
    try {
        // Sessions are recorded in the DB, so the server can slice
        // [newStart, previewEnd] itself. A parsed-but-unstored import (recent
        // imports) has no DB rows, so we slice the events we already have
        // client-side and send them along instead.
        const payload = previewSeekMode === 'events'
            ? { events: ioPreviewEvents.filter(e => e.timestamp >= newStart && e.timestamp <= previewEnd), output: outputSelect.value || undefined }
            : { start: newStart, end: previewEnd, output: outputSelect.value || undefined }
        await fetch('/api/playback/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        // The server now reports progress (0..1) over [newStart, previewEnd],
        // not the original song span - rebase so the interpolated line keeps
        // landing in the right place instead of snapping back on the next
        // playback-event message.
        previewStart = newStart
        pbProgress = 0
        pbAt = performance.now()
    } catch (err) {
        console.error('Seek failed:', err)
    }
}

function openIOPianoRoll(events, { title, start, end, anchorKey, anchorEl, forceOpen, seekable } = {}) {
    // forceOpen skips the toggle-closed check: used when playback switches to
    // a different song while the preview is already open, so it follows the
    // new song instead of closing.
    if (!forceOpen && anchorKey && anchorKey === ioPreviewAnchorKey && !ioPreview.classList.contains('hidden')) {
        closeIOPreview()
        return
    }
    ioPreviewAnchorKey = anchorKey || null

    ioPreviewTitle.textContent = title ? `Piano roll — ${title}` : 'Piano roll'
    ioPreviewBody.innerHTML = ''
    ioPreviewInstance = createPianoRoll(ioPreviewBody, {
        keyboard: true,
        flipped: false,
        onSeek: seekable ? seekIOPreview : undefined,
    })
    placeIOPreviewAfter(anchorEl)
    ioPreview.classList.remove('hidden')

    const evs = events || []
    const s = start ?? (evs.length ? evs[0].timestamp : 0)
    const e = end ?? (evs.length ? evs[evs.length - 1].timestamp : s + 1000)
    previewStart = s
    previewEnd = e
    // 'events' (recent imports): not in the DB, so seeking replays a
    // client-side slice of these events. Anything else (sessions): the
    // server slices its own DB range instead.
    previewSeekMode = seekable === 'events' ? 'events' : 'session'
    ioPreviewEvents = evs
    stopPreviewPlayhead()
    // Scroll the row that was clicked to the top, not the preview title, so
    // the entry (with its play/stop button) stays visible above the panel.
    ;(anchorEl || ioPreview).scrollIntoView({ behavior: 'smooth', block: 'start' })
    requestAnimationFrame(() => ioPreviewInstance && ioPreviewInstance.setData(evs, s, e))
}

function closeIOPreview() {
    ioPreviewAnchorKey = null
    stopPreviewPlayhead()
    ioPreview.classList.add('hidden')
    ioPreviewBody.innerHTML = ''
    ioPreviewInstance = null
}

// Re-attach the preview after the row that opened it whenever a list
// re-renders (innerHTML replacement would otherwise orphan it in place).
function repositionIOPreview(container, prefix) {
    if (ioPreview.classList.contains('hidden')) return
    if (!ioPreviewAnchorKey || !ioPreviewAnchorKey.startsWith(prefix)) return
    const id = ioPreviewAnchorKey.slice(prefix.length)
    const row = container.querySelector(`[data-id="${id}"]`)
    if (row) placeIOPreviewAfter(row)
}

$('ioPreviewClose').addEventListener('click', closeIOPreview)
window.addEventListener('resize', () => { if (ioPreviewInstance) ioPreviewInstance.resize() })

// ---- Moving playhead + lit keys, driven by the playback stream -------------
let previewStart = 0
let previewEnd = 1
let previewSeekMode = 'session'  // 'session' (DB range) or 'events' (client-side slice)
let ioPreviewEvents = []         // full event list for the open preview, for 'events' mode
let pbProgress = 0        // last progress (0..1) reported by the server
let pbAt = 0              // performance.now() when pbProgress was set
let pbRaf = null

function startPreviewPlayhead() {
    if (pbRaf != null) return
    const tick = () => {
        if (!ioPreviewInstance || ioPreview.classList.contains('hidden')) { pbRaf = null; return }
        const span = Math.max(1, previewEnd - previewStart)
        // Interpolate between server updates so the line glides (progress
        // advances 1 over the whole span).
        const est = Math.max(0, Math.min(1, pbProgress + (performance.now() - pbAt) / span))
        ioPreviewInstance.setPlayhead(previewStart + est * (previewEnd - previewStart))
        pbRaf = requestAnimationFrame(tick)
    }
    pbRaf = requestAnimationFrame(tick)
}

function stopPreviewPlayhead() {
    if (pbRaf != null) cancelAnimationFrame(pbRaf)
    pbRaf = null
}

onPlaybackEvent((data) => {
    if (!ioPreviewInstance || ioPreview.classList.contains('hidden')) return
    pbProgress = data.progress
    pbAt = performance.now()
    const ev = data.event
    if (isNoteOn(ev)) ioPreviewInstance.highlight(ev.note, true)
    else if (isNoteOff(ev)) ioPreviewInstance.highlight(ev.note, false)
    startPreviewPlayhead()
})

onPlaybackStatus((status) => {
    if (status === 'ended') {
        stopPreviewPlayhead()
        if (ioPreviewInstance) ioPreviewInstance.clearHighlights()
    }
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

// ---- Recent imports (IndexedDB) --------------------------------------------
async function loadRecentImports() {
    let imports = []
    try {
        imports = await listImports()
    } catch (err) {
        console.error('Failed to list imports:', err)
    }
    if (!imports.length) {
        ioRecentList.innerHTML = '<div class="history-empty">No imports yet. Select a file above.</div>'
        return
    }
    ioRecentList.innerHTML = imports.map(f => `
        <div class="io-item" data-id="${f.id}">
            <div class="io-item-main">
                <div class="title">${escapeHtml(f.name)}</div>
                <div class="meta">${(f.size / 1024).toFixed(1)} KB &middot; ${new Date(f.importedAt).toLocaleString()}</div>
            </div>
            <div class="io-item-actions">
                <button class="btn-icon io-recent-play" title="Play">&#x25B6;</button>
                <button class="btn-icon io-recent-piano" title="Piano roll">&#x1F3B9;</button>
                <button class="btn-icon io-recent-score" title="Score">&#x1D11E;</button>
                <button class="btn-icon io-recent-download" title="Download .mid">&#x2913; .mid</button>
                <button class="btn-icon io-recent-delete" title="Delete">&#x1F5D1;</button>
            </div>
        </div>
    `).join('')
    repositionIOPreview(ioRecentList, 'recent:')
    updateIOPlayButtons()
}

ioRecentList.addEventListener('click', async (e) => {
    const row = e.target.closest('.io-item')
    if (!row) return
    const id = parseInt(row.dataset.id, 10)
    const rec = await getImport(id)
    if (!rec) return
    const title = rec.name

    if (e.target.closest('.io-recent-play')) {
        const key = `recent:${id}`
        if (ioPlayingKey === key) {
            await fetch('/api/playback/stop', { method: 'POST' })
            ioPlayingKey = null
            updateIOPlayButtons()
        } else {
            await playMidiBlob(rec.data, rec.name)
            ioPlayingKey = key
            updateIOPlayButtons()
            // Preview follows playback: if it's already open (for this import,
            // a different import, or a session), switch it to what's now playing.
            if (!ioPreview.classList.contains('hidden')) {
                openIOPianoRoll(await parseMidiBlob(rec.data, rec.name), {
                    title, anchorKey: key, anchorEl: row, forceOpen: true, seekable: 'events',
                })
            }
        }
    } else if (e.target.closest('.io-recent-piano')) {
        openIOPianoRoll(await parseMidiBlob(rec.data, rec.name), { title, anchorKey: `recent:${id}`, anchorEl: row, seekable: 'events' })
    } else if (e.target.closest('.io-recent-score')) {
        if (typeof openScoreView === 'function') openScoreView(await parseMidiBlob(rec.data, rec.name), { title })
    } else if (e.target.closest('.io-recent-download')) {
        const url = URL.createObjectURL(new Blob([rec.data], { type: 'audio/midi' }))
        const a = document.createElement('a')
        a.href = url
        a.download = rec.name.endsWith('.mid') ? rec.name : `${rec.name}.mid`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    } else if (e.target.closest('.io-recent-delete')) {
        await deleteImport(id)
        loadRecentImports()
    }
})

// ---- Sessions (export) -----------------------------------------------------
async function loadIOSessions() {
    loadRecentImports()
    try {
        const res = await fetch('/api/sessions')
        const sessions = await res.json()
        if (!sessions.length) {
            ioSessionList.innerHTML = '<div class="history-empty">No saved sessions yet. Save one from the Live or History tab.</div>'
            return
        }
        ioSessionList.innerHTML = sessions.map(s => `
            <div class="io-item io-session" data-id="${s.id}" data-start="${s.start_time}" data-end="${s.end_time}">
                <div class="io-item-main">
                    <div class="title">${escapeHtml(s.song_name || 'Untitled')}</div>
                    <div class="meta">${escapeHtml(s.performer || 'Unknown')} &middot; ${new Date(s.start_time).toLocaleString()}</div>
                </div>
                <div class="io-item-actions">
                    <button class="btn-icon io-session-play" title="Play">&#x25B6;</button>
                    <button class="btn-icon io-piano" title="Piano roll">&#x1F3B9;</button>
                    <button class="btn-icon io-score" title="Score">&#x1D11E;</button>
                    <a class="btn-icon io-export" title="Download as .mid" href="/api/sessions/${s.id}/export.mid" download>&#x2913; .mid</a>
                </div>
            </div>
        `).join('')
        repositionIOPreview(ioSessionList, 'session:')
        updateIOPlayButtons()
    } catch (err) {
        console.error('Failed to load sessions:', err)
        ioSessionList.innerHTML = '<div class="history-empty">Failed to load sessions.</div>'
    }
}

// ---- Play/stop across both lists (one playback active at a time, server-side) --
// Key is `session:<id>` or `recent:<id>`, whichever last started playback, so
// clicking Play in one list also flips any other row (in either list) that
// was showing Stop back to Play.
let ioPlayingKey = null

function updateIOPlayButtons() {
    ioSessionList.querySelectorAll('.io-item').forEach(row => {
        const btn = row.querySelector('.io-session-play')
        if (!btn) return
        const playing = ioPlayingKey === `session:${row.dataset.id}`
        btn.innerHTML = playing ? '&#x23F9;' : '&#x25B6;'
        btn.title = playing ? 'Stop' : 'Play'
        btn.classList.toggle('playing', playing)
    })
    ioRecentList.querySelectorAll('.io-item').forEach(row => {
        const btn = row.querySelector('.io-recent-play')
        if (!btn) return
        const playing = ioPlayingKey === `recent:${row.dataset.id}`
        btn.innerHTML = playing ? '&#x23F9;' : '&#x25B6;'
        btn.title = playing ? 'Stop' : 'Play'
        btn.classList.toggle('playing', playing)
    })
}

onPlaybackStatus((status) => {
    if (status === 'ended') {
        ioPlayingKey = null
        updateIOPlayButtons()
    }
})

ioSessionList.addEventListener('click', async (e) => {
    const row = e.target.closest('.io-session')
    if (!row) return
    const id = parseInt(row.dataset.id, 10)
    const start = parseInt(row.dataset.start, 10)
    const end = parseInt(row.dataset.end, 10)
    const title = row.querySelector('.title')?.textContent || 'Session'

    if (e.target.closest('.io-session-play')) {
        const key = `session:${id}`
        if (ioPlayingKey === key) {
            await fetch('/api/playback/stop', { method: 'POST' })
            ioPlayingKey = null
            updateIOPlayButtons()
        } else {
            try {
                await fetch('/api/playback/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start, end, output: outputSelect.value || undefined }),
                })
                ioPlayingKey = key
                updateIOPlayButtons()
                // Preview follows playback: if it's already open (for this
                // song or another), switch it to the song that's now playing.
                if (!ioPreview.classList.contains('hidden')) {
                    openIOPianoRoll(await fetchEventsRange(start, end), {
                        start, end, title, anchorKey: key, anchorEl: row, forceOpen: true, seekable: true,
                    })
                }
            } catch (err) {
                console.error('Playback failed:', err)
            }
        }
    } else if (e.target.closest('.io-piano')) {
        openIOPianoRoll(await fetchEventsRange(start, end), { start, end, title, anchorKey: `session:${id}`, anchorEl: row, seekable: true })
    } else if (e.target.closest('.io-score')) {
        if (typeof openScoreView === 'function') openScoreView(await fetchEventsRange(start, end), { start, end, title })
    }
    // The export link is an <a download>; let it handle itself.
})
