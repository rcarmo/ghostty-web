#!/usr/bin/env bash
# Portable project-owned scratch resolver for ghostty-web.
set -euo pipefail

# Capture the inherited TMPDIR once, before Make/helpers redirect child TMPDIR.
if [[ -z "${PROJECT_ORIGINAL_TMPDIR+x}" ]]; then
  export PROJECT_ORIGINAL_TMPDIR="${TMPDIR:-}"
fi

project_is_ci() {
  case "${CI:-}" in ''|0|false|FALSE) ;; *) return 0 ;; esac
  case "${GITHUB_ACTIONS:-}:${GITLAB_CI:-}:${TF_BUILD:-}:${CIRCLECI:-}" in
    *true*|*True*|*TRUE*) return 0 ;;
  esac
  return 1
}

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
  local base candidate explicit_base_root='' workspace_base=/workspace/tmp

  if [[ -n "${PROJECT_TMP_BASE+x}" ]]; then
    [[ -n "$PROJECT_TMP_BASE" ]] || { echo 'PROJECT_TMP_BASE must not be empty' >&2; return 1; }
    explicit_base_root="${PROJECT_TMP_BASE%/}/ghostty-web"
    project_path_usable "$explicit_base_root" || {
      echo 'PROJECT_TMP_BASE must be a usable absolute base' >&2
      return 1
    }
  fi

  if [[ -n "${PROJECT_TMP_ROOT+x}" ]]; then
    candidate="${PROJECT_TMP_ROOT%/}"
    [[ "${candidate##*/}" == ghostty-web ]] && project_path_usable "$candidate" || {
      echo 'PROJECT_TMP_ROOT must be a usable absolute directory ending in ghostty-web' >&2
      return 1
    }
    [[ -z "$explicit_base_root" || "$candidate" == "$explicit_base_root" ]] || {
      echo 'Conflicting PROJECT_TMP_BASE and PROJECT_TMP_ROOT' >&2
      return 1
    }
    printf '%s\n' "$candidate"
    return
  fi

  if [[ -n "$explicit_base_root" ]]; then
    printf '%s\n' "$explicit_base_root"
    return
  fi

  local bases=()
  if project_is_ci; then
    # CI must not select a host workspace mount.
    bases=("${RUNNER_TEMP:-}" "$PROJECT_ORIGINAL_TMPDIR" /tmp)
  else
    # Local hosts prefer the shared workspace base, then system temporary storage.
    if [[ ! -d "$workspace_base" && ! -d "${workspace_base%/*}" ]]; then workspace_base=''; fi
    bases=("$workspace_base" /tmp)
  fi

  for base in "${bases[@]}"; do
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
  local root="$1" path
  for path in "$root" "$root/cache" "$root/build" "$root/tests" "$root/logs" "$root/runs"; do
    project_path_usable "$path" || { echo "Unsafe scratch path: $path" >&2; return 1; }
  done
  mkdir -p "$root/cache" "$root/build" "$root/tests" "$root/logs" "$root/runs"
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
