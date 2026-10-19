import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
	process.env.CMUX_LIVE_HOST !== '1'
		? 'set CMUX_LIVE_HOST=1 to run'
		: process.env.CMUX_INTEGRATION !== '1'
			? 'set CMUX_INTEGRATION=1 to run'
			: !process.env.CMUX_SURFACE_ID
				? 'not inside a cmux surface'
				: !hasCmux
					? 'cmux CLI not available'
					: !hasCmd
						? 'cmd not available'
						: false;

async function cmux(...args) {
	const {stdout} = await execFileAsync('cmux', args, {encoding: 'utf8'});
	return stdout;
}

async function listNotifications() {
	return JSON.parse(await cmux('list-notifications', '--json'));
}

async function waitFor(callback, timeoutMs = 60_000, intervalMs = 500) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await callback();
		if (value || Date.now() >= deadline) return value;
		await delay(intervalMs);
	}
}

test(
	'live host: real cmd prompt is detected, notified, and dismissed',
	{skip: skipReason, timeout: 180_000},
	async () => {
		const id = `cmux-live-${process.pid}-${Date.now()}`;
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
		const subtitle = path.basename(projectDir);
		const targetFile = path.join(os.homedir(), `${id}.txt`);
		let workspaceRef;
		let surfaceRef;

		try {
			const created = await cmux(
				'new-workspace',
				'--name',
				id,
				'--cwd',
				projectDir,
				'--command',
				'cmd --trust',
			);
			workspaceRef = created.match(/workspace:\d+/)?.[0];
			assert.ok(workspaceRef, 'workspace should be created');

			surfaceRef = await waitFor(async () => {
				const surfaces = await cmux(
					'list-pane-surfaces',
					'--workspace',
					workspaceRef,
				);
				return surfaces.match(/surface:\d+/)?.[0];
			}, 30_000);
			assert.ok(surfaceRef, 'surface should appear');

			const ready = await waitFor(async () => {
				const screen = await cmux(
					'read-screen',
					'--surface',
					surfaceRef,
					'--lines',
					'30',
				);
				return /Ask your question|Command Code v/.test(screen)
					? screen
					: undefined;
			}, 60_000);
			assert.ok(ready, 'cmd should be ready');

			await cmux(
				'send',
				'--surface',
				surfaceRef,
				`Call the shell_command tool to run: touch ${targetFile}. You must call the tool; do not just answer.\n`,
			);
			await delay(1_000);
			await cmux('send-key', '--surface', surfaceRef, 'enter');

			const promptScreen = await waitFor(async () => {
				const screen = await cmux(
					'read-screen',
					'--surface',
					surfaceRef,
					'--lines',
					'40',
				);
				return /Command Code needs to execute|Execute Shell Command/.test(
					screen,
				)
					? screen
					: undefined;
			}, 90_000);
			assert.ok(promptScreen, 'permission prompt should appear');

			const approval = await waitFor(async () => {
				const notifications = await listNotifications();
				return notifications.find(
					notification =>
						notification.subtitle === subtitle &&
						notification.title.includes('approval'),
				);
			}, 15_000);
			assert.ok(approval, 'approval notification should be posted');

			await cmux('send', '--surface', surfaceRef, '1\n');
			await delay(500);
			await cmux('send-key', '--surface', surfaceRef, 'enter');

			const dismissed = await waitFor(async () => {
				const notifications = await listNotifications();
				return notifications.some(
					notification => notification.id === approval.id,
				)
					? undefined
					: true;
			}, 15_000);
			assert.ok(dismissed, 'approval notification should be dismissed');

			const done = await waitFor(async () => {
				const notifications = await listNotifications();
				return notifications.find(
					notification =>
						notification.subtitle === subtitle &&
						notification.title.includes('done'),
				);
			}, 30_000);
			assert.ok(done, 'done notification should be posted');
		} finally {
			try {
				for (const notification of await listNotifications()) {
					if (notification.subtitle !== subtitle) continue;
					await execFileAsync(
						'cmux',
						['dismiss-notification', '--id', notification.id],
						{encoding: 'utf8'},
					).catch(() => {});
				}
			} catch {
				// best effort
			}

			if (surfaceRef) {
				await execFileAsync('cmux', ['send', '--surface', surfaceRef, '/exit\n'], {
					encoding: 'utf8',
				}).catch(() => {});
				await delay(500);
				await execFileAsync(
					'cmux',
					['send-key', '--surface', surfaceRef, 'enter'],
					{encoding: 'utf8'},
				).catch(() => {});
			}

			if (workspaceRef) {
				await execFileAsync(
					'cmux',
					['close-workspace', '--workspace', workspaceRef, '--force'],
					{encoding: 'utf8'},
				).catch(() => {});
			}

			fs.rmSync(projectDir, {recursive: true, force: true});
			fs.rmSync(targetFile, {force: true});
		}
	},
);
