#!/bin/sh
# Offline SVG -> 2x PNG. Requires an existing rsvg-convert (librsvg) installation.
set -eu

if ! command -v rsvg-convert >/dev/null 2>&1; then
  printf '%s\n' 'rsvg-convert is required; see docs/assets/README.md.' >&2
  exit 1
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
assets="$root/docs/assets"
for name in agent-session-loop context-decider tool-availability-gates; do
  rsvg-convert --zoom=2 --output="$assets/$name.png" "$assets/$name.svg"
  printf 'Rendered %s.png\n' "$name"
done
