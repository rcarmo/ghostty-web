SHELL := /bin/bash

.PHONY: help install fmt lint typecheck test check build build-wasm build-lib clean demo demo-dev

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
	@echo "  demo         Run demo server"
	@echo "  demo-dev     Run demo in dev mode"

install:
	bun install

fmt:
	bun run fmt

lint:
	bun run lint

typecheck:
	bun run typecheck

test:
	bun test

check: fmt lint typecheck test

build-wasm:
	./scripts/build-wasm.sh

build-lib:
	bun run build:lib

build:
	bun run build

clean:
	bun run clean

demo:
	bun run demo

demo-dev:
	bun run demo:dev
