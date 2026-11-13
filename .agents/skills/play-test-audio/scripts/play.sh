#!/bin/bash
# Compile and run the desk test-audio player. Does not change system audio defaults.
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
	echo "error: play-test-audio requires macOS" >&2
	exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/play.swift"
CACHE="${HOME}/Library/Caches/tattle/play-test-audio"
mkdir -p "$CACHE"
BIN="$CACHE/play"
PID="$CACHE/play.pid"
LOG="$CACHE/play.log"

usage() {
	echo "usage: play.sh play|check|stop|self-test [--blackhole] [--once] [--left FILE --right FILE] [STEREO.wav]" >&2
}

if [[ $# -lt 1 ]]; then
	usage
	exit 2
fi

cmd="$1"
shift

compile() {
	if [[ ! -x "$BIN" || "$SRC" -nt "$BIN" ]]; then
		swiftc -O -o "$BIN" "$SRC"
	fi
}

running() {
	[[ -f "$PID" ]] || return 1
	local pid
	pid="$(cat "$PID")"
	[[ -n "$pid" ]] || return 1
	kill -0 "$pid" 2>/dev/null
}

stop_player() {
	if running; then
		local pid
		pid="$(cat "$PID")"
		kill "$pid" 2>/dev/null || true
		for _ in 1 2 3 4 5 6 7 8 9 10; do
			kill -0 "$pid" 2>/dev/null || break
			sleep 0.1
		done
		if kill -0 "$pid" 2>/dev/null; then
			kill -9 "$pid" 2>/dev/null || true
		fi
		rm -f "$PID"
		echo "stopped $pid"
	else
		rm -f "$PID"
		echo "not playing"
	fi
}

case "$cmd" in
	stop)
		stop_player
		;;
	check)
		compile
		exec "$BIN" --check "$@"
		;;
	self-test)
		compile
		exec "$BIN" --self-test
		;;
	play)
		if running; then
			echo "error: already playing pid $(cat "$PID"); stop first" >&2
			exit 2
		fi
		rm -f "$PID"
		compile
		: >"$LOG"
		"$BIN" "$@" >>"$LOG" 2>&1 &
		echo $! >"$PID"
		disown || true
		ok=0
		for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
			if grep -q "mixer peak" "$LOG"; then
				ok=1
				break
			fi
			if grep -q "error:" "$LOG"; then
				break
			fi
			if ! running; then
				break
			fi
			# bash 3.2 (macOS /bin/bash) rejects fractional read -t; sleep is portable
			sleep 0.2
		done
		cat "$LOG"
		if [[ "$ok" != 1 ]]; then
			echo "error: player did not report a peak" >&2
			exit 1
		fi
		echo "pid $(cat "$PID")"
		;;
	*)
		usage
		exit 2
		;;
esac
