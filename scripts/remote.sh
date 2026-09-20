#!/usr/bin/env bash
# Run a command on the MidiBox host over SSH, with bun on PATH and the working
# directory at the repo. Encapsulates the quirks found while debugging the Pi:
# bun lives in ~/.bun/bin but isn't on the non-interactive PATH, and nested
# quoting through ssh is painful - so the command is fed to a remote login shell
# over stdin.
#
#   MIDIBOX_HOST=dorian@doorian.local ./scripts/remote.sh 'bun run midi:timing'
#   MIDIBOX_HOST=... ./scripts/remote.sh <<'SH'
#     curl -s localhost:4200/api/midi/transports
#   SH
#
# Env:
#   MIDIBOX_HOST        user@host (required)
#   MIDIBOX_REMOTE_DIR  repo path on the host (default: src/midibox, from $HOME)
set -euo pipefail

: "${MIDIBOX_HOST:?set MIDIBOX_HOST=user@host}"
REMOTE_DIR="${MIDIBOX_REMOTE_DIR:-src/midibox}"
CMD="${1:-$(cat)}"

# Build the remote script and pipe it, so nothing in $CMD (e.g. $!, ${x},
# $(...)) expands locally - it runs on the host. Only the preamble does.
{
  echo 'export PATH="$HOME/.bun/bin:$PATH"'
  printf 'cd %q || { echo "no such dir: %s" >&2; exit 1; }\n' "$REMOTE_DIR" "$REMOTE_DIR"
  printf '%s\n' "$CMD"
} | ssh -o ConnectTimeout=10 "$MIDIBOX_HOST" 'bash -ls'
