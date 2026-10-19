import type {ModApi} from '@commandcode/harness';

const NOTIFY_TIMEOUT_MS = 2_000;
const PROMPT_GRACE_MS = 8_000;

interface Disposable {
	dispose(): void;
}

interface PendingPrompt {
	toolName: string;
	body: string;
	timer?: Disposable;
	fired: boolean;
	canceled: boolean;
	notificationId?: string;
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

async function cmux(
	cmd: ModApi,
	args: string[],
): Promise<{stdout?: string} | undefined> {
	// Only run when the session is inside a cmux-managed surface.
	if (!process.env.CMUX_SURFACE_ID) return undefined;

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>(resolve => {
		timer = setTimeout(() => resolve(undefined), NOTIFY_TIMEOUT_MS);
	});

	try {
		return await Promise.race([
			cmd.exec({command: 'cmux', args}).catch(() => undefined),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function notify(
	cmd: ModApi,
	title: string,
	subtitle: string,
	body: string,
): Promise<string | undefined> {
	const result = await cmux(cmd, [
		'notify',
		'--title',
		title,
		'--subtitle',
		subtitle,
		'--body',
		body,
		'--json',
	]);
	if (!result?.stdout) return undefined;

	try {
		const parsed = JSON.parse(result.stdout) as {id?: unknown};
		return typeof parsed.id === 'string' ? parsed.id : undefined;
	} catch {
		return undefined;
	}
}

async function dismiss(cmd: ModApi, id: string): Promise<void> {
	await cmux(cmd, ['dismiss-notification', '--id', id]);
}

export default function (cmd: ModApi): void {
	const project = projectName(cmd.cwd);
	const pending: PendingPrompt[] = [];

	const remove = (entry: PendingPrompt): void => {
		const index = pending.indexOf(entry);
		if (index !== -1) pending.splice(index, 1);
	};

	const post = async (entry: PendingPrompt): Promise<void> => {
		const id = await notify(
			cmd,
			'Command Code — approval needed',
			project,
			entry.body,
		);
		entry.notificationId = id;

		if (entry.canceled || !id) {
			if (entry.canceled && id) await dismiss(cmd, id);
			remove(entry);
		}
	};

	const cancel = (toolName?: string): void => {
		for (let i = pending.length - 1; i >= 0; i--) {
			const entry = pending[i];
			if (toolName !== undefined && entry.toolName !== toolName) continue;

			entry.canceled = true;
			entry.timer?.dispose();

			if (!entry.fired) {
				pending.splice(i, 1);
				continue;
			}

			if (entry.notificationId) {
				void dismiss(cmd, entry.notificationId);
				pending.splice(i, 1);
			}
			// Otherwise the notification request is still in flight; post()
			// dismisses it when the id arrives.
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
			const entry: PendingPrompt = {
				toolName,
				body,
				fired: false,
				canceled: false,
			};

			entry.timer = cmd.clock.after(PROMPT_GRACE_MS, () => {
				entry.fired = true;
				void post(entry);
			});

			pending.push(entry);
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
