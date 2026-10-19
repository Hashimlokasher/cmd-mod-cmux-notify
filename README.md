# cmd-mod-cmux-notify

cmux notifications for [Command Code](https://commandcode.ai): a macOS banner when a turn
finishes, and an alert when a permission prompt has been waiting for you.

This is a [Command Code mod](https://commandcode.ai/docs/mods) for
[cmux](https://cmux.com). It only acts when Command Code is running inside a cmux surface.

## What it does

- **Turn finished** — notifies with the final assistant message (truncated to 200 characters).
  Interrupted runs are skipped.
- **Approval needed** — when a permission prompt has been waiting for 8 seconds, notifies with
  the tool and file path where available. The mod never answers the prompt; it returns
  `undefined`, so you always decide.

Auto-accepted calls stay quiet: the alert is cancelled as soon as the tool starts, is denied,
is blocked by a hook, or the run ends. The 8-second grace is deliberate — some hosts take a few
seconds to auto-resolve a permission check.

Shell command contents are never included in a notification, only "Shell command is waiting
for approval".

## Requirements

- Command Code with mods support (`cmd mods --help`)
- cmux on macOS, with Command Code launched inside a cmux terminal
- `cmux` on `PATH` (the app ships it at `/Applications/cmux.app/Contents/Resources/bin/cmux`)

No network access, no dependencies, no build step.

## Install

From npm:

```bash
cmd mods add cmd-mod-cmux-notify -g
```

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

- `hooks.onPermissionRequest` schedules a notification after `PROMPT_GRACE_MS` (8s). The
  `tool_running`, `tool_denied`, `tool_hook_blocked`, and `run_end` events cancel it.
- `hooks.onRunEnd` posts the completion notification.
- `cmd.exec({command: 'cmux', args: ['notify', ...]})` sends the notification. cmux resolves
  the target from `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID`, so it lands on the calling pane.
- Every `cmux notify` call is capped at 2 seconds, and failures are ignored.

The grace window and timeout are constants at the top of `index.ts` if you want to tune them.

## Verify

```bash
cmd mods inspect ./index.ts   # hooks: onPermissionRequest, onRunEnd; runs processes
cmd --mod ./index.ts mods list
```

Trigger a genuine permission prompt inside cmux and confirm the alert arrives; run a normal
turn and confirm the done notification arrives.

## Limitations

- cmux only. Outside a cmux surface (`CMUX_SURFACE_ID` unset) the mod is a no-op.
- The approval alert is delayed by the grace window so auto-accepted calls do not notify.
- No notification for prompts answered within the grace window (you are already there).
- The mod API is experimental; pin a version if you depend on it.

## License

MIT
