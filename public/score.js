// ===========================================
// Score view: render captured/imported note events as staff notation.
//
// Loaded after vendor/vexflow.js and piano-roll.js (for pairNoteBars) but the
// only entry point, openScoreView(), is called on click and guarded by the IO
// tab / Score button, so definition order relative to io.js does not matter.
//
// This is the most heuristic piece in the app. MIDI is timestamped in real
// milliseconds with no tempo, key, or time signature, so the notation is an
// approximation: timing is quantized to a fixed grid, 4/4 and 120 BPM are
// assumed, and pitches spell with sharps only (no key signature). It is meant
// to be readable at a glance, not an accurate transcription.
// ===========================================

// --- Assumptions (documented in the modal footer too) -----------------------
const SCORE_BPM = 120
const SCORE_QUARTER_MS = 60000 / SCORE_BPM   // one beat in ms
const SCORE_BEATS_PER_MEASURE = 4            // 4/4
const SCORE_MAX_MEASURES = 64                // cap so a long session stays sane
const SCORE_SPLIT_NOTE = 60                  // middle C: >= treble, < bass

// Note value -> { code, beats }, longest first. Chord durations snap to the
// nearest of these; nothing shorter than a sixteenth or longer than a whole.
const SCORE_DURATIONS = [
    { code: 'w', beats: 4 },
    { code: 'h', beats: 2 },
    { code: 'q', beats: 1 },
    { code: '8', beats: 0.5 },
    { code: '16', beats: 0.25 },
]

const SCORE_PITCH_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']

// MIDI note -> VexFlow key like "c#/4" (MIDI 60 = C4).
function scoreNoteToKey(note) {
    return `${SCORE_PITCH_NAMES[note % 12]}/${Math.floor(note / 12) - 1}`
}

// Snap a raw duration (ms) to the nearest allowed note value.
function scoreQuantizeDuration(ms) {
    const beats = ms / SCORE_QUARTER_MS
    let best = SCORE_DURATIONS[SCORE_DURATIONS.length - 1]
    let bestErr = Infinity
    for (const d of SCORE_DURATIONS) {
        const err = Math.abs(Math.log(beats / d.beats))  // ratio error, so 8th vs quarter is symmetric
        if (err < bestErr) { bestErr = err; best = d }
    }
    return best
}

// Group bars into chords by shared onset, then give each chord a duration from
// the gap to the next chord's onset (the last chord uses its own note length).
// Returns [{ notes:[midi...], dur:{code,beats} }, ...] in time order.
function scoreBarsToChords(bars) {
    if (!bars.length) return []
    const sorted = [...bars].sort((a, b) => a.start - b.start)
    // Cluster onsets that land within a small window into one chord.
    const CHORD_WINDOW_MS = 60
    const chords = []
    let cur = null
    for (const bar of sorted) {
        if (!cur || bar.start - cur.start > CHORD_WINDOW_MS) {
            cur = { start: bar.start, end: bar.end, notes: [bar.note] }
            chords.push(cur)
        } else {
            cur.notes.push(bar.note)
            cur.end = Math.max(cur.end, bar.end)
        }
    }
    return chords.map((c, i) => {
        const next = chords[i + 1]
        const spanMs = next ? next.start - c.start : c.end - c.start
        return { notes: [...new Set(c.notes)].sort((a, b) => a - b), dur: scoreQuantizeDuration(spanMs) }
    })
}

// Pack chords into 4/4 measures. A chord that would overflow the current
// measure starts a new one (durations are not split across bar lines - a v1
// simplification, which is why voices render non-strict below).
function scoreChordsToMeasures(chords) {
    const measures = []
    let cur = null
    let beats = 0
    for (const chord of chords) {
        if (!cur || beats + chord.dur.beats > SCORE_BEATS_PER_MEASURE) {
            cur = []
            measures.push(cur)
            beats = 0
        }
        cur.push(chord)
        beats += chord.dur.beats
        if (measures.length > SCORE_MAX_MEASURES) break
    }
    return measures.slice(0, SCORE_MAX_MEASURES)
}

// Build one VexFlow StaveNote for a clef from a chord, or a rest if the chord
// has no notes on that side of the split. Adds sharp accidentals as needed.
function scoreBuildNote(VF, clef, midiNotes, durCode) {
    if (!midiNotes.length) {
        return new VF.StaveNote({ clef, keys: [clef === 'treble' ? 'b/4' : 'd/3'], duration: durCode + 'r' })
    }
    const keys = midiNotes.map(scoreNoteToKey)
    const note = new VF.StaveNote({ clef, keys, duration: durCode })
    midiNotes.forEach((m, i) => {
        if (SCORE_PITCH_NAMES[m % 12].includes('#')) note.addModifier(new VF.Accidental('#'), i)
    })
    return note
}

// --- Modal shell (built once, reused) ---------------------------------------
let scoreModal = null
let scoreContainer = null
let scoreTitleEl = null

function ensureScoreModal() {
    if (scoreModal) return
    scoreModal = document.createElement('div')
    scoreModal.className = 'modal-overlay hidden'
    scoreModal.innerHTML = `
        <div class="modal score-modal">
            <div class="modal-header">
                <span class="modal-title" id="scoreModalTitle">Score</span>
                <button class="modal-close" id="scoreModalClose" title="Close">&#x2715;</button>
            </div>
            <div class="modal-body score-modal-body">
                <div id="scoreContainer" class="score-container"></div>
                <p class="score-note">Notation is approximate: timing quantized, 4/4 and 120&nbsp;BPM assumed, pitches spelled with sharps (no key signature).</p>
            </div>
        </div>`
    document.body.appendChild(scoreModal)
    scoreContainer = scoreModal.querySelector('#scoreContainer')
    scoreTitleEl = scoreModal.querySelector('#scoreModalTitle')
    scoreModal.querySelector('#scoreModalClose').addEventListener('click', closeScoreView)
    scoreModal.addEventListener('click', (e) => { if (e.target === scoreModal) closeScoreView() })
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !scoreModal.classList.contains('hidden')) closeScoreView()
    })
}

function closeScoreView() {
    if (scoreModal) scoreModal.classList.add('hidden')
}

// Public entry point (referenced by io.js and the imported-file Score button).
function openScoreView(events, { title } = {}) {
    ensureScoreModal()
    scoreTitleEl.textContent = title ? `Score — ${title}` : 'Score'
    scoreModal.classList.remove('hidden')
    // Render after the modal is visible so the container has a real width.
    requestAnimationFrame(() => renderScore(events || []))
}

function renderScore(events) {
    scoreContainer.innerHTML = ''
    const VF = window.Vex && window.Vex.Flow
    if (!VF) {
        scoreContainer.innerHTML = '<div class="history-empty">Score library failed to load.</div>'
        return
    }

    const endTime = events.length ? events[events.length - 1].timestamp : 0
    const bars = pairNoteBars(events, endTime)
    if (!bars.length) {
        scoreContainer.innerHTML = '<div class="history-empty">No notes to display.</div>'
        return
    }

    const chords = scoreBarsToChords(bars)
    const measures = scoreChordsToMeasures(chords)
    const capped = measures.length >= SCORE_MAX_MEASURES

    // Layout geometry: fit as many measures per row as the container allows.
    const MEASURE_W = 260
    const FIRST_EXTRA = 40           // first measure of a row carries the clef/brace
    const ROW_H = 220
    const PAD_X = 10
    const PAD_TOP = 10
    const width = Math.max(360, scoreContainer.clientWidth - PAD_X * 2)
    const perRow = Math.max(1, Math.floor((width - FIRST_EXTRA) / MEASURE_W))
    const rows = Math.ceil(measures.length / perRow)

    const renderer = new VF.Renderer(scoreContainer, VF.Renderer.Backends.SVG)
    renderer.resize(width + PAD_X * 2, rows * ROW_H + PAD_TOP + 20)
    const ctx = renderer.getContext()

    measures.forEach((measure, mi) => {
        const rowIdx = Math.floor(mi / perRow)
        const colIdx = mi % perRow
        const isFirstInRow = colIdx === 0
        const x = PAD_X + colIdx * MEASURE_W + (isFirstInRow ? 0 : FIRST_EXTRA)
        const y = PAD_TOP + rowIdx * ROW_H
        const w = MEASURE_W + (isFirstInRow ? FIRST_EXTRA : 0)

        const treble = new VF.Stave(x, y, w)
        const bass = new VF.Stave(x, y + 90, w)
        if (isFirstInRow) {
            treble.addClef('treble')
            bass.addClef('bass')
            if (mi === 0) { treble.addTimeSignature('4/4'); bass.addTimeSignature('4/4') }
        }
        treble.setContext(ctx).draw()
        bass.setContext(ctx).draw()
        if (isFirstInRow) {
            new VF.StaveConnector(treble, bass).setType('brace').setContext(ctx).draw()
            new VF.StaveConnector(treble, bass).setType('singleLeft').setContext(ctx).draw()
        }

        const trebleNotes = []
        const bassNotes = []
        for (const chord of measure) {
            trebleNotes.push(scoreBuildNote(VF, 'treble', chord.notes.filter(n => n >= SCORE_SPLIT_NOTE), chord.dur.code))
            bassNotes.push(scoreBuildNote(VF, 'bass', chord.notes.filter(n => n < SCORE_SPLIT_NOTE), chord.dur.code))
        }

        // Non-strict: partial measures and un-split durations are fine for v1.
        const tVoice = new VF.Voice({ num_beats: SCORE_BEATS_PER_MEASURE, beat_value: 4 }).setStrict(false).addTickables(trebleNotes)
        const bVoice = new VF.Voice({ num_beats: SCORE_BEATS_PER_MEASURE, beat_value: 4 }).setStrict(false).addTickables(bassNotes)
        new VF.Formatter().joinVoices([tVoice]).joinVoices([bVoice]).format([tVoice, bVoice], w - 30)
        tVoice.draw(ctx, treble)
        bVoice.draw(ctx, bass)
    })

    if (capped) {
        const msg = document.createElement('p')
        msg.className = 'score-note'
        msg.textContent = `Showing the first ${SCORE_MAX_MEASURES} measures.`
        scoreContainer.appendChild(msg)
    }
}
