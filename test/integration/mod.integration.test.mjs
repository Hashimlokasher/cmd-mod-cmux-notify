import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createJiti} from 'jiti';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const jiti = createJiti(import.meta.url);
const loadMod = async () => (await jiti.import('../../index.ts')).default;

const hasCmux = (() => {
	try {
		execFileSync('cmux', ['ping'], {stdio: 'ignore'});
		return true;
	} catch {
		return false;
	}
})();

const hasCmd = (() => {
	try {
		execFileSync('cmd', ['--version'], {stdio: 'ignore'});
		return true;
	} catch {
		return false;
	}
})();

const skipReason =
	process.env.CMUX_INTEGRATION !== '1'
		? 'set CMUX_INTEGRATION=1 to run'
		: !process.env.CMUX_SURFACE_ID
			? 'not inside a cmux surface'
			: !hasCmux
				? 'cmux CLI not available'
				: false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createRealHarness(cwd) {
	const hooks = {};
	const events = new Map();

	const cmd = {
		cwd,
		hooks(value) {
			Object.assign(hooks, value);
		},
		on(event, handler) {
			events.set(event, handler);
			return {dispose() {}};
		},
		async exec({command, args}) {
			try {
				const {stdout, stderr} = await execFileAsync(command, args, {
					encoding: 'utf8',
				});
				return {stdout, stderr, code: 0};
			} catch (error) {
				return {
					stdout: error.stdout ?? '',
					stderr: error.stderr ?? '',
					code: error.code ?? 1,
				};
			}
		},
		clock: {
			after(ms, callback) {
				const timer = setTimeout(callback, ms);
				return {dispose() {clearTimeout(timer);}};
			},
		},
	};

	return {cmd, hooks, events};
}

async function listNotifications() {
	const {stdout} = await execFileAsync('cmux', ['list-notifications', '--json'], {
		encoding: 'utf8',
	});
	return JSON.parse(stdout);
}

async function cleanup(subtitle) {
	for (const notification of await listNotifications()) {
		if (notification.subtitle !== subtitle) continue;
		await execFileAsync('cmux', ['dismiss-notification', '--id', notification.id], {
			encoding: 'utf8',
		}).catch(() => {});
	}
}

test(
	'real cmux: approval alert posts and is dismissed when the tool starts',
	{skip: skipReason},
	async () => {
		const subtitle = `cmux-it-${process.pid}-${Date.now()}`;
		const harness = createRealHarness(path.join(os.tmpdir(), subtitle));
		const mod = await loadMod();
		mod(harness.cmd);

		try {
			harness.hooks.onPermissionRequest({
				toolName: 'shell_command',
				input: {command: 'echo integration'},
				isSafetyPrompt: false,
			});

			await delay(9_000);

			const posted = (await listNotifications()).filter(
				notification => notification.subtitle === subtitle,
			);
			assert.equal(posted.length, 1, 'approval alert should be posted');
			assert.equal(posted[0].title, 'Command Code — approval needed');
			assert.equal(posted[0].body, 'Shell command is waiting for approval');

			harness.events.get('tool_running')({toolName: 'shell_command'});
			await delay(1_000);

			const remaining = (await listNotifications()).filter(
				notification => notification.subtitle === subtitle,
			);
			assert.deepEqual(remaining, [], 'alert should be dismissed');
		} finally {
			await cleanup(subtitle);
		}
	},
);

test(
	'real cmux: run end posts the final text',
	{skip: skipReason},
	async () => {
		const subtitle = `cmux-it-${process.pid}-${Date.now()}`;
		const marker = `integration-done-${Date.now()}`;
		const harness = createRealHarness(path.join(os.tmpdir(), subtitle));
		const mod = await loadMod();
		mod(harness.cmd);

		try {
			await harness.hooks.onRunEnd({
				result: {finalText: marker, stopReason: 'end_turn'},
			});

			const posted = (await listNotifications()).filter(
				notification => notification.subtitle === subtitle,
			);
			assert.equal(posted.length, 1);
			assert.equal(posted[0].title, 'Command Code — done');
			assert.equal(posted[0].body, marker);
		} finally {
			await cleanup(subtitle);
		}
	},
);

test(
	'cmd mods inspect accepts the package entrypoint',
	{skip: hasCmd ? false : 'cmd not available'},
	() => {
		const output = execFileSync('cmd', ['mods', 'inspect', './index.ts'], {
			cwd: root,
			encoding: 'utf8',
		});
		assert.match(output, /hooks:\s+onPermissionRequest, onRunEnd/);
	},
);
