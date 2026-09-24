# Using MidiBox

Open <http://localhost:4000>. Recording starts by itself and never stops — there
is no record button. Everything else is about finding and labelling what you
already played.

## The header

| Control | What it does |
| ------- | ------------ |
| **Live / History / Import / Export** | Switch tabs |
| **Now playing** | Whatever is playing, whichever tab (or device) started it: its name, time, ⏸/▶, ⏹ and 🔁 loop. With nothing playing only 🔁 shows, so you can turn loop on before pressing play |
| **☰ Log** | Show or hide the floating event log; drag it by its title bar, resize from the corner |
| **🔌 Connect Out** | Open the MIDI output so playback and clicked keys sound. Turns green and reads *Connected* with the device name; click again to disconnect |
| **Thru** | Pass incoming notes straight back out to the output, so the keyboard plays while you record |
| **● Recording** | Connection state of the browser's WebSocket |

Playback and clicking keys are silent until you connect an output. Choose which
device in the **Playback** panel first if you have more than one.

## Live tab

The keyboard sits directly above the timeline, and the two share a pitch axis:
a note's bar is always under its key.

**Ped.** (bottom left) is the sustain pedal. It lights whenever the pedal is
down, whether on your MIDI keyboard, on screen, or in something playing back. To use it with the on-screen
keys, hold it or hold **P** (on a touch screen, hold it with one finger and
play with the others), or click it once to latch it down and again to release.
Keys you let go of while the pedal is down stay green, fading to a faint tint
over a few seconds, until it lifts (in playback too); on the timeline those notes get a fading
tail that runs to the pedal lift (and keeps growing while you hold it).

The timeline runs **downward** by default — time flows from top (earlier) to
bottom (now) — with pitch left to right. `⇅` at the bottom right flips it.

### Following, or looking around

The **▶ Live** button at the bottom left decides what the timeline is doing, and
which controls sit beside it:

- **Live on** — the view follows the present. The controls beside it set how
  often it steps forward: a note length (`1/1` … `1/16`, dotted and triplet)
  against a **40–220 BPM** slider, or **60Hz** for a continuous redraw. Notes
  appear as you play them; nothing is fetched from the server.
- **Live off** — the view freezes and the controls become pan (`↑ ↓`), zoom
  (`+ -`), and the selection tools (`▶ ⏹ 💾 ✕`).

Dragging on the timeline freezes the view on its own, so the tools appear
exactly when you have something to use them on. **↻** reloads the window from
the database.

### Fullscreen

**⛶**, left of the direction toggle, drops the header and sidebar and gives the
keyboard and timeline the whole page. The same button brings them back, as does
`Esc` where the browser's own fullscreen is in play. The mode is remembered, so
a box that lives on a stand comes back up the way you left it.

On an iPad, **Share → Add to Home Screen** is worth doing: launched from the
home screen it runs without Safari's chrome at all, which combined with ⛶ leaves
nothing on screen but the instrument.

### Selecting and saving

Drag vertically on the timeline to select a span. Then:

- **▶** plays it to the connected output, with a playhead line tracking progress
- **💾** opens the session form — name the song and performer, then save
- **✕** clears the selection

Saved sessions appear as labelled bands on the timeline and in the **Sessions**
list. Click one to select it, double-click to edit: the form opens and the band
grows drag handles at its start and end so you can trim it. **Cancel** puts the
bounds back.

### Keyboard shortcuts

| Key | Action |
| --- | ------ |
| `↑` / `↓` (or `←` / `→`) | Pan toward the top / bottom of the view |
| `+` / `-` | Zoom in (to the selection, if there is one) / out |
| `Home` | Return to live |
| `Space` | Play the selection, or pause / resume what's playing |
| `Esc` | Stop playback, or clear the selection |

Scroll to pan; `Ctrl`/`Shift`+scroll to zoom around the pointer.

### Clicking the keyboard

Click, drag or touch the on-screen keys to play the connected output. Useful for
checking the output works, or picking out a phrase.

## History tab

What was played, by date.

The left column lists days, newest first, each with a note count, the span from
first to last note, and how many sessions cover it.

Pick a day and it's split into **stretches** — runs of continuous playing,
divided wherever the keyboard went quiet for longer than the gap you choose
(30s, 1m, 5m, 15m). Each stretch shows its start time, length, note count, pitch
range, average velocity, a density sparkline, and the names of any sessions
already covering it.

- **Click** a stretch to preview it as a piano roll below
- **▶** on the row, or **Play**, sends it to the output
- **💾 Save** turns it into a session — the quickest way to label a practice run

Today's list updates as you play, and the newest stretch keeps growing while you
are in it.

## Playing back

The **Playback** panel holds the output device, transport, and a progress bar.
Playback streams from the server in real time: notes light up green on the
keyboard while a red playhead crosses the timeline. **Play** is disabled until
something is selected.

Playback is exclusive — starting one stops the last. There is one player for
the whole app (and every device connected to it): the **Now playing** strip in
the header, the ⏹ and 🔁 that appear beside **Live** while something plays, the
Playback panel's **Stop**, History's **Stop** and **🔁**, and the Import /
Export bar all control the same playback, so you can stop or loop it from any
tab, wherever it was started. Loop (🔁) plays it again from the start each time
it ends, until you stop it; it stays on for whatever you play next until you
turn it off. The server does the looping, so it keeps going if the iPad sleeps,
and a page opened mid-playback picks it up.

## MIDI files

The **Import / Export** tab lists imported `.mid` files (format 0 or 1, kept in
your browser, never in the server database) and recorded sessions. A bar pinned
to the top of the tab holds **Import .mid** and the transport for the selected
item: its name and date, play/pause, stop, loop (🔁, the same loop as in the
header), elapsed / total time, piano roll and
score (with the sustain pedal drawn as brackets under the bass staff). Piano roll and score open as panels under the bar, show the playing (or
selected) item and follow along during playback. Click a row to select it. Each row also has its own play, download
(`.mid`) and delete buttons; delete asks for a second click. Playback includes
tempo changes; drag the piano roll's playhead to seek.

## TUI client

For a screen attached to the box itself:

```bash
bun run tui
```

It draws the keyboard and recent notes in the terminal over the same WebSocket.
Point it elsewhere with `MIDIBOX_HOST` and `MIDIBOX_PORT`.

## What's remembered

The browser keeps your view preferences in `localStorage` — timeline window and
direction, update rate, 60 Hz toggle, output device, thru state, log window
position, and the active tab. They are per-browser, not per-user, and clearing
site data resets them. Nothing about your recordings lives there.
