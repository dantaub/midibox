// ===========================================
// Piano-roll component: shared geometry + rendering for every note view.
//
// Loaded before app.js (classic script, global scope). The Live timeline
// (app.js) and the History preview (history.js) call the low-level helpers
// below; the popup uses createPianoRoll() to get a self-contained instance.
// Uses isNoteOn/isNoteOff (defined in app.js) at call time only.
// ===========================================

const PITCH_MIN = 21   // A0
const PITCH_MAX = 108  // C8
const WHITE_KEY_COUNT = 52

// Pitch axis geometry: 52 white-key columns with black keys straddling them,
// at the same fractions the CSS keyboard uses, so canvas and keys line up.
const noteLayout = (() => {
    const layout = {}
    let whiteIndex = 0
    for (let note = PITCH_MIN; note <= PITCH_MAX; note++) {
        const isBlack = [1, 3, 6, 8, 10].includes(note % 12)
        if (isBlack) {
            layout[note] = { offset: whiteIndex - 0.34, width: 0.68, isBlack }
        } else {
            layout[note] = { offset: whiteIndex, width: 1, isBlack }
            whiteIndex++
        }
    }
    return layout
})()

// Pixel span of a note on the (horizontal) pitch axis.
function noteToX(note, width) {
    const unit = width / WHITE_KEY_COUNT
    const spot = noteLayout[note]
    if (!spot) return { x: 0, w: unit }
    return { x: spot.offset * unit, w: Math.max(2, spot.width * unit) }
}

// Build the 88 key <div>s into a piano element (no interaction wired here).
// Returns a { note: element } map.
function buildPianoKeys(pianoEl) {
    const keys = {}
    const keyUnit = 100 / WHITE_KEY_COUNT
    let whiteIndex = 0
    for (let note = PITCH_MIN; note <= PITCH_MAX; note++) {
        const isBlack = [1, 3, 6, 8, 10].includes(note % 12)
        const key = document.createElement('div')
        key.dataset.note = note
        if (isBlack) {
            key.className = 'black-key'
            key.style.left = `${(whiteIndex - 0.34) * keyUnit}%`
            key.style.width = `${0.68 * keyUnit}%`
        } else {
            key.className = 'white-key'
            whiteIndex++
        }
        keys[note] = key
        pianoEl.appendChild(key)
    }
    return keys
}

// Pair note-on/off events into drawable bars. Notes still held at endTime run to
// endTime. Order-preserving; unmatched offs are ignored.
function pairNoteBars(events, endTime) {
    const active = new Map()
    const bars = []
    for (const event of events) {
        if (isNoteOn(event)) {
            active.set(event.note, { start: event.timestamp, velocity: event.velocity })
        } else if (isNoteOff(event)) {
            const open = active.get(event.note)
            if (open) {
                bars.push({ note: event.note, start: open.start, end: event.timestamp, velocity: open.velocity })
                active.delete(event.note)
            }
        }
    }
    for (const [note, open] of active) {
        bars.push({ note, start: open.start, end: endTime, velocity: open.velocity })
    }
    return bars
}

// Render-only chord alignment: translate each bar (in place) so a chord's onsets
// share a start time. Chain notes while consecutive onsets are within gapMs (a
// chord arrives at a steady serial rate) and the cluster stays under maxSpanMs.
// Preserves each bar's duration.
function alignChordBars(bars, gapMs, maxSpanMs) {
    let anchor = null
    let prevOrig = null
    for (const bar of [...bars].sort((a, b) => a.start - b.start)) {
        const orig = bar.start
        if (anchor === null || orig - prevOrig > gapMs || orig - anchor > maxSpanMs) anchor = orig
        bar.end -= orig - anchor
        bar.start = anchor
        prevOrig = orig
    }
}

// Draw bars on a vertical time axis (pitch across x via noteToX, time down y via
// the supplied map). White keys first so the narrower black-key bars stay on top.
function drawNoteBarsVertical(ctx, bars, width, timeToY) {
    for (const pass of [false, true]) {
        for (const bar of bars) {
            const isBlack = [1, 3, 6, 8, 10].includes(bar.note % 12)
            if (isBlack !== pass) continue
            const spot = noteToX(bar.note, width)
            const yA = timeToY(bar.start)
            const yB = timeToY(bar.end)
            const brightness = 50 + (bar.velocity / 127) * 50
            ctx.fillStyle = isBlack ? `hsl(340, 80%, ${brightness}%)` : `hsl(160, 70%, ${brightness}%)`
            ctx.fillRect(spot.x, Math.min(yA, yB), spot.w - 1, Math.max(2, Math.abs(yB - yA)))
        }
    }
}

// A self-contained, read-only piano roll: an optional keyboard plus a vertical
// timeline canvas, rendering a fixed set of events over a time range. Used by
// the popup; the Live view keeps its own DOM but shares the helpers above.
//
//   const pr = createPianoRoll(containerEl, { keyboard: true, flipped: false })
//   pr.setData(events, startMs, endMs)   // renders
//   pr.resize()                          // after the container is visible/resized
function createPianoRoll(container, opts = {}) {
    const flipped = !!opts.flipped
    const showKeyboard = opts.keyboard !== false

    let piano = null
    let keys = {}
    if (showKeyboard) {
        const pianoContainer = document.createElement('div')
        pianoContainer.className = 'piano-container'
        piano = document.createElement('div')
        piano.className = 'piano'
        pianoContainer.appendChild(piano)
        container.appendChild(pianoContainer)
        keys = buildPianoKeys(piano)
    }

    const wrap = document.createElement('div')
    wrap.className = 'timeline-container'
    const canvas = document.createElement('canvas')
    canvas.className = 'timeline-canvas'
    wrap.appendChild(canvas)
    container.appendChild(wrap)
    const ctx = canvas.getContext('2d')

    let events = []
    let start = 0
    let end = 1

    function render() {
        const width = wrap.clientWidth
        const height = wrap.clientHeight
        if (!width || !height) return
        ctx.clearRect(0, 0, width, height)

        const duration = Math.max(1, end - start)
        const timeToY = (t) => {
            const ratio = (t - start) / duration
            return flipped ? height - ratio * height : ratio * height
        }

        // Octave grid
        ctx.strokeStyle = '#1a1a2e'
        ctx.lineWidth = 1
        for (let note = PITCH_MIN; note <= PITCH_MAX; note++) {
            if (note % 12 !== 0) continue
            const { x } = noteToX(note, width)
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, height)
            ctx.stroke()
        }

        const bars = pairNoteBars(events, end)
        if (opts.align) alignChordBars(bars, opts.alignGapMs ?? 12, opts.alignMaxSpanMs ?? 60)
        drawNoteBarsVertical(ctx, bars, width, timeToY)
    }

    function resize() {
        const rect = wrap.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const dpr = window.devicePixelRatio || 1
        canvas.width = rect.width * dpr
        canvas.height = rect.height * dpr
        canvas.style.width = rect.width + 'px'
        canvas.style.height = rect.height + 'px'
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.scale(dpr, dpr)
        render()
    }

    function setData(evts, startMs, endMs) {
        events = evts || []
        start = startMs
        end = endMs
        resize()
    }

    return { render, resize, setData, canvas, piano, keys, element: wrap }
}
