import type {ModApi} from '@commandcode/harness';

const NOTIFY_TIMEOUT_MS = 2_000;
const PROMPT_GRACE_MS = 8_000;

interface PendingPrompt {
	toolName: string;
	body: string;
	timer: ReturnType<typeof setTimeout>;
}

function projectName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? cwd;
}

function oneLine(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function promptBody(
	toolName: string,
	input: Record<string, unknown>,
	isSafetyPrompt: boolean,
): string {
	const path = typeof input.file_path === 'string' ? input.file_path : '';
	let what: string;
	switch (toolName) {
		case 'shell_command':
			what = 'Shell command is waiting for approval';
			break;
		case 'write_file':
			what = path ? `Write ${path}` : 'Write is waiting for approval';
			break;
		case 'edit_file':
			what = path ? `Edit ${path}` : 'Edit is waiting for approval';
			break;
		case 'read_file':
			what = path ? `Read ${path}` : 'Read is waiting for approval';
			break;
		default:
			what = `${toolName} is waiting for approval`;
	}
	return oneLine(isSafetyPrompt ? `Safety approval: ${what}` : what);
}

async function notify(
	cmd: ModApi,
	title: string,
	subtitle: string,
	body: string,
): Promise<void> {
	// Only notify when the session runs inside a cmux-managed surface.
	if (!process.env.CMUX_SURFACE_ID) return;

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>(resolve => {
		timer = setTimeout(resolve, NOTIFY_TIMEOUT_MS);
	});

	try {
		await Promise.race([
			cmd
				.exec({
					command: 'cmux',
					args: ['notify', '--title', title, '--subtitle', subtitle, '--body', body],
				})
				.then(() => undefined)
				.catch(() => undefined),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export default function (cmd: ModApi): void {
	const project = projectName(cmd.cwd);
	const pending: PendingPrompt[] = [];

	const cancel = (toolName?: string): void => {
		for (let i = pending.length - 1; i >= 0; i--) {
			if (toolName !== undefined && pending[i].toolName !== toolName) continue;
			clearTimeout(pending[i].timer);
			pending.splice(i, 1);
		}
	};

	// A real prompt blocks execution, so the tool only starts once a person
	// answers. Auto-accepted calls start on their own; letting the grace window
	// elapse before alerting avoids notifying for those.
	cmd.on('tool_running', ({toolName}) => cancel(toolName));
	cmd.on('tool_denied', () => cancel());
	cmd.on('tool_hook_blocked', () => cancel());
	cmd.on('run_end', () => cancel());

	cmd.hooks({
		onPermissionRequest({toolName, input, isSafetyPrompt}) {
			const body = promptBody(toolName, input ?? {}, isSafetyPrompt);
			const timer = setTimeout(() => {
				const index = pending.findIndex(entry => entry.timer === timer);
				if (index === -1) return;
				pending.splice(index, 1);
				void notify(cmd, 'Command Code — approval needed', project, body);
			}, PROMPT_GRACE_MS);

			pending.push({toolName, body, timer});
			return undefined;
		},

		async onRunEnd({result}) {
			cancel();
			if (result.stopReason === 'interrupted') return;
			const body = result.finalText?.trim()
				? oneLine(result.finalText)
				: `Run ended: ${result.stopReason}`;
			await notify(cmd, 'Command Code — done', project, body);
		},
	});
}
