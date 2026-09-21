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

function openIOPianoRoll(events, { title, start, end, anchorKey, anchorEl } = {}) {
    if (anchorKey && anchorKey === ioPreviewAnchorKey && !ioPreview.classList.contains('hidden')) {
        closeIOPreview()
        return
    }
    ioPreviewAnchorKey = anchorKey || null

    ioPreviewTitle.textContent = title ? `Piano roll — ${title}` : 'Piano roll'
    ioPreviewBody.innerHTML = ''
    ioPreviewInstance = createPianoRoll(ioPreviewBody, { keyboard: true, flipped: false })
    placeIOPreviewAfter(anchorEl)
    ioPreview.classList.remove('hidden')

    const evs = events || []
    const s = start ?? (evs.length ? evs[0].timestamp : 0)
    const e = end ?? (evs.length ? evs[evs.length - 1].timestamp : s + 1000)
    previewStart = s
    previewEnd = e
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
}

ioRecentList.addEventListener('click', async (e) => {
    const row = e.target.closest('.io-item')
    if (!row) return
    const id = parseInt(row.dataset.id, 10)
    const rec = await getImport(id)
    if (!rec) return
    const title = rec.name

    if (e.target.closest('.io-recent-play')) {
        await playMidiBlob(rec.data, rec.name)
    } else if (e.target.closest('.io-recent-piano')) {
        openIOPianoRoll(await parseMidiBlob(rec.data, rec.name), { title, anchorKey: `recent:${id}`, anchorEl: row })
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
        updateIOSessionPlayButtons()
    } catch (err) {
        console.error('Failed to load sessions:', err)
        ioSessionList.innerHTML = '<div class="history-empty">Failed to load sessions.</div>'
    }
}

// ---- Session play/stop (one playback active at a time, server-side) --------
let ioPlayingSessionId = null

function updateIOSessionPlayButtons() {
    ioSessionList.querySelectorAll('.io-item').forEach(row => {
        const btn = row.querySelector('.io-session-play')
        if (!btn) return
        const playing = ioPlayingSessionId != null && String(ioPlayingSessionId) === row.dataset.id
        btn.innerHTML = playing ? '&#x23F9;' : '&#x25B6;'
        btn.title = playing ? 'Stop' : 'Play'
        btn.classList.toggle('playing', playing)
    })
}

onPlaybackStatus((status) => {
    if (status === 'ended') {
        ioPlayingSessionId = null
        updateIOSessionPlayButtons()
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
        if (ioPlayingSessionId === id) {
            await fetch('/api/playback/stop', { method: 'POST' })
            ioPlayingSessionId = null
            updateIOSessionPlayButtons()
        } else {
            try {
                await fetch('/api/playback/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start, end, output: outputSelect.value || undefined }),
                })
                ioPlayingSessionId = id
                updateIOSessionPlayButtons()
            } catch (err) {
                console.error('Playback failed:', err)
            }
        }
    } else if (e.target.closest('.io-piano')) {
        openIOPianoRoll(await fetchEventsRange(start, end), { start, end, title, anchorKey: `session:${id}`, anchorEl: row })
    } else if (e.target.closest('.io-score')) {
        if (typeof openScoreView === 'function') openScoreView(await fetchEventsRange(start, end), { start, end, title })
    }
    // The export link is an <a download>; let it handle itself.
})
