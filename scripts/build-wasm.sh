#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PATCH="patches/ghostty-wasm-api.patch"

echo "🔨 Building ghostty-vt.wasm..."

ZIG_BIN_DIR="$($SCRIPT_DIR/ensure-zig.sh 0.15.2)"
export PATH="$ZIG_BIN_DIR:$PATH"

ZIG_VERSION=$(zig version)
echo "✓ Using Zig $ZIG_VERSION"

# Initialize submodule on first checkout (gitlink is a file, not a directory)
if [ ! -e "ghostty/.git" ]; then
    echo "📦 Initializing Ghostty submodule..."
    git submodule update --init --recursive
else
    echo "📦 Ghostty submodule already initialized"
fi

# Ensure submodule worktree is clean before patching (in case a previous build was interrupted)
cd ghostty
if [ -n "$(git status --porcelain)" ]; then
    echo "🧹 Submodule has leftover changes, resetting..."
    git restore .
    git clean -fd
fi
cd ..

# Apply patch (optional — skip if empty/missing)
if [ -s "$PATCH" ]; then
    echo "🔧 Applying WASM API patch..."
    cd ghostty
    git apply --3way --check "../$PATCH" || {
        echo "❌ Patch doesn't apply cleanly"
        echo "Ghostty may have changed. Check $PATCH"
        exit 1
    }
    git apply --3way "../$PATCH"
    cd ..
else
    echo "🔧 No patch to apply (skipping)"
fi

# Build WASM
echo "⚙️  Building WASM (takes ~20 seconds)..."
cd ghostty
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
cd ..

# Copy to project root
cp ghostty/zig-out/bin/ghostty-vt.wasm ./

# Revert patch & clean any new files it created so the submodule stays clean
echo "🧹 Cleaning up..."
cd ghostty
if [ -s "../$PATCH" ]; then
    git apply -R "../$PATCH"
fi
git restore .
git clean -fd
cd ..

SIZE=$(du -h ghostty-vt.wasm | cut -f1)
echo "✅ Built ghostty-vt.wasm ($SIZE)"
