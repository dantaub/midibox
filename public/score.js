// ===========================================
// Score view: render captured/imported note events as staff notation.
//
// Loaded after vendor/vexflow.js and piano-roll.js (for pairNoteBars) but the
// only entry point, openScoreView(), is called on click and guarded by the IO
// tab / Score button, so definition order relative to io.js does not matter.
//
// This is the most heuristic piece in the app. MIDI is timestamped in real
// milliseconds with no reliable tempo, key, or time signature, so the notation
// is an approximation: timing is quantized to a fixed grid and 120 BPM is
// assumed. A toolbar in the modal lets the user pick which channel to show
// (multitrack files stack every instrument otherwise) and the time/key
// signature to notate against; the notation re-renders on any change.
// ===========================================

// --- Assumptions ------------------------------------------------------------
const SCORE_BPM = 120
const SCORE_QUARTER_MS = 60000 / SCORE_BPM   // one beat (quarter note) in ms
const SCORE_MAX_MEASURES = 64                // cap so a long session stays sane
const SCORE_SPLIT_NOTE = 60                  // middle C: >= treble, < bass
const SCORE_DRUM_CHANNEL = 9                 // GM percussion (MIDI channel 10)

// Note value -> { code, beats }, longest first (beats in quarter-note units).
// Chord durations snap to the nearest of these.
const SCORE_DURATIONS = [
    { code: 'w', beats: 4 },
    { code: 'h', beats: 2 },
    { code: 'q', beats: 1 },
    { code: '8', beats: 0.5 },
    { code: '16', beats: 0.25 },
]

// Pitch spelling. Sharp keys use sharps, flat keys use flats; applyAccidentals
// then decides which accidentals actually need drawing given the key signature.
const SCORE_SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
const SCORE_FLAT_NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b']
const SCORE_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db']
const SCORE_FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'])
const SCORE_TIME_SIGS = ['4/4', '3/4', '2/4', '2/2', '6/8', '3/8', '12/8']

// MIDI note -> VexFlow key like "c#/4" (MIDI 60 = C4).
function scoreNoteToKey(note, useFlats) {
    const names = useFlats ? SCORE_FLAT_NAMES : SCORE_SHARP_NAMES
    return `${names[note % 12]}/${Math.floor(note / 12) - 1}`
}

// "4/4" -> { top, bottom, beats } where beats is the measure length in quarters.
function scoreParseTimeSig(sig) {
    const [top, bottom] = sig.split('/').map(Number)
    return { top, bottom, beats: (top * 4) / bottom }
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

// Distinct channels that carry notes, sorted, for the channel picker.
function scoreChannelsPresent(events) {
    const set = new Set()
    for (const e of events) {
        if (e.type === 'noteon' || e.type === 'noteoff') set.add(e.channel ?? 0)
    }
    return [...set].sort((a, b) => a - b)
}

// Filter events to the selected channel(s). 'no-drums' = everything but GM
// percussion; 'all' = everything; a number = that one channel.
function scoreFilterByChannel(events, chOpt) {
    if (chOpt === 'all') return events
    if (chOpt === 'no-drums') return events.filter(e => e.channel !== SCORE_DRUM_CHANNEL)
    const ch = Number(chOpt)
    return events.filter(e => (e.channel ?? 0) === ch)
}

// Group bars into chords by shared onset, then give each chord a duration from
// the gap to the next chord's onset (the last chord uses its own note length).
function scoreBarsToChords(bars) {
    if (!bars.length) return []
    const sorted = [...bars].sort((a, b) => a.start - b.start)
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
        // start / until = the real-time window this chord occupies, used to
        // light up only the chord currently sounding (a pitch can repeat across
        // measures, so matching by pitch alone would light them all).
        return {
            notes: [...new Set(c.notes)].sort((a, b) => a - b),
            dur: scoreQuantizeDuration(spanMs),
            start: c.start,
            until: next ? next.start : c.end,
        }
    })
}

// Pack chords into measures of the given length (quarter beats). A chord that
// would overflow starts a new measure (durations are not split across bar lines
// - a v1 simplification, which is why voices render non-strict below).
function scoreChordsToMeasures(chords, measureBeats) {
    const measures = []
    let cur = null
    let beats = 0
    for (const chord of chords) {
        if (!cur || beats + chord.dur.beats > measureBeats) {
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
// has no notes on that side of the split. Accidentals are added later by
// Accidental.applyAccidentals(), which respects the key signature.
function scoreBuildNote(VF, clef, midiNotes, durCode, useFlats) {
    if (!midiNotes.length) {
        return new VF.StaveNote({ clef, keys: [clef === 'treble' ? 'b/4' : 'd/3'], duration: durCode + 'r' })
    }
    const keys = midiNotes.map(n => scoreNoteToKey(n, useFlats))
    return new VF.StaveNote({ clef, keys, duration: durCode })
}

// --- Modal shell (built once, reused) ---------------------------------------
let scoreModal = null
let scoreContainer = null
let scoreTitleEl = null
let scoreChannelSel = null
let scoreTimeSel = null
let scoreKeySel = null

// Current view state, so the toolbar can re-render without re-fetching.
let scoreEvents = []
let scoreOpts = { channel: 'no-drums', timeSig: '4/4', key: 'C' }

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
                <div class="score-toolbar">
                    <label>Channel <select id="scoreChannel"></select></label>
                    <label>Time <select id="scoreTimeSig"></select></label>
                    <label>Key <select id="scoreKey"></select></label>
                </div>
                <div id="scoreContainer" class="score-container"></div>
                <p class="score-note">Notation is approximate: timing is quantized and 120&nbsp;BPM is assumed. Use the controls above to pick a channel, time signature and key.</p>
            </div>
        </div>`
    document.body.appendChild(scoreModal)
    scoreContainer = scoreModal.querySelector('#scoreContainer')
    scoreTitleEl = scoreModal.querySelector('#scoreModalTitle')
    scoreChannelSel = scoreModal.querySelector('#scoreChannel')
    scoreTimeSel = scoreModal.querySelector('#scoreTimeSig')
    scoreKeySel = scoreModal.querySelector('#scoreKey')

    scoreTimeSel.innerHTML = SCORE_TIME_SIGS.map(s => `<option value="${s}">${s}</option>`).join('')
    scoreKeySel.innerHTML = SCORE_KEYS.map(k => `<option value="${k}">${k} major</option>`).join('')

    scoreChannelSel.addEventListener('change', () => { scoreOpts.channel = scoreChannelSel.value; renderScore() })
    scoreTimeSel.addEventListener('change', () => { scoreOpts.timeSig = scoreTimeSel.value; renderScore() })
    scoreKeySel.addEventListener('change', () => { scoreOpts.key = scoreKeySel.value; renderScore() })

    scoreModal.querySelector('#scoreModalClose').addEventListener('click', closeScoreView)
    scoreModal.addEventListener('click', (e) => { if (e.target === scoreModal) closeScoreView() })
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !scoreModal.classList.contains('hidden')) closeScoreView()
    })
}

// Rebuild the channel dropdown from the channels actually present in the file.
function scorePopulateChannels(events) {
    const chans = scoreChannelsPresent(events)
    const hasDrums = chans.includes(SCORE_DRUM_CHANNEL)
    const opts = [`<option value="no-drums">All${hasDrums ? ' (no drums)' : ''}</option>`]
    if (hasDrums) opts.push(`<option value="all">All (with drums)</option>`)
    for (const c of chans) {
        opts.push(`<option value="${c}">Ch ${c + 1}${c === SCORE_DRUM_CHANNEL ? ' (drums)' : ''}</option>`)
    }
    scoreChannelSel.innerHTML = opts.join('')
    // Single-channel files don't need the picker.
    scoreChannelSel.parentElement.style.display = chans.length > 1 ? '' : 'none'
    scoreOpts.channel = 'no-drums'
    scoreChannelSel.value = 'no-drums'
}

function closeScoreView() {
    if (scoreModal) scoreModal.classList.add('hidden')
}

// Public entry point (referenced by io.js and the imported-file Score button).
function openScoreView(events, { title } = {}) {
    ensureScoreModal()
    scoreEvents = events || []
    scoreOpts = { channel: 'no-drums', timeSig: '4/4', key: 'C' }
    scoreTitleEl.textContent = title ? `Score — ${title}` : 'Score'
    scorePopulateChannels(scoreEvents)
    scoreTimeSel.value = '4/4'
    scoreKeySel.value = 'C'
    scoreModal.classList.remove('hidden')
    // Render after the modal is visible so the container has a real width.
    requestAnimationFrame(() => renderScore())
}

// --- Playback highlight -----------------------------------------------------
// Each drawn chord is tagged with its SVG note group(s) and its real-time
// window [start, until). The chord whose window contains the current playback
// position lights up - matching by time, not pitch, so a pitch that repeats in
// later measures doesn't light them all at once.
let scoreChordEls = []   // [{ els:SVGGElement[], start:number, until:number }]
let scoreRangeStart = 0  // first/last event timestamp of what's rendered, so
let scoreRangeEnd = 1    // the playback progress (0..1) maps back to a time
let scoreLit = []        // currently-lit elements, cleared on each update

function scoreHighlightAt(ms) {
    for (const el of scoreLit) el.classList.remove('score-playing')
    scoreLit = []
    for (const chord of scoreChordEls) {
        if (ms >= chord.start && ms < chord.until) {
            for (const el of chord.els) { el.classList.add('score-playing'); scoreLit.push(el) }
        }
    }
}

// Passive follow-along: whenever the score modal is open and something is
// playing (started from any Play button), light the chord at the current
// position. Opening the score does not itself start playback. Assumes the
// thing playing is what's shown - progress maps onto the rendered time range.
onPlaybackEvent((data) => {
    if (!scoreModal || scoreModal.classList.contains('hidden')) return
    if (typeof data.progress !== 'number') return
    scoreHighlightAt(scoreRangeStart + data.progress * (scoreRangeEnd - scoreRangeStart))
})

onPlaybackStatus((status) => {
    if (status === 'ended') scoreHighlightAt(-1)
})

function renderScore() {
    scoreContainer.innerHTML = ''
    scoreChordEls = []
    scoreLit = []
    const VF = window.Vex && window.Vex.Flow
    if (!VF) {
        scoreContainer.innerHTML = '<div class="history-empty">Score library failed to load.</div>'
        return
    }

    const events = scoreFilterByChannel(scoreEvents, scoreOpts.channel)
    scoreRangeStart = events.length ? events[0].timestamp : 0
    scoreRangeEnd = events.length ? events[events.length - 1].timestamp : 1

    const endTime = events.length ? events[events.length - 1].timestamp : 0
    const bars = pairNoteBars(events, endTime)
    if (!bars.length) {
        scoreContainer.innerHTML = '<div class="history-empty">No notes to display for this channel.</div>'
        return
    }

    const time = scoreParseTimeSig(scoreOpts.timeSig)
    const key = scoreOpts.key
    const useFlats = SCORE_FLAT_KEYS.has(key)
    const chords = scoreBarsToChords(bars)
    const measures = scoreChordsToMeasures(chords, time.beats)
    const capped = measures.length >= SCORE_MAX_MEASURES

    // Layout geometry: fit as many measures per row as the container allows.
    const MEASURE_W = 260
    const FIRST_EXTRA = 60           // first measure of a row carries clef/brace/keysig
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
            if (key !== 'C') { treble.addKeySignature(key); bass.addKeySignature(key) }
            if (mi === 0) { treble.addTimeSignature(scoreOpts.timeSig); bass.addTimeSignature(scoreOpts.timeSig) }
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
            trebleNotes.push(scoreBuildNote(VF, 'treble', chord.notes.filter(n => n >= SCORE_SPLIT_NOTE), chord.dur.code, useFlats))
            bassNotes.push(scoreBuildNote(VF, 'bass', chord.notes.filter(n => n < SCORE_SPLIT_NOTE), chord.dur.code, useFlats))
        }

        // Non-strict: partial measures and un-split durations are fine for v1.
        const tVoice = new VF.Voice({ num_beats: time.top, beat_value: time.bottom }).setStrict(false).addTickables(trebleNotes)
        const bVoice = new VF.Voice({ num_beats: time.top, beat_value: time.bottom }).setStrict(false).addTickables(bassNotes)
        // Draw accidentals per the key signature (adds naturals, hides in-key ones).
        VF.Accidental.applyAccidentals([tVoice], key)
        VF.Accidental.applyAccidentals([bVoice], key)
        new VF.Formatter().joinVoices([tVoice]).joinVoices([bVoice]).format([tVoice, bVoice], w - 30)
        tVoice.draw(ctx, treble)
        bVoice.draw(ctx, bass)

        // Tag each drawn chord (now its StaveNotes have SVG groups) with its
        // note groups and real-time window, for the playback highlight. Skip
        // the rest side (no notes) so only sounding staves light.
        measure.forEach((chord, ci) => {
            const els = []
            if (chord.notes.some(n => n >= SCORE_SPLIT_NOTE)) { const el = trebleNotes[ci].getSVGElement(); if (el) els.push(el) }
            if (chord.notes.some(n => n < SCORE_SPLIT_NOTE)) { const el = bassNotes[ci].getSVGElement(); if (el) els.push(el) }
            if (els.length) scoreChordEls.push({ els, start: chord.start, until: chord.until })
        })
    })

    if (capped) {
        const msg = document.createElement('p')
        msg.className = 'score-note'
        msg.textContent = `Showing the first ${SCORE_MAX_MEASURES} measures.`
        scoreContainer.appendChild(msg)
    }
}
