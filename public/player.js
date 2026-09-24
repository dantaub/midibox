// ===========================================
// Clip player
//
// The one thing that plays. The server owns the current clip (what's playing,
// paused or not, looping or not) and loops it itself; this mirrors that state
// from the WebSocket (app.js feeds it every `playback` / `playback-event`
// message) and sends the commands. Every transport - the bar under the header
// (io.js), the Live timeline and History - drives this same player, so Stop
// anywhere stops whatever is playing, wherever it started.
//
// Loaded before app.js: nothing here touches app.js globals until a command
// runs (outputSelect) or a message arrives.
//
//   player.state          { status: 'idle'|'playing'|'paused', clip, loop }
//   player.position()     clip-time position, gliding between server updates
//   player.on(fn)         fn(state, reason) on every status / clip / loop change
//   player.onTick(fn)     fn(position) every frame while playing (and once on change)
//   player.playRange({ start, end, title, key, source, from })
//   player.playFile({ data, name, title, key, source, from })
//   player.toggle() / stop() / setLoop(on) / seek(at) / isCurrent(key)
//
// A clip is { id, kind: 'range'|'file', title, key, source, start, end };
// `key` names the item in the page ("session:3", "import:7", ...), so a view
// can mark its row as the one playing whoever started it.
// ===========================================

const player = (() => {
    const state = { status: 'idle', clip: null, loop: false }
    const listeners = []
    const tickers = []

    // Last known position (clip time) and when we learnt it
    const clk = { pos: 0, at: 0 }

    function position() {
        if (!state.clip) return null
        let p = clk.pos
        if (state.status === 'playing') p += performance.now() - clk.at
        return Math.max(state.clip.start, Math.min(state.clip.end, p))
    }

    function setClock(pos) {
        clk.pos = pos
        clk.at = performance.now()
    }

    function emit(reason) {
        for (const fn of listeners) {
            try { fn(state, reason) } catch (err) { console.error('Player listener failed:', err) }
        }
        tickOnce()
        if (state.status === 'playing') startTicking()
    }

    // ---- Per-frame updates while playing -----------------------------------
    let raf = null
    function tickOnce() {
        const pos = position()
        for (const fn of tickers) {
            try { fn(pos) } catch (err) { console.error('Player tick failed:', err) }
        }
    }
    function startTicking() {
        if (raf != null) return
        const tick = () => {
            tickOnce()
            raf = state.status === 'playing' ? requestAnimationFrame(tick) : null
        }
        raf = requestAnimationFrame(tick)
    }

    // ---- From the server ----------------------------------------------------
    function handleStatus(data) {
        if (data.loop != null) state.loop = !!data.loop
        switch (data.status) {
            case 'state':  // sent on (re)connect
                state.status = data.state
                state.clip = data.clip
                setClock(data.position ?? data.clip?.start ?? 0)
                break
            case 'started':
                state.status = 'playing'
                state.clip = data.clip
                setClock(data.from ?? data.clip?.start ?? 0)
                break
            case 'paused':
                setClock(data.position ?? position() ?? 0)
                state.status = 'paused'
                break
            case 'resumed':
                state.status = 'playing'
                setClock(data.position ?? clk.pos)
                break
            case 'ended':
                state.status = 'idle'
                state.clip = null
                break
            case 'loop':
                break
            default:
                return
        }
        emit(data.status)
    }

    function handleEvent(data) {
        if (!state.clip || data.clipId !== state.clip.id || data.position == null) return
        setClock(data.position)
    }

    // ---- Commands -----------------------------------------------------------
    async function post(path, body) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        })
        if (!res.ok) {
            const info = await res.json().catch(() => ({}))
            throw new Error(info.error || `HTTP ${res.status}`)
        }
        return res.json().catch(() => ({}))
    }

    function currentOutput() {
        return (typeof outputSelect !== 'undefined' && outputSelect.value) || undefined
    }

    async function playRange({ start, end, title, key, source, from }) {
        try {
            await post('/api/playback/start', { start, end, title, key, source, from, output: currentOutput() })
        } catch (err) {
            console.error('Playback failed:', err)
            alert(`Playback failed: ${err.message}`)
        }
    }

    async function playFile({ data, name, title, key, source, from }) {
        const fd = new FormData()
        fd.append('file', new File([data], name || 'import.mid', { type: 'audio/midi' }))
        const output = currentOutput()
        if (output) fd.append('output', output)
        if (title) fd.append('title', title)
        if (key) fd.append('key', key)
        if (source) fd.append('source', source)
        if (from != null) fd.append('from', String(Math.round(from)))
        try {
            const res = await fetch('/api/playback/file', { method: 'POST', body: fd })
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
        } catch (err) {
            console.error('Playback failed:', err)
            alert(`Playback failed: ${err.message}`)
        }
    }

    async function toggle() {
        if (state.status === 'playing') await post('/api/playback/pause')
        else if (state.status === 'paused') await post('/api/playback/resume')
    }

    async function stop() {
        await post('/api/playback/stop').catch(err => console.error('Stop failed:', err))
    }

    async function setLoop(on) {
        // Show it at once; the server's broadcast confirms it everywhere else.
        state.loop = !!on
        emit('loop')
        await post('/api/playback/loop', { loop: !!on }).catch(err => console.error('Loop failed:', err))
    }

    async function seek(at) {
        if (state.status === 'idle') return
        await post('/api/playback/seek', { at: Math.round(at) }).catch(err => console.error('Seek failed:', err))
    }

    function isCurrent(key) {
        return !!key && state.clip?.key === key
    }

    return {
        state, position, handleStatus, handleEvent,
        on: fn => listeners.push(fn),
        onTick: fn => tickers.push(fn),
        playRange, playFile, toggle, stop, setLoop, seek, isCurrent,
    }
})()
