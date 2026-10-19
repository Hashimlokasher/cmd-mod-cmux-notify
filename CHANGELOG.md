# Changelog

## 0.2.0 - 2026-10-19

- Detect permission prompts by reading the cmux screen at 1.5s, 4s, and 6s instead of waiting
  a fixed 8 seconds. Auto-accepted calls are cancelled after three readable checks with no
  prompt; an 8s fallback covers terminals whose screen cannot be read.
- Dismiss the specific approval notification when the prompt resolves, instead of leaving a
  stale alert next to the later done notification.
- Use mod-owned clock timers so hot reload cancels pending screen checks.
- Add type checking, linting, coverage gates, mock-ModApi unit tests, real-cmux integration
  tests, and an opt-in live-host test that drives a real `cmd` permission prompt.

## 0.1.0 - 2026-10-19

- Initial release: turn-complete notifications and permission-wait alerts for cmux.
