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
    let playhead = null   // ms position of the playback line, or null
    let dragging = false  // user is scrubbing the playhead handle

    // Shared with the drag handlers below, so both agree on where the line is.
    function timeToY(t) {
        const height = wrap.clientHeight
        const duration = Math.max(1, end - start)
        const ratio = (t - start) / duration
        return flipped ? height - ratio * height : ratio * height
    }

    function yToTime(y) {
        const height = wrap.clientHeight || 1
        const ratio = flipped ? 1 - y / height : y / height
        return start + Math.max(0, Math.min(1, ratio)) * (end - start)
    }

    const HANDLE_RADIUS = 7
    const HANDLE_HIT_RADIUS = 18  // generous, for touch

    function render() {
        const width = wrap.clientWidth
        const height = wrap.clientHeight
        if (!width || !height) return
        ctx.clearRect(0, 0, width, height)

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

        // Playback line + head, like the Live view
        if (playhead != null) {
            const y = timeToY(playhead)
            if (y >= 0 && y <= height) {
                ctx.save()
                ctx.strokeStyle = '#ef4444'
                ctx.lineWidth = 2
                ctx.beginPath()
                ctx.moveTo(0, y)
                ctx.lineTo(width, y)
                ctx.stroke()
                ctx.beginPath()
                ctx.moveTo(0, y - 6)
                ctx.lineTo(0, y + 6)
                ctx.lineTo(8, y)
                ctx.closePath()
                ctx.fillStyle = '#ef4444'
                ctx.fill()

                // Grabbable handle at the right end, for scrubbing (only
                // wired up when the caller gave us an onSeek callback).
                if (opts.onSeek) {
                    ctx.beginPath()
                    ctx.arc(width, y, HANDLE_RADIUS, 0, Math.PI * 2)
                    ctx.fillStyle = '#ef4444'
                    ctx.fill()
                    ctx.strokeStyle = '#fff'
                    ctx.lineWidth = 2
                    ctx.stroke()
                }
                ctx.restore()
            }
        }
    }

    // Playback overlay: a moving line + lit keys, driven by the caller. While
    // the user is dragging the handle, ignore external updates so the two
    // don't fight over where the line is.
    function setPlayhead(t) {
        if (dragging) return
        playhead = t
        render()
    }

    // ---- Dragging the playhead handle to scrub -----------------------------
    function pointerPos(e) {
        const rect = canvas.getBoundingClientRect()
        return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    function nearHandle(x, y) {
        if (playhead == null || !opts.onSeek) return false
        const width = wrap.clientWidth
        const hy = timeToY(playhead)
        // Anywhere along the line counts, not just the circular handle at
        // its right end - the whole red bar is draggable.
        if (x >= 0 && x <= width) return Math.abs(y - hy) <= HANDLE_HIT_RADIUS
        const dx = x - width
        const dy = y - hy
        return dx * dx + dy * dy <= HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS
    }

    canvas.addEventListener('pointerdown', (e) => {
        const { x, y } = pointerPos(e)
        if (!nearHandle(x, y)) return
        e.preventDefault()
        dragging = true
        canvas.setPointerCapture(e.pointerId)
        canvas.style.cursor = 'ns-resize'
    })

    // Where the page may scroll on touch (touch-action: pan-y), a drag that
    // starts on the playhead would be taken as a scroll and cancelled; claim
    // those touches so scrubbing still works. Touches elsewhere scroll as usual.
    canvas.addEventListener('touchstart', (e) => {
        const t = e.touches[0]
        if (e.touches.length !== 1 || !t) return
        const { x, y } = pointerPos(t)
        if (nearHandle(x, y)) e.preventDefault()
    }, { passive: false })

    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) {
            // Hover feedback so the handle reads as draggable before the
            // user commits to a pointerdown.
            const { x, y } = pointerPos(e)
            canvas.style.cursor = nearHandle(x, y) ? 'ns-resize' : ''
            return
        }
        e.preventDefault()
        const { y } = pointerPos(e)
        playhead = yToTime(y)
        render()
    })
    canvas.addEventListener('pointerleave', () => {
        if (!dragging) canvas.style.cursor = ''
    })

    function endDrag(e) {
        if (!dragging) return
        dragging = false
        canvas.style.cursor = ''
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
        opts.onSeek(playhead)
    }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)

    function highlight(note, on) {
        const key = keys[note]
        if (key) key.classList.toggle('playback', on)
    }

    function clearHighlights() {
        for (const note in keys) keys[note].classList.remove('playback')
        playhead = null
        render()
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

    return { render, resize, setData, setPlayhead, highlight, clearHighlights, canvas, piano, keys, element: wrap }
}
