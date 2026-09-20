// ===========================================
// IndexedDB store for imported MIDI files (client-side only; never uploaded to
// the server for storage). Keeps the raw file bytes so a recent import can be
// replayed, viewed, downloaded or deleted after a reload.
// ===========================================

const IMPORTS_DB = 'midibox-imports'
const IMPORTS_STORE = 'files'

function openImportsDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IMPORTS_DB, 1)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(IMPORTS_STORE)) {
                db.createObjectStore(IMPORTS_STORE, { keyPath: 'id', autoIncrement: true })
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

function importsTx(mode) {
    return openImportsDb().then(db => db.transaction(IMPORTS_STORE, mode).objectStore(IMPORTS_STORE))
}

// Save a File's bytes + metadata. Returns the new record's id.
async function saveImport(file) {
    const data = await file.arrayBuffer()
    const store = await importsTx('readwrite')
    return new Promise((resolve, reject) => {
        const req = store.add({ name: file.name, size: file.size, importedAt: Date.now(), data })
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

// All imports, newest first.
async function listImports() {
    const store = await importsTx('readonly')
    return new Promise((resolve, reject) => {
        const req = store.getAll()
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.importedAt - a.importedAt))
        req.onerror = () => reject(req.error)
    })
}

async function getImport(id) {
    const store = await importsTx('readonly')
    return new Promise((resolve, reject) => {
        const req = store.get(id)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
    })
}

async function deleteImport(id) {
    const store = await importsTx('readwrite')
    return new Promise((resolve, reject) => {
        const req = store.delete(id)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
    })
}
