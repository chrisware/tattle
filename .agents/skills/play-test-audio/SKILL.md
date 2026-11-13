---
name: play-test-audio
description: Tattle — Play test audio into BlackHole and the speakers. Use when playing a fixture, a stereo wav, or two channel files for a desk session. Not for Audio MIDI Setup or the system default output.
argument-hint: "[play|stop|check] [wav or --left and --right]"
allowed-tools: Bash, Read, Glob, AskUserQuestion
---

# Play test audio

Play a wav into the desk capture path. One stereo file is the native layout. Left is the interviewer (host, BlackHole channel 1). Right is the guest (remote, channel 2). Two files work too. `--left` and `--right` each contribute their first channel, mono or stereo, and loop independently.

Playback is local. It does not start a session, open the page, or spend API money.

## Route

- Default is the existing Multi-Output Device, the aggregate that already contains MacBook Pro Speakers and BlackHole 2ch. The speakers play it, and a live session whose source is BlackHole still receives it.
- `--blackhole` selects BlackHole 2ch only. Speakers stay quiet.
- Never change the system default input or output. Never open Audio MIDI Setup. Never create or edit an aggregate. If the aggregate is missing or no longer contains both devices, stop and say so.
- Do not use `/Users/Shared/tattle-fixture-play` or `/tmp/bh-play`. Those are one-off builds.

## Commands

`${CLAUDE_SKILL_DIR}` is this skill's directory. The script compiles on first use, then returns. Looping playback keeps running after the command returns.

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/play.sh" check
bash "${CLAUDE_SKILL_DIR}/scripts/play.sh" play /path/to/stereo.wav
bash "${CLAUDE_SKILL_DIR}/scripts/play.sh" play --left /path/host.wav --right /path/guest.wav
bash "${CLAUDE_SKILL_DIR}/scripts/play.sh" play --blackhole /path/to/stereo.wav
bash "${CLAUDE_SKILL_DIR}/scripts/play.sh" play --once /path/to/stereo.wav
bash "${CLAUDE_SKILL_DIR}/scripts/play.sh" stop
```

`play` loops until `stop`. `--once` plays through and exits. `check` prints the device and does not play.

## Steps

1. Run only when asked to play, stream, loop, feed, or stop test audio.
2. If no file was named, use a wav named earlier in the session. If `/tmp/tattle-desk-stereo.wav` exists and they said "the fixture", use that. If several candidates remain, ask which file. Do not search `~/Library` or another user's home.
3. Default to speakers plus BlackHole. Pass `--blackhole` only when they ask for silence.
4. Run `check` first when the device may have changed. Then `play`.
5. Report the device line, that the system default was not changed, and the peak line. Left peak is the interviewer. Right peak is the guest. The desk fixture is silent on the right for about the first 8 seconds, so a zero right peak at 2.5 seconds is expected for that file.
6. `stop` when asked, and before starting a different file. If `play` says already playing, stop first.

## Constraints

- macOS only. Needs `swiftc` (Xcode Command Line Tools) and the existing BlackHole 2ch device.
- Do not copy credentials. Do not run smoke, preflight, or a real session.

## Verify

`check` names Multi-Output Device and lists `BuiltInSpeakerDevice` and `BlackHole2ch_UID`. After `play`, the output includes `mixer peak`. `stop` reports the pid stopped, or `not playing`.

Playback survives a route change. Opening the desk input rebuilds the aggregate and stops Core Audio's engine; the player notices within half a second, looks the device up again (its id changes), and restarts, logging `audio route changed; restarted on …`. The stereo path resumes at the frame it reached, not from the start. If the log shows no such line while the room is quiet, check `mixer peak` and the device line before suspecting the tape.
