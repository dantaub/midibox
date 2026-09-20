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

function openIOPianoRoll(events, { title, start, end } = {}) {
    ioPreviewTitle.textContent = title ? `Piano roll — ${title}` : 'Piano roll'
    ioPreviewBody.innerHTML = ''
    ioPreviewInstance = createPianoRoll(ioPreviewBody, { keyboard: true, flipped: false })
    ioPreview.classList.remove('hidden')

    const evs = events || []
    const s = start ?? (evs.length ? evs[0].timestamp : 0)
    const e = end ?? (evs.length ? evs[evs.length - 1].timestamp : s + 1000)
    ioPreview.scrollIntoView({ behavior: 'smooth', block: 'start' })
    requestAnimationFrame(() => ioPreviewInstance && ioPreviewInstance.setData(evs, s, e))
}

function closeIOPreview() {
    ioPreview.classList.add('hidden')
    ioPreviewBody.innerHTML = ''
    ioPreviewInstance = null
}

$('ioPreviewClose').addEventListener('click', closeIOPreview)
window.addEventListener('resize', () => { if (ioPreviewInstance) ioPreviewInstance.resize() })

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
        openIOPianoRoll(await parseMidiBlob(rec.data, rec.name), { title })
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
                    <button class="btn-icon io-piano" title="Piano roll">&#x1F3B9;</button>
                    <button class="btn-icon io-score" title="Score">&#x1D11E;</button>
                    <a class="btn-icon io-export" title="Download as .mid" href="/api/sessions/${s.id}/export.mid" download>&#x2913; .mid</a>
                </div>
            </div>
        `).join('')
    } catch (err) {
        console.error('Failed to load sessions:', err)
        ioSessionList.innerHTML = '<div class="history-empty">Failed to load sessions.</div>'
    }
}

ioSessionList.addEventListener('click', async (e) => {
    const row = e.target.closest('.io-session')
    if (!row) return
    const start = parseInt(row.dataset.start, 10)
    const end = parseInt(row.dataset.end, 10)
    const title = row.querySelector('.title')?.textContent || 'Session'

    if (e.target.closest('.io-piano')) {
        openIOPianoRoll(await fetchEventsRange(start, end), { start, end, title })
    } else if (e.target.closest('.io-score')) {
        if (typeof openScoreView === 'function') openScoreView(await fetchEventsRange(start, end), { start, end, title })
    }
    // The export link is an <a download>; let it handle itself.
})
