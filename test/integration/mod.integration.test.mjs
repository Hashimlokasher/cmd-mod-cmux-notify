import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import fs from 'node:fs';
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

function createScreenShim(screen) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmux-screen-shim-'));
	const realCmux = execFileSync('which', ['cmux'], {encoding: 'utf8'}).trim();
	const script = [
		'#!/bin/sh',
		'if [ "$1" = "read-screen" ]; then',
		"  cat <<'CMUX_SCREEN'",
		screen,
		'CMUX_SCREEN',
		'  exit 0',
		'fi',
		`exec '${realCmux}' "$@"`,
		'',
	].join('\n');
	const file = path.join(dir, 'cmux');
	fs.writeFileSync(file, script, {mode: 0o755});
	return dir;
}

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

async function waitForNotifications(subtitle, predicate, timeoutMs = 6_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const matches = (await listNotifications()).filter(
			notification => notification.subtitle === subtitle,
		);
		if (predicate(matches) || Date.now() >= deadline) return matches;
		await delay(250);
	}
}

test(
	'real cmux: screen-detected approval alert posts and is dismissed',
	{skip: skipReason},
	async () => {
		const subtitle = `cmux-it-${process.pid}-${Date.now()}`;
		const shimDir = createScreenShim(
			'Execute Shell Command\nCommand Code needs to execute touch report.txt.',
		);
		const originalPath = process.env.PATH;
		process.env.PATH = `${shimDir}:${originalPath}`;

		const harness = createRealHarness(path.join(os.tmpdir(), subtitle));
		const mod = await loadMod();
		mod(harness.cmd);

		try {
			harness.hooks.onPermissionRequest({
				toolName: 'shell_command',
				input: {command: 'touch report.txt'},
				isSafetyPrompt: false,
			});

			const posted = await waitForNotifications(subtitle, matches =>
				matches.some(notification => notification.title.includes('approval')),
			);
			assert.equal(posted.length, 1, 'approval alert should be posted');
			assert.equal(posted[0].title, 'Command Code — approval needed');
			assert.equal(posted[0].body, 'Shell command is waiting for approval');

			harness.events.get('tool_running')({toolName: 'shell_command'});

			const remaining = await waitForNotifications(
				subtitle,
				matches => matches.length === 0,
				4_000,
			);
			assert.deepEqual(remaining, [], 'alert should be dismissed');
		} finally {
			process.env.PATH = originalPath;
			fs.rmSync(shimDir, {recursive: true, force: true});
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

			const posted = await waitForNotifications(subtitle, matches =>
				matches.some(notification => notification.title.includes('done')),
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
