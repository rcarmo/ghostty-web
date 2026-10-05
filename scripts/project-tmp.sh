#!/usr/bin/env bash
# Portable project-owned scratch resolver for ghostty-web.
set -euo pipefail

project_path_usable() {
  local path="$1" parent ancestor
  case "$path" in /*) ;; *) return 1 ;; esac
  case "/${path#/}/" in */../*|*/./*) return 1 ;; esac
  [[ ! -L "$path" ]] || return 1
  ancestor="${path%/*}"
  while [[ -n "$ancestor" && "$ancestor" != / ]]; do
    [[ ! -L "$ancestor" || "$ancestor" == /workspace ]] || return 1
    ancestor="${ancestor%/*}"
  done
  if [[ -e "$path" ]]; then
    [[ -d "$path" && -O "$path" && -w "$path" && -x "$path" ]] || return 1
  fi
  parent="$path"
  while [[ ! -e "$parent" && ! -L "$parent" ]]; do
    parent="${parent%/*}"
    [[ -n "$parent" ]] || parent=/
  done
  [[ -d "$parent" && -w "$parent" && -x "$parent" ]]
}

project_tmp_resolve() {
  local base candidate
  if [[ -n "${PROJECT_TMP_ROOT+x}" ]]; then
    candidate="${PROJECT_TMP_ROOT%/}"
    [[ "${candidate##*/}" == ghostty-web ]] && project_path_usable "$candidate" || {
      echo 'PROJECT_TMP_ROOT must be a usable absolute directory ending in ghostty-web' >&2
      return 1
    }
    printf '%s\n' "$candidate"
    return
  fi
  for base in /workspace/tmp "${RUNNER_TEMP:-}" "${TMPDIR:-}" /tmp; do
    [[ -n "$base" ]] || continue
    candidate="${base%/}/ghostty-web"
    if project_path_usable "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  echo 'No writable project-owned temporary root available' >&2
  return 1
}

project_tmp_init() {
  local root="$1"
  project_path_usable "$root" || return 1
  mkdir -p "$root/cache" "$root/build" "$root/runs"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  root="$(project_tmp_resolve)"
  case "${1:-paths}" in
    paths) ;;
    init) project_tmp_init "$root" ;;
    *) echo 'Usage: project-tmp.sh [paths|init]' >&2; exit 1 ;;
  esac
  printf '%s\n' "$root"
fi
