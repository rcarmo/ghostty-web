#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "🔨 Building ghostty-vt.wasm..."

ZIG_BIN_DIR="$($SCRIPT_DIR/ensure-zig.sh 0.15.2)"
export PATH="$ZIG_BIN_DIR:$PATH"

ZIG_VERSION=$(zig version)
echo "✓ Using Zig $ZIG_VERSION"

# Initialize/update submodule
if [ ! -d "ghostty/.git" ]; then
    echo "📦 Initializing Ghostty submodule..."
    git submodule update --init --recursive
else
    echo "📦 Ghostty submodule already initialized"
fi

# Apply patch
echo "🔧 Applying WASM API patch..."
cd ghostty
git apply --3way --check ../patches/ghostty-wasm-api.patch || {
    echo "❌ Patch doesn't apply cleanly, even with 3-way merge"
    echo "Ghostty may have changed. Check patches/ghostty-wasm-api.patch"
    exit 1
}
git apply --3way ../patches/ghostty-wasm-api.patch

# Build WASM
echo "⚙️  Building WASM (takes ~20 seconds)..."
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall

# Copy to project root
cd ..
cp ghostty/zig-out/bin/ghostty-vt.wasm ./

# Revert patch to keep submodule clean
echo "🧹 Cleaning up..."
cd ghostty
git apply -R ../patches/ghostty-wasm-api.patch
# Remove new files created by the patch
rm -f include/ghostty/vt/terminal.h
rm -f src/terminal/c/terminal.zig
cd ..

SIZE=$(du -h ghostty-vt.wasm | cut -f1)
echo "✅ Built ghostty-vt.wasm ($SIZE)"
