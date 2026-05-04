#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-0.15.2}"
DEFAULT_CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}/ghostty-web/zig"
CACHE_DIR="${ZIG_CACHE_DIR:-$DEFAULT_CACHE_BASE/$VERSION}"

platform=""
arch=""
case "$(uname -s)" in
  Linux) platform="linux" ;;
  Darwin) platform="macos" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if command -v zig >/dev/null 2>&1; then
  current="$(zig version || true)"
  if [ "$current" = "$VERSION" ]; then
    dirname "$(command -v zig)"
    exit 0
  fi
fi

if [ ! -x "$CACHE_DIR/zig" ] || [ "$($CACHE_DIR/zig version 2>/dev/null || true)" != "$VERSION" ]; then
  mkdir -p "$CACHE_DIR"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
  tarball="zig-${arch}-${platform}-${VERSION}.tar.xz"
  url="https://ziglang.org/download/${VERSION}/${tarball}"
  echo "Downloading Zig ${VERSION} from ${url}" >&2
  curl --retry 3 --retry-delay 5 -L "$url" -o "$tmpdir/$tarball" >&2
  rm -rf "$CACHE_DIR"/*
  tar -xf "$tmpdir/$tarball" -C "$CACHE_DIR" --strip-components=1
fi

echo "$CACHE_DIR"
