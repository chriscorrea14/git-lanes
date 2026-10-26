#!/usr/bin/env bash
# Builds a throwaway repo exercising Git Lanes: trunk, stacked branches, a merged-in branch,
# a deleted merged branch, pushed/unpushed commits, and a branch that conflicts with trunk.
# Usage: scripts/make-demo-repo.sh [dir]   (default: /tmp/git-lanes-demo)
set -euo pipefail
DIR="${1:-/tmp/git-lanes-demo}"
rm -rf "$DIR" "$DIR.remote.git"
git init -q --bare -b main "$DIR.remote.git"
git init -q -b main "$DIR"
cd "$DIR"
git config user.name "Demo"; git config user.email "demo@example.com"; git config commit.gpgsign false
git remote add origin "$DIR.remote.git"

T=1700000000
c() { # c <message> [file] [content]
  local f="${2:-$1.txt}"; echo "${3:-$1}" > "$f"; git add "$f"
  T=$((T + 3600)); GIT_AUTHOR_DATE="$T +0000" GIT_COMMITTER_DATE="$T +0000" git commit -q -m "$1"
}
m() { T=$((T + 3600)); GIT_AUTHOR_DATE="$T +0000" GIT_COMMITTER_DATE="$T +0000" git merge -q --no-ff -m "$2" "$1"; }

c "Initial commit" README.md "# demo"
c "Add config loader" shared.txt "v1"
for i in $(seq 3 8); do c "Trunk work $i"; done
M8=$(git rev-parse HEAD)
git checkout -q -b feat/x
c "x: add parser"; c "x: parser tests"; c "x: handle edge cases"
git checkout -q -b feat/y
c "y: build on parser"; c "y: wire into CLI"
git checkout -q main
for i in $(seq 9 14); do c "Trunk work $i"; done
git checkout -q -b feat/z
c "z: logging helper"; c "z: use helper"
git checkout -q feat/y
m feat/z "Merge feat/z into feat/y"
git checkout -q -b old-side main~2
c "side: temp fix"
git checkout -q feat/y
m old-side "Merge old-side into feat/y"
git branch -q -D old-side
git checkout -q main
for i in $(seq 15 30); do c "Trunk work $i"; done
c "Change shared config" shared.txt "v2-main"
git push -q -u origin main
git remote set-head origin main
git checkout -q -b feat/conflict "$M8"
c "conflict: tweak config" shared.txt "v2-branch"
c "conflict: follow-up"
git push -q -u origin feat/conflict
c "conflict: unpushed work"
git checkout -q feat/x
git push -q -u origin feat/x
c "x: unpushed polish"
git checkout -q -b feat/solo main~3
c "solo: quick experiment"
git branch -q merged-already main~10
git checkout -q feat/y
echo "Demo repo at $DIR"
