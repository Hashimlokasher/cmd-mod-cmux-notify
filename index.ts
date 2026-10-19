import type {ModApi} from '@commandcode/harness';

const NOTIFY_TIMEOUT_MS = 2_000;
const PROMPT_CHECK_MS = 1_500;
const PROMPT_RECHECK_MS = 2_500;
const PROMPT_FINAL_CHECK_MS = 2_000;
const FALLBACK_GRACE_MS = 8_000;

const CHECK_DELAYS = [
	PROMPT_CHECK_MS,
	PROMPT_RECHECK_MS,
	PROMPT_FINAL_CHECK_MS,
];

const PROMPT_MARKERS = [
	'Execute Shell Command',
	'Command Code needs to execute',
	'Enter plan mode for read-only exploration and planning?',
	'Enter act mode for',
	'Approve ctrl+a',
	'Run cmd --yolo to bypass all permissions',
	'Press ctrl+e to explain this command',
];

interface Disposable {
	dispose(): void;
}

interface PendingPrompt {
	toolName: string;
	body: string;
	timers: Disposable[];
	fired: boolean;
	canceled: boolean;
	notificationId?: string;
}

interface CmuxResult {
	stdout?: string;
	stderr?: string;
	code?: number;
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

function showsPrompt(screen: string): boolean {
	return PROMPT_MARKERS.some(marker => screen.includes(marker));
}

async function cmux(
	cmd: ModApi,
	args: string[],
): Promise<CmuxResult | undefined> {
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

async function readScreen(cmd: ModApi): Promise<string | undefined> {
	const result = await cmux(cmd, ['read-screen', '--lines', '40']);
	if (!result || result.code !== 0 || typeof result.stdout !== 'string') {
		return undefined;
	}
	return result.stdout;
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

	const clearTimers = (entry: PendingPrompt): void => {
		for (const timer of entry.timers) timer.dispose();
		entry.timers = [];
	};

	const remove = (entry: PendingPrompt): void => {
		const index = pending.indexOf(entry);
		if (index !== -1) pending.splice(index, 1);
	};

	const schedule = (
		entry: PendingPrompt,
		ms: number,
		callback: () => void,
	): void => {
		entry.timers.push(cmd.clock.after(ms, callback));
	};

	const post = async (entry: PendingPrompt): Promise<void> => {
		clearTimers(entry);
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

	const check = async (
		entry: PendingPrompt,
		attempt: number,
	): Promise<void> => {
		if (entry.canceled || entry.fired) return;

		const screen = await readScreen(cmd);
		if (entry.canceled || entry.fired) return;

		// If the screen cannot be read, leave the fallback timer in place.
		if (screen === undefined) return;

		if (showsPrompt(screen)) {
			entry.fired = true;
			void post(entry);
			return;
		}

		if (attempt + 1 < CHECK_DELAYS.length) {
			schedule(entry, CHECK_DELAYS[attempt + 1], () => {
				void check(entry, attempt + 1);
			});
			return;
		}

		// Three readable checks and no prompt: the host auto-accepted.
		entry.canceled = true;
		clearTimers(entry);
		remove(entry);
	};

	const start = (entry: PendingPrompt): void => {
		schedule(entry, PROMPT_CHECK_MS, () => {
			void check(entry, 0);
		});

		// If the screen cannot be read, fall back to the conservative timer.
		schedule(entry, FALLBACK_GRACE_MS, () => {
			if (entry.canceled || entry.fired) return;
			entry.fired = true;
			void post(entry);
		});
	};

	const cancel = (toolName?: string): void => {
		for (let i = pending.length - 1; i >= 0; i--) {
			const entry = pending[i];
			if (toolName !== undefined && entry.toolName !== toolName) continue;

			entry.canceled = true;
			clearTimers(entry);

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
	// answers. Auto-accepted calls start on their own; the screen checks
	// distinguish the two long before the fallback timer.
	cmd.on('tool_running', ({toolName}) => cancel(toolName));
	cmd.on('tool_denied', () => cancel());
	cmd.on('tool_hook_blocked', () => cancel());
	cmd.on('run_end', () => cancel());

	cmd.hooks({
		onPermissionRequest({toolName, input, isSafetyPrompt}) {
			const entry: PendingPrompt = {
				toolName,
				body: promptBody(toolName, input ?? {}, isSafetyPrompt ?? false),
				timers: [],
				fired: false,
				canceled: false,
			};

			pending.push(entry);
			start(entry);
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
