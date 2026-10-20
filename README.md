# cmd-mod-cmux-notify

[![CI](https://github.com/Hashimlokasher/cmd-mod-cmux-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/Hashimlokasher/cmd-mod-cmux-notify/actions/workflows/ci.yml)

cmux notifications for [Command Code](https://commandcode.ai): a macOS banner when a turn
finishes, and an alert when a permission prompt is waiting for you.

This is a [Command Code mod](https://commandcode.ai/docs/mods) for
[cmux](https://cmux.com). It only acts when Command Code is running inside a cmux surface, and
it never answers a permission prompt.

## What it does

- **Turn finished** — notifies with the final assistant message (truncated to 200 characters).
  Interrupted runs are skipped.
- **Approval needed** — when a permission prompt is visible in the cmux pane, notifies with
  the tool and file path where available. The alert is dismissed automatically when the tool
  starts, is denied, is blocked, or the run ends. The mod returns `undefined`, so you always
  decide.

Auto-accepted calls stay quiet: the alert is cancelled as soon as the tool starts, is denied,
is blocked by a hook, or the run ends, and three readable screen checks with no prompt cancel
it earlier. The 8-second fallback only applies when the cmux screen cannot be read.

Shell command contents are never included in a notification, only "Shell command is waiting
for approval".

## Requirements

- Command Code with mods support (`cmd mods --help`)
- macOS — cmux is a macOS terminal
- cmux, with Command Code launched inside a cmux terminal
- `cmux` on `PATH` (the app ships it at `/Applications/cmux.app/Contents/Resources/bin/cmux`)

The mod has no runtime dependencies or build step. The test suite uses `jiti` as a dev
dependency.

## Install

From the hub or GitHub:

```bash
cmd mods add Hashimlokasher/cmd-mod-cmux-notify -g
```

Pin a release instead of tracking `main`:

```bash
cmd mods add Hashimlokasher/cmd-mod-cmux-notify@v0.2.0 -g
```

Try it without installing:

```bash
cmd --mod ./index.ts
```

Drop `index.ts` into `~/.commandcode/mods/` for a user-scope install without a package.

## Managing the mod

These are the standard Command Code mod commands. `-g` means user scope; without it, the
command writes project scope.

```bash
cmd mods list                                      # show installed mods and their origin
cmd mods inspect ./index.ts                        # what it hooks, registers, and can reach
cmd mods update                                    # reinstall missing/pinned sources
cmd mods disable cmd-mod-cmux-notify -g            # disable without removing
cmd mods enable cmd-mod-cmux-notify -g             # enable it again
cmd mods remove cmd-mod-cmux-notify                # remove the package
cmd mods remove Hashimlokasher/cmd-mod-cmux-notify # remove by source instead of name
cmd --safe-mode                                    # one session with built-in mods only
```

The installed mod name is `cmd-mod-cmux-notify` (from the package), while the hub card is
titled `cmux-notify`. Use `cmd-mod-cmux-notify` with `disable`, `enable`, and `remove`, or use
the full source.

Mods load once per process. After installing, updating, enabling, or disabling, start a new
session or run `/reload`. User-scope mods load without a workspace trust prompt; project-scope
mods load only after the workspace is trusted.

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

## Troubleshooting

- **No notifications at all** — confirm `echo "$CMUX_SURFACE_ID"` is non-empty and `cmux ping`
  returns `PONG`. Outside a cmux surface the mod is a no-op.
- **No desktop banner** — check macOS System Settings → Notifications → cmux. The notification
  still appears in cmux's Notifications panel, sidebar badge, and pane ring if banners are off.
- **The mod is not loaded** — `cmd mods list` should show
  `cmd-mod-cmux-notify · user · from git:...`. If it does not, run `cmd mods update`, then
  start a new session or `/reload`.
- **No approval alert** — the prompt must stay visible past the first screen check (1.5s). A
  prompt answered immediately is not notified. If Command Code's prompt wording changes, update
  `PROMPT_MARKERS` in `index.ts`.
- **Debugging** — run `cmd --debug` and tail `~/.commandcode/logs/command.log`; the log records
  mod loading, hook evaluation, and `mod_error` events.

## Security and trust

A mod is arbitrary code and runs with your permissions; there is no sandbox. Inspect before
installing:

```bash
cmd mods inspect ./index.ts
```

This mod runs only `cmux notify`, `cmux read-screen`, and `cmux dismiss-notification` through
`cmd.exec`. It makes no network calls, does not read shell command text into notifications,
and never answers a permission prompt. Use `cmd --safe-mode` or
`{"mods": {"disableAll": true}}` to turn off installed mods.

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
cmd --mod ./index.ts          # start a session with this mod loaded
```

Trigger a genuine permission prompt inside cmux and confirm the alert arrives; run a normal
turn and confirm the done notification arrives.

## Limitations

- cmux only, on macOS. Outside a cmux surface (`CMUX_SURFACE_ID` unset) the mod is a no-op.
- Prompt detection matches Command Code's current TUI wording; update `PROMPT_MARKERS` in
  `index.ts` if the wording changes.
- No notification for prompts answered before the first screen check (you are already there).
- The mod API is experimental; pin a release if you depend on it.

## Links

- [Mods hub](https://commandcode.ai/mods)
- [Command Code mods docs](https://commandcode.ai/docs/mods)
- [cmux](https://cmux.com)
- [Releases](https://github.com/Hashimlokasher/cmd-mod-cmux-notify/releases)

## License

MIT
