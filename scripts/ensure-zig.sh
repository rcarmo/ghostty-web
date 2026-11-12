#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-0.17.0}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_TMP_ROOT="$($SCRIPT_DIR/project-tmp.sh init)"
export PROJECT_TMP_ROOT
DEFAULT_CACHE_BASE="$PROJECT_TMP_ROOT/cache/zig/toolchains"
CACHE_DIR="${ZIG_CACHE_DIR:-$DEFAULT_CACHE_BASE/$VERSION}"
RUNS_ROOT="$PROJECT_TMP_ROOT/runs/ensure-zig"

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
  mkdir -p "$CACHE_DIR" "$RUNS_ROOT"
  tmpdir="$(mktemp -d "$RUNS_ROOT/download.XXXXXX")"
  trap 'rm -rf "$tmpdir"' EXIT
  tarball="zig-${arch}-${platform}-${VERSION}.tar.xz"
  url="https://ziglang.org/download/${VERSION}/${tarball}"
  echo "Downloading Zig ${VERSION} from ${url}" >&2
  curl --fail --retry 3 --retry-delay 5 -L "$url" -o "$tmpdir/$tarball" >&2
  curl --fail --retry 3 --retry-delay 5 -L https://ziglang.org/download/index.json -o "$tmpdir/index.json" >&2
  bun -e '
    const [index, version, target, archive] = Bun.argv.slice(1);
    const expected = (await Bun.file(index).json())[version]?.[target]?.shasum;
    if (!expected) throw new Error("Missing official Zig SHA-256");
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
    if (actual !== expected) throw new Error("Zig archive SHA-256 mismatch");
  ' "$tmpdir/index.json" "$VERSION" "$arch-$platform" "$tmpdir/$tarball"
  rm -rf "$CACHE_DIR"/*
  tar -xf "$tmpdir/$tarball" -C "$CACHE_DIR" --strip-components=1
fi

echo "$CACHE_DIR"
