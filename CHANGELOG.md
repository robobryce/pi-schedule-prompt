# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Persistent widget visibility setting via a two-layer config (closes #2):
  - Global: `~/.pi/agent/schedule-prompts-settings.json` — manual user defaults
  - Project: `<cwd>/.pi/schedule-prompts-settings.json` — written by the UI
  - Project overrides global on load; survives package upgrades
- `Settings` submenu in `/schedule-prompt` displaying the current widget visibility state live in the row label, with redraw after each change

### Changed
- Replaced "Toggle Widget Visibility" menu item with the new `Settings` submenu — the menu itself is the source of truth for current state, removing the need for a success toast
- Schedule input (`/schedule-prompt → Add New Job`) is trimmed before validation, so pasted strings with surrounding whitespace validate cleanly
- Package description updated to reference "Pi's Heartbeat"

### Removed
- Success toast on widget visibility toggle (the menu shows the new state directly). The "session only; failed to persist" warning toast is retained because it's the only signal the user couldn't otherwise observe.
- Dead `session_switch` / `session_fork` listeners — those event names don't exist in pi's `ExtensionEvent` API (the real events are `session_before_switch` / `session_before_fork`), so the handlers never fired and `session_start` already covers the reload/new/resume/fork cases (#3)

### Fixed
- Scheduler no longer leaks croner timers across `session_start` (which fires on reload/resume/fork too): `initializeSession` is now idempotent and tears down any prior scheduler/widget before creating new ones, eliminating duplicate fires of recurring jobs in long-lived sessions (#3)
- `runCount` now advances on every fire: `executeJob` re-reads the job from storage instead of using the closure-captured snapshot, which previously kept writing the same stale `snapshot + 1` value (#3)

---

Earlier releases (`v0.1.0`–`v0.1.2`): see git tags.
