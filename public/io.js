// ===========================================
// Import / Export tab
//
// Loaded after app.js and history.js; reuses their globals ($, escapeHtml,
// openPianoRollPopup, openScoreView). The MIDI-file import controls live in
// #viewIO; their handlers are in app.js (elements moved, ids unchanged).
// ===========================================

const ioSessionList = $('ioSessionList')

async function fetchEventsRange(start, end) {
    try {
        const res = await fetch(`/api/events/range?start=${start}&end=${end}`)
        return await res.json()
    } catch (err) {
        console.error('Failed to fetch events:', err)
        return []
    }
}

async function loadIOSessions() {
    try {
        const res = await fetch('/api/sessions')
        const sessions = await res.json()
        if (!sessions.length) {
            ioSessionList.innerHTML = '<div class="history-empty">No saved sessions yet. Save one from the Live or History tab.</div>'
            return
        }
        ioSessionList.innerHTML = sessions.map(s => `
            <div class="io-session" data-id="${s.id}" data-start="${s.start_time}" data-end="${s.end_time}">
                <div class="io-session-main">
                    <div class="title">${escapeHtml(s.song_name || 'Untitled')}</div>
                    <div class="meta">${escapeHtml(s.performer || 'Unknown')} &middot; ${new Date(s.start_time).toLocaleString()}</div>
                </div>
                <div class="io-session-actions">
                    <button class="btn-icon io-piano" title="Piano roll">&#x1F3B9;</button>
                    <button class="btn-icon io-score" title="Score">&#x1D11E;</button>
                    <a class="btn-icon io-export" title="Download as .mid" href="/api/sessions/${s.id}/export.mid" download>&#x2913;</a>
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
        const events = await fetchEventsRange(start, end)
        if (typeof openPianoRollPopup === 'function') openPianoRollPopup(events, { start, end, title })
    } else if (e.target.closest('.io-score')) {
        const events = await fetchEventsRange(start, end)
        if (typeof openScoreView === 'function') openScoreView(events, { start, end, title })
    }
    // The export link is an <a download>; let it handle itself.
})
