# cmd-mod-cmux-notify

[![CI](https://github.com/Hashimlokasher/cmd-mod-cmux-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/Hashimlokasher/cmd-mod-cmux-notify/actions/workflows/ci.yml)

cmux notifications for [Command Code](https://commandcode.ai): a macOS banner when a turn
finishes, and an alert when a permission prompt has been waiting for you.

This is a [Command Code mod](https://commandcode.ai/docs/mods) for
[cmux](https://cmux.com). It only acts when Command Code is running inside a cmux surface.

## What it does

- **Turn finished** — notifies with the final assistant message (truncated to 200 characters).
  Interrupted runs are skipped.
- **Approval needed** — when a permission prompt is visible in the cmux pane, notifies with
  the tool and file path where available. The alert is dismissed automatically when the tool
  starts, is denied, is blocked, or the run ends. The mod never answers the prompt; it returns
  `undefined`, so you always decide.

Auto-accepted calls stay quiet: the alert is cancelled as soon as the tool starts, is denied,
is blocked by a hook, or the run ends, and three readable screen checks with no prompt cancel
it earlier. The 8-second fallback only applies when the cmux screen cannot be read.

Shell command contents are never included in a notification, only "Shell command is waiting
for approval".

## Requirements

- Command Code with mods support (`cmd mods --help`)
- cmux on macOS, with Command Code launched inside a cmux terminal
- `cmux` on `PATH` (the app ships it at `/Applications/cmux.app/Contents/Resources/bin/cmux`)

The mod has no runtime dependencies or build step. The test suite uses `jiti` as a dev
 dependency.

## Install

From GitHub:

```bash
cmd mods add Hashimlokasher/cmd-mod-cmux-notify -g
```

Or try it without installing:

```bash
cmd --mod ./index.ts
```

Drop `index.ts` into `~/.commandcode/mods/` for a user-scope install without a package.

## How it works

- `hooks.onPermissionRequest` schedules screen checks at 1.5s, 4s, and 6s. Each check runs
  `cmux read-screen` and looks for Command Code's permission-prompt markers. If the prompt is
  visible, the notification is posted immediately. If the screen is readable and no prompt is
  visible, the call is treated as auto-accepted and the alert is cancelled. If the screen
  cannot be read, an 8s fallback timer posts the notification conservatively.
- `tool_running`, `tool_denied`, `tool_hook_blocked`, and `run_end` cancel pending checks. If
  an alert was already posted, its id (from `cmux notify --json`) is passed to
  `cmux dismiss-notification`, so a resolved prompt leaves no stale alert.
- `hooks.onRunEnd` posts the completion notification.
- `cmd.exec({command: 'cmux', args: [...]})` runs the CLI. cmux resolves the target from
  `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID`, so notifications land on the calling pane.
- Every CLI call is capped at 2 seconds, and failures are ignored.

The check delays and timeout are constants at the top of `index.ts` if you want to tune them.

## Development

```bash
npm install --include=dev
npm test
npm run typecheck
npm run lint
npm run test:coverage

# Inside a cmux terminal. Posts real notifications, then cleans them up.
npm run test:integration

# Opt-in: creates a temporary cmux workspace and runs a real cmd turn.
npm run test:live-host
```

The unit tests use Node's built-in test runner with a mock `ModApi` and mock timers. They do
not need cmux or Command Code. CI runs `npm ci --include=dev`, `npm run typecheck`,
`npm run lint`, and `npm run test:coverage` on Ubuntu.

The integration tests exercise the real `cmux notify` / `dismiss-notification` path and
`cmd mods inspect`; they skip automatically unless `CMUX_INTEGRATION=1` and `CMUX_SURFACE_ID`
are set. `npm run test:live-host` additionally creates a temporary cmux workspace, runs a real
`cmd --trust` turn, and verifies the full permission-prompt flow end to end.

## Verify

```bash
cmd mods inspect ./index.ts   # hooks: onPermissionRequest, onRunEnd; runs processes
cmd --mod ./index.ts mods list
```

Trigger a genuine permission prompt inside cmux and confirm the alert arrives; run a normal
turn and confirm the done notification arrives.

## Limitations

- cmux only. Outside a cmux surface (`CMUX_SURFACE_ID` unset) the mod is a no-op.
- Prompt detection matches Command Code's current TUI wording; update `PROMPT_MARKERS` in
  `index.ts` if the wording changes.
- No notification for prompts answered before the first screen check (you are already there).
- The mod API is experimental; pin a version if you depend on it.

## License

MIT
