import { parseAddress } from "./types";

export interface ResolvedScheme {
  scheme: string;
  rest: string | undefined;
  explicit: boolean; // true when the caller named a scheme (pinned it)
}

// Resolve a device address into a transport scheme + the scheme-less remainder,
// falling back to `defaultScheme` when none was given. Accepts:
//   "seq:USB Keyboard"  -> { seq, "USB Keyboard", explicit }   (explicit scheme)
//   "rawalsa"           -> { rawalsa, undefined, explicit }     (bare scheme name)
//   "/dev/snd/midiC1D0" -> { <default>, "/dev/snd...", implicit }(bare address)
//   undefined           -> { <default>, undefined, implicit }
export function resolveScheme(
  id: string | undefined,
  knownSchemes: readonly string[],
  defaultScheme: string
): ResolvedScheme {
  const parsed = parseAddress(id, knownSchemes);
  if (parsed.scheme) return { scheme: parsed.scheme, rest: parsed.rest, explicit: true };
  if (id && knownSchemes.includes(id)) return { scheme: id, rest: undefined, explicit: true };
  return { scheme: defaultScheme, rest: id, explicit: false };
}
