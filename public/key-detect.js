// ===========================================
// Key detection: guesses the musical key from the notes played, live and in
// playback. Krumhansl-Schmuckler: a duration-weighted pitch-class profile of
// the recent notes, correlated against the major and minor key profiles in
// all 12 rotations; the best of the 24 wins. Modes other than major/minor
// share a major key's notes, so they're never guessed.
//
// Loaded after app.js (feeds on its live/playback hooks). Fires
// 'midibox:keydetect' on window after each update; with musicalKey.auto on,
// the guess also becomes the key (setMusicalKey, piano-roll.js).
// ===========================================

const KEY_DETECT_WINDOW_MS = 30000   // notes sounding in the last 30 s count
const KEY_DETECT_MIN_NOTES = 8       // no guess from fewer notes than this
const KEY_DETECT_NOTE_MIN_MS = 100   // a staccato note still counts this much
const KEY_DETECT_NOTE_MAX_MS = 2000  // a long note counts at most this much
// A rival key must out-score the current guess by this much (correlation,
// -1..1) to replace it, so the guess doesn't flicker between close keys.
const KEY_DETECT_HOLD = 0.05

// Krumhansl-Kessler probe-tone ratings, tonic first.
const KEY_PROFILES = {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
}
const KEY_SHORT_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

function keyLabel(k) {
    return `${KEY_SHORT_NAMES[k.tonic]} ${k.mode}`
}

// Chord-symbol style, for tight spots: G, Am
function keySymbol(k) {
    return KEY_SHORT_NAMES[k.tonic] + (k.mode === 'minor' ? 'm' : '')
}

function pearson(a, b) {
    const n = a.length
    const ma = a.reduce((s, x) => s + x, 0) / n
    const mb = b.reduce((s, x) => s + x, 0) / n
    let num = 0, da = 0, db = 0
    for (let i = 0; i < n; i++) {
        num += (a[i] - ma) * (b[i] - mb)
        da += (a[i] - ma) ** 2
        db += (b[i] - mb) ** 2
    }
    return da && db ? num / Math.sqrt(da * db) : 0
}

// All 24 keys scored against 12 pitch-class weights (index 0 = C), best first.
function rankKeys(weights) {
    const ranked = []
    for (const mode of Object.keys(KEY_PROFILES)) {
        for (let tonic = 0; tonic < 12; tonic++) {
            const fromTonic = weights.map((_, i) => weights[(i + tonic) % 12])
            ranked.push({ tonic, mode, score: pearson(fromTonic, KEY_PROFILES[mode]) })
        }
    }
    return ranked.sort((a, b) => b.score - a.score)
}

const keyDetect = {
    notes: [],        // { note, start, end } - end null while held; local ms
    candidates: [],   // every key, ranked, from the last update ([] = no guess)
    best: null,       // the guess held against close rivals, or null
}

function updateKeyDetection(now) {
    const from = now - KEY_DETECT_WINDOW_MS
    keyDetect.notes = keyDetect.notes.filter(n => (n.end ?? n.start) >= from)

    const weights = new Array(12).fill(0)
    for (const n of keyDetect.notes) {
        const ms = (n.end ?? now) - Math.max(n.start, from)
        weights[n.note % 12] += Math.min(KEY_DETECT_NOTE_MAX_MS, Math.max(KEY_DETECT_NOTE_MIN_MS, ms))
    }

    if (keyDetect.notes.length < KEY_DETECT_MIN_NOTES) {
        keyDetect.candidates = []
        keyDetect.best = null
    } else {
        keyDetect.candidates = rankKeys(weights)
        const top = keyDetect.candidates[0]
        const held = keyDetect.best && keyDetect.candidates.find(k => k.tonic === keyDetect.best.tonic && k.mode === keyDetect.best.mode)
        keyDetect.best = held && top.score < held.score + KEY_DETECT_HOLD ? held : top
    }

    applyDetectedKey()
    window.dispatchEvent(new Event('midibox:keydetect'))
}

// Forget every note so far, held ones included: the guess starts over from
// what's played next.
function resetKeyDetection() {
    keyDetect.notes = []
    keyDetect.candidates = []
    keyDetect.best = null
    window.dispatchEvent(new Event('midibox:keydetect'))
}

// With Auto on, make the current guess the key (no guess: keep the key).
function applyDetectedKey() {
    const best = keyDetect.best
    if (!musicalKey.auto || !best) return
    if (best.tonic !== musicalKey.tonic || best.mode !== musicalKey.mode) setMusicalKey({ tonic: best.tonic, mode: best.mode })
}

// Feed one MIDI event. now: local ms (events' own timestamps are server or
// file time, which playback doesn't keep in step with).
function keyDetectEvent(event, now = Date.now()) {
    if (isNoteOn(event)) {
        keyDetect.notes.push({ note: event.note, start: now, end: null })
    } else if (isNoteOff(event)) {
        const open = keyDetect.notes.findLast(n => n.note === event.note && n.end == null)
        if (!open) return
        open.end = now
    } else {
        return
    }
    updateKeyDetection(now)
}

onLiveEvent(event => keyDetectEvent(event))
onPlaybackEvent(data => keyDetectEvent(data.event))
