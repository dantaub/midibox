// Expected total length of a MIDI message from its status byte. -1 means
// variable (SysEx), 0 means unknown. Shared by transports that must frame a
// raw byte stream (rawalsa) or a packed MIDI list (rtpmidi).
export function midiMessageLength(status: number): number {
  const type = status & 0xf0;
  switch (type) {
    case 0x80: // Note Off
    case 0x90: // Note On
    case 0xa0: // Poly Aftertouch
    case 0xb0: // Control Change
    case 0xe0: // Pitch Bend
      return 3;
    case 0xc0: // Program Change
    case 0xd0: // Channel Pressure
      return 2;
    case 0xf0: // System
      if (status === 0xf0) return -1; // SysEx - variable
      if (status === 0xf1 || status === 0xf3) return 2;
      if (status === 0xf2) return 3;
      return 1;
    default:
      return 0;
  }
}
