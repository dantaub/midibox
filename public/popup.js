// ===========================================
// Piano-roll popup: a modal that views a session or imported file using the
// same createPianoRoll component as the Live view. Loaded after piano-roll.js.
// ===========================================

const pianoRollModal = $('pianoRollModal')
const pianoRollModalBody = $('pianoRollModalBody')
const pianoRollModalTitle = $('pianoRollModalTitle')
let pianoRollInstance = null

function openPianoRollPopup(events, { start, end, title } = {}) {
    pianoRollModalTitle.textContent = title || 'Piano roll'
    pianoRollModalBody.innerHTML = ''
    pianoRollInstance = createPianoRoll(pianoRollModalBody, { keyboard: true, flipped: false })
    pianoRollModal.classList.remove('hidden')

    // Fall back to the events' own span when no range is given (e.g. a MIDI file)
    const evs = events || []
    const s = start ?? (evs.length ? evs[0].timestamp : 0)
    const e = end ?? (evs.length ? evs[evs.length - 1].timestamp : s + 1000)

    // Canvas can only be measured once the modal is laid out
    requestAnimationFrame(() => pianoRollInstance && pianoRollInstance.setData(evs, s, e))
}

function closePianoRollPopup() {
    pianoRollModal.classList.add('hidden')
    pianoRollModalBody.innerHTML = ''
    pianoRollInstance = null
}

$('pianoRollModalClose').addEventListener('click', closePianoRollPopup)
pianoRollModal.addEventListener('click', (e) => {
    if (e.target === pianoRollModal) closePianoRollPopup()
})
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pianoRollModal.classList.contains('hidden')) {
        e.stopImmediatePropagation()
        closePianoRollPopup()
    }
}, true)
window.addEventListener('resize', () => {
    if (pianoRollInstance) pianoRollInstance.resize()
})
