#!/usr/bin/env bash
set -euo pipefail

app_bundle="${1:-dist/mac-arm64/Got Skills.app}"
limit_bytes="${2:-310000000}"
size_kib="$(du -sk "$app_bundle" | awk '{print $1}')"
size_bytes=$((size_kib * 1024))
printf 'App size: %s bytes; limit: %s bytes\n' "$size_bytes" "$limit_bytes"
if ((size_bytes > limit_bytes)); then
  printf 'App size %s bytes exceeds limit %s bytes\n' "$size_bytes" "$limit_bytes" >&2
  exit 1
fi
