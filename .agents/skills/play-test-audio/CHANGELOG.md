# Changelog

## [0.2.0]

- Survive a route change: the desk input rebuilding the aggregate stops the engine, so the player now restarts on the device's new id and the stereo path resumes at the frame it reached. Status lines are timestamped and every restart is logged.
- Fix the wait loops: macOS's bash 3.2 rejects `read -t 0.2`, which made `play` report "player did not report a peak" before any sound had started.

## [0.1.0]

- Play a stereo wav, or two channel files, into the existing Multi-Output Device or BlackHole only.
