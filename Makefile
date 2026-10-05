SHELL := /bin/bash

# Canonical project-owned cache and disposable temporary root.
PROJECT_TMP_ROOT ?= /workspace/tmp/ghostty-web
PROJECT_CACHE_ROOT := $(PROJECT_TMP_ROOT)/cache
PROJECT_BUILD_ROOT := $(PROJECT_TMP_ROOT)/build
PROJECT_RUNS_ROOT := $(PROJECT_TMP_ROOT)/runs
export TMPDIR := $(PROJECT_RUNS_ROOT)/make
export TMP := $(TMPDIR)
export TEMP := $(TMPDIR)
export BUN_INSTALL_CACHE_DIR := $(PROJECT_CACHE_ROOT)/bun
export npm_config_cache := $(PROJECT_CACHE_ROOT)/npm
export ZIG_GLOBAL_CACHE_DIR := $(PROJECT_CACHE_ROOT)/zig/global
export ZIG_LOCAL_CACHE_DIR := $(PROJECT_CACHE_ROOT)/zig/local

.PHONY: help prepare-tmp install fmt lint typecheck test check build build-wasm build-lib clean clean-tmp demo demo-dev

help:
	@echo "ghostty-web build helpers"
	@echo
	@echo "Targets:"
	@echo "  install      Install dependencies"
	@echo "  fmt          Check formatting"
	@echo "  lint         Run Biome"
	@echo "  typecheck    Run TypeScript type checking"
	@echo "  test         Run test suite"
	@echo "  check        Run fmt + lint + typecheck + test"
	@echo "  build-wasm   Rebuild ghostty-vt.wasm"
	@echo "  build-lib    Build JS library outputs"
	@echo "  build        Full build (WASM + library + dist copy)"
	@echo "  clean        Remove dist/"
	@echo "  clean-tmp    Remove this project's disposable cache/build/run root"
	@echo "  demo         Run demo server"
	@echo "  demo-dev     Run demo in dev mode"

prepare-tmp:
	@mkdir -p "$(TMPDIR)" "$(BUN_INSTALL_CACHE_DIR)" "$(npm_config_cache)" \
		"$(ZIG_GLOBAL_CACHE_DIR)" "$(ZIG_LOCAL_CACHE_DIR)" "$(PROJECT_BUILD_ROOT)"

install: prepare-tmp
	bun install

fmt: prepare-tmp
	bun run fmt

lint: prepare-tmp
	bun run lint

typecheck: prepare-tmp
	bun run typecheck

test: prepare-tmp
	bun test

check: fmt lint typecheck test

build-wasm: prepare-tmp
	./scripts/build-wasm.sh

build-lib: prepare-tmp
	bun run build:lib

build: prepare-tmp
	bun run build

clean:
	bun run clean

clean-tmp:
	@case "$(PROJECT_TMP_ROOT)" in /workspace/tmp/ghostty-web) rm -rf -- "$(PROJECT_TMP_ROOT)" ;; *) echo "Refusing unsafe PROJECT_TMP_ROOT=$(PROJECT_TMP_ROOT)" >&2; exit 1 ;; esac

demo: prepare-tmp
	bun run demo

demo-dev: prepare-tmp
	bun run demo:dev
