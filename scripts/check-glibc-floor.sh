#!/bin/sh
# A dynamically linked binary carries the glibc symbol versions of the machine
# that built it, so the release companion is only runnable on distributions at
# least as new as the build image. That floor is invisible until someone
# downloads the asset and gets `version 'GLIBC_2.39' not found` with nothing to
# install that fixes it, which is why it is asserted here instead of discovered
# by users: a build image that moves under us fails this job rather than the
# download.
set -eu

usage() {
  echo "Usage: check-glibc-floor.sh BINARY MAX_GLIBC_VERSION" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
binary=$1
max=$2
[ -f "$binary" ] || { echo "check-glibc-floor: no such binary: $binary" >&2; exit 1; }

# Versioned references appear as GLIBC_2.35 in the dynamic symbol table. A
# static or non-glibc binary legitimately has none, and imposes no floor.
highest=$(objdump -T "$binary" | sed -n 's/.*GLIBC_\([0-9][0-9.]*\).*/\1/p' | sort -V | tail -n 1)
if [ -z "$highest" ]; then
  echo "check-glibc-floor: $binary references no versioned glibc symbols."
  exit 0
fi

echo "check-glibc-floor: $binary requires glibc $highest (limit $max)."
# sort -V puts the newer version last, so the limit staying last means the
# binary asks for no more than the limit. Equal versions sort to the limit too.
if [ "$(printf '%s\n%s\n' "$highest" "$max" | sort -V | tail -n 1)" != "$max" ]; then
  echo "check-glibc-floor: that is newer than $max, so distributions shipping" >&2
  echo "glibc $max cannot run it. Build the Linux companion on an older base" >&2
  echo "image, or raise the documented requirement deliberately." >&2
  exit 1
fi
