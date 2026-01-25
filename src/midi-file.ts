// Standard MIDI File (SMF) parser
// Parses .mid files and extracts note events with timing

export interface MidiFileEvent {
  deltaTime: number;    // Ticks since last event
  absoluteTime: number; // Absolute time in ticks
  timeMs: number;       // Absolute time in milliseconds
  channel: number;
  type: "noteon" | "noteoff" | "cc" | "program" | "pitchbend" | "pressure" | "polytouch" | "meta";
  note?: number;
  velocity?: number;
  control?: number;
  value?: number;
  metaType?: number;
  data?: Uint8Array;
}

export interface MidiFile {
  format: number;
  trackCount: number;
  ticksPerBeat: number;
  tracks: MidiFileEvent[][];
  durationMs: number;
}

class MidiParser {
  private data: DataView;
  private pos: number = 0;

  constructor(buffer: ArrayBuffer) {
    this.data = new DataView(buffer);
  }

  parse(): MidiFile {
    // Read header chunk
    const headerChunk = this.readChunk();
    if (headerChunk.type !== "MThd") {
      throw new Error("Invalid MIDI file: missing MThd header");
    }

    const format = this.readUint16(headerChunk.data, 0);
    const trackCount = this.readUint16(headerChunk.data, 2);
    const division = this.readUint16(headerChunk.data, 4);

    // Check if SMPTE timing (we only support ticks per beat)
    if (division & 0x8000) {
      throw new Error("SMPTE timing not supported");
    }

    const ticksPerBeat = division;
    const tracks: MidiFileEvent[][] = [];

    // Read track chunks
    for (let i = 0; i < trackCount; i++) {
      const trackChunk = this.readChunk();
      if (trackChunk.type !== "MTrk") {
        throw new Error(`Invalid MIDI file: expected MTrk, got ${trackChunk.type}`);
      }
      tracks.push(this.parseTrack(trackChunk.data));
    }

    // Convert to absolute time and merge tracks
    const mergedEvents = this.mergeTracksWithTiming(tracks, ticksPerBeat);
    const durationMs = mergedEvents.length > 0 ? mergedEvents[mergedEvents.length - 1].timeMs : 0;

    return {
      format,
      trackCount,
      ticksPerBeat,
      tracks,
      durationMs,
    };
  }

  private readChunk(): { type: string; data: Uint8Array } {
    const type = String.fromCharCode(
      this.data.getUint8(this.pos),
      this.data.getUint8(this.pos + 1),
      this.data.getUint8(this.pos + 2),
      this.data.getUint8(this.pos + 3)
    );
    this.pos += 4;

    const length = this.data.getUint32(this.pos);
    this.pos += 4;

    const data = new Uint8Array(this.data.buffer, this.pos, length);
    this.pos += length;

    return { type, data };
  }

  private readUint16(data: Uint8Array, offset: number): number {
    return (data[offset] << 8) | data[offset + 1];
  }

  private parseTrack(data: Uint8Array): MidiFileEvent[] {
    const events: MidiFileEvent[] = [];
    let pos = 0;
    let runningStatus = 0;
    let absoluteTime = 0;

    while (pos < data.length) {
      // Read variable-length delta time
      const [deltaTime, newPos] = this.readVariableLength(data, pos);
      pos = newPos;
      absoluteTime += deltaTime;

      if (pos >= data.length) break;

      let status = data[pos];

      // Handle running status
      if (status < 0x80) {
        status = runningStatus;
      } else {
        pos++;
        if (status < 0xf0) {
          runningStatus = status;
        }
      }

      const channel = status & 0x0f;
      const type = status & 0xf0;

      let event: MidiFileEvent | null = null;

      switch (type) {
        case 0x80: // Note Off
          event = {
            deltaTime,
            absoluteTime,
            timeMs: 0,
            channel,
            type: "noteoff",
            note: data[pos],
            velocity: data[pos + 1],
          };
          pos += 2;
          break;

        case 0x90: // Note On (velocity 0 = note off)
          event = {
            deltaTime,
            absoluteTime,
            timeMs: 0,
            channel,
            type: data[pos + 1] > 0 ? "noteon" : "noteoff",
            note: data[pos],
            velocity: data[pos + 1],
          };
          pos += 2;
          break;

        case 0xa0: // Poly Aftertouch
          event = {
            deltaTime,
            absoluteTime,
            timeMs: 0,
            channel,
            type: "polytouch",
            note: data[pos],
            value: data[pos + 1],
          };
          pos += 2;
          break;

        case 0xb0: // Control Change
          event = {
            deltaTime,
            absoluteTime,
            timeMs: 0,
            channel,
            type: "cc",
            control: data[pos],
            value: data[pos + 1],
          };
          pos += 2;
          break;

        case 0xc0: // Program Change
          event = {
            deltaTime,
            absoluteTime,
            timeMs: 0,
            channel,
            type: "program",
            value: data[pos],
          };
          pos += 1;
          break;

        case 0xd0: // Channel Pressure
          event = {
            deltaTime,
            absoluteTime,
            timeMs: 0,
            channel,
            type: "pressure",
            value: data[pos],
          };
          pos += 1;
          break;

        case 0xe0: // Pitch Bend
          event = {
            deltaTime,
            absoluteTime,
            timeMs: 0,
            channel,
            type: "pitchbend",
            value: data[pos] | (data[pos + 1] << 7),
          };
          pos += 2;
          break;

        case 0xf0: // System / Meta
          if (status === 0xff) {
            // Meta event
            const metaType = data[pos++];
            const [length, newPos2] = this.readVariableLength(data, pos);
            pos = newPos2;
            const metaData = data.slice(pos, pos + length);
            pos += length;

            event = {
              deltaTime,
              absoluteTime,
              timeMs: 0,
              channel: 0,
              type: "meta",
              metaType,
              data: metaData,
            };
          } else if (status === 0xf0 || status === 0xf7) {
            // SysEx
            const [length, newPos2] = this.readVariableLength(data, pos);
            pos = newPos2 + length;
          }
          break;
      }

      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private readVariableLength(data: Uint8Array, pos: number): [number, number] {
    let value = 0;
    let byte: number;

    do {
      byte = data[pos++];
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);

    return [value, pos];
  }

  private mergeTracksWithTiming(tracks: MidiFileEvent[][], ticksPerBeat: number): MidiFileEvent[] {
    // Default tempo: 120 BPM = 500000 microseconds per beat
    let microsecondsPerBeat = 500000;
    const tempoChanges: { tick: number; tempo: number }[] = [{ tick: 0, tempo: microsecondsPerBeat }];

    // First pass: collect tempo changes from all tracks
    for (const track of tracks) {
      for (const event of track) {
        if (event.type === "meta" && event.metaType === 0x51 && event.data) {
          // Tempo change
          const tempo = (event.data[0] << 16) | (event.data[1] << 8) | event.data[2];
          tempoChanges.push({ tick: event.absoluteTime, tempo });
        }
      }
    }

    // Sort tempo changes by tick
    tempoChanges.sort((a, b) => a.tick - b.tick);

    // Convert ticks to milliseconds using tempo map
    const tickToMs = (tick: number): number => {
      let ms = 0;
      let lastTick = 0;
      let lastTempo = tempoChanges[0].tempo;

      for (const change of tempoChanges) {
        if (change.tick > tick) break;
        
        // Add time from lastTick to change.tick at lastTempo
        const deltaTicks = change.tick - lastTick;
        ms += (deltaTicks / ticksPerBeat) * (lastTempo / 1000);
        
        lastTick = change.tick;
        lastTempo = change.tempo;
      }

      // Add remaining ticks at current tempo
      const deltaTicks = tick - lastTick;
      ms += (deltaTicks / ticksPerBeat) * (lastTempo / 1000);

      return ms;
    };

    // Merge all tracks and convert timing
    const allEvents: MidiFileEvent[] = [];
    for (const track of tracks) {
      for (const event of track) {
        event.timeMs = tickToMs(event.absoluteTime);
        allEvents.push(event);
      }
    }

    // Sort by absolute time
    allEvents.sort((a, b) => a.absoluteTime - b.absoluteTime || a.timeMs - b.timeMs);

    return allEvents;
  }
}

export function parseMidiFile(buffer: ArrayBuffer): MidiFile {
  return new MidiParser(buffer).parse();
}

// Get playable events (note on/off, CC, etc.) with timing in milliseconds
export function getPlayableEvents(midiFile: MidiFile): MidiFileEvent[] {
  const events: MidiFileEvent[] = [];
  
  // Default tempo
  let microsecondsPerBeat = 500000;
  const tempoChanges: { tick: number; tempo: number }[] = [{ tick: 0, tempo: microsecondsPerBeat }];

  // Collect tempo changes
  for (const track of midiFile.tracks) {
    for (const event of track) {
      if (event.type === "meta" && event.metaType === 0x51 && event.data) {
        const tempo = (event.data[0] << 16) | (event.data[1] << 8) | event.data[2];
        tempoChanges.push({ tick: event.absoluteTime, tempo });
      }
    }
  }
  tempoChanges.sort((a, b) => a.tick - b.tick);

  // Convert ticks to ms
  const tickToMs = (tick: number): number => {
    let ms = 0;
    let lastTick = 0;
    let lastTempo = tempoChanges[0].tempo;

    for (const change of tempoChanges) {
      if (change.tick > tick) break;
      const deltaTicks = change.tick - lastTick;
      ms += (deltaTicks / midiFile.ticksPerBeat) * (lastTempo / 1000);
      lastTick = change.tick;
      lastTempo = change.tempo;
    }

    const deltaTicks = tick - lastTick;
    ms += (deltaTicks / midiFile.ticksPerBeat) * (lastTempo / 1000);
    return ms;
  };

  // Collect playable events
  for (const track of midiFile.tracks) {
    for (const event of track) {
      if (event.type === "noteon" || event.type === "noteoff" || 
          event.type === "cc" || event.type === "pitchbend" ||
          event.type === "program") {
        events.push({
          ...event,
          timeMs: tickToMs(event.absoluteTime),
        });
      }
    }
  }

  // Sort by time
  events.sort((a, b) => a.timeMs - b.timeMs);
  return events;
}
