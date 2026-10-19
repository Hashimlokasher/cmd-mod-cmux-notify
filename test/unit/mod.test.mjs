import assert from 'node:assert/strict';
import test, {mock} from 'node:test';
import {createJiti} from 'jiti';

const jiti = createJiti(import.meta.url);
const loadMod = async () => (await jiti.import('../../index.ts')).default;

const flush = async () => {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
};

function createHarness({
	notifyStdout,
	screens = [''],
	screenFails = false,
	hangNotify = false,
	notifyFails = false,
	notifyDelayMs = 0,
	notifyRejects = false,
	screenRejects = false,
	cwd = '/Users/test/project',
} = {}) {
	const hooks = {};
	const events = new Map();
	const calls = [];
	let nextId = 1;
	let screenIndex = 0;

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
			calls.push({command, args});

			if (command === 'cmux' && args[0] === 'read-screen') {
				if (screenRejects) return Promise.reject(new Error('no screen'));
				if (screenFails) {
					return {stdout: '', stderr: 'screen unavailable', code: 1};
				}
				return {
					stdout: screens[Math.min(screenIndex++, screens.length - 1)] ?? '',
					stderr: '',
					code: 0,
				};
			}

			if (command === 'cmux' && args[0] === 'notify') {
				if (hangNotify) return new Promise(() => {});
				if (notifyRejects) return Promise.reject(new Error('no cmux'));
				if (notifyDelayMs > 0) {
					return new Promise(resolve => {
						setTimeout(() => {
							resolve({
								stdout: JSON.stringify({id: `notification-${nextId++}`}),
								stderr: '',
								code: 0,
							});
						}, notifyDelayMs);
					});
				}
				if (notifyFails) return {stdout: '', stderr: 'nope', code: 1};
				return {
					stdout:
						notifyStdout === undefined
							? JSON.stringify({id: `notification-${nextId++}`})
							: notifyStdout,
					stderr: '',
					code: 0,
				};
			}

			return {stdout: '', stderr: '', code: 0};
		},
		clock: {
			after(ms, callback) {
				const timer = setTimeout(callback, ms);
				return {dispose() {clearTimeout(timer);}};
			},
		},
	};

	return {cmd, hooks, events, calls};
}

function arg(call, flag) {
	const index = call.args.indexOf(flag);
	return index === -1 ? undefined : call.args[index + 1];
}

function notifications(calls) {
	return calls
		.filter(call => call.command === 'cmux' && call.args[0] === 'notify')
		.map(call => ({
			title: arg(call, '--title'),
			subtitle: arg(call, '--subtitle'),
			body: arg(call, '--body'),
			json: call.args.includes('--json'),
		}));
}

function dismissals(calls) {
	return calls
		.filter(call => call.command === 'cmux' && call.args[0] === 'dismiss-notification')
		.map(call => arg(call, '--id'));
}

function screenReads(calls) {
	return calls.filter(call => call.command === 'cmux' && call.args[0] === 'read-screen');
}

function useTimers(t) {
	mock.timers.enable({apis: ['setTimeout']});
	t.after(() => mock.timers.reset());
}

async function tick(ms) {
	mock.timers.tick(ms);
	await flush();
}

test.beforeEach(() => {
	process.env.CMUX_SURFACE_ID = 'test-surface';
});

test.afterEach(() => {
	delete process.env.CMUX_SURFACE_ID;
});

test('registers both hooks and the cancellation events', async () => {
	const mod = await loadMod();
	const harness = createHarness();

	mod(harness.cmd);

	assert.deepEqual(Object.keys(harness.hooks).sort(), [
		'onPermissionRequest',
		'onRunEnd',
	]);
	assert.deepEqual([...harness.events.keys()].sort(), [
		'run_end',
		'tool_denied',
		'tool_hook_blocked',
		'tool_running',
	]);
});

test('auto-accepted calls stay silent and never read the screen', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {command: 'echo hi'},
		isSafetyPrompt: false,
	});
	harness.events.get('tool_running')({toolName: 'shell_command'});

	await tick(8000);

	assert.deepEqual(notifications(harness.calls), []);
	assert.deepEqual(screenReads(harness.calls), []);
});

test('detects the prompt on the first screen check', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {command: 'touch report.txt'},
		isSafetyPrompt: false,
	});

	await tick(1500);

	assert.deepEqual(notifications(harness.calls), [
		{
			title: 'Command Code — approval needed',
			subtitle: 'project',
			body: 'Shell command is waiting for approval',
			json: true,
		},
	]);
	assert.equal(screenReads(harness.calls).length, 1);

	await tick(6500);
	assert.equal(notifications(harness.calls).length, 1, 'fallback should be cleared');
});

test('detects the prompt on the second screen check', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({
		screens: ['Ask your question', 'Command Code needs to execute touch report.txt.'],
	});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});

	await tick(1500);
	assert.equal(notifications(harness.calls).length, 0);

	await tick(2500);
	assert.equal(notifications(harness.calls).length, 1);
	assert.equal(screenReads(harness.calls).length, 2);
});

test('detects the prompt on the final screen check', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({
		screens: ['', '', 'Press ctrl+e to explain this command'],
	});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});

	await tick(1500);
	await tick(2500);
	assert.equal(notifications(harness.calls).length, 0);

	await tick(2000);
	assert.equal(notifications(harness.calls).length, 1);
	assert.equal(screenReads(harness.calls).length, 3);
});

test('three readable checks with no prompt cancel the alert', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Ask your question']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});

	await tick(1500);
	await tick(2500);
	await tick(2000);
	await tick(2000);

	assert.deepEqual(notifications(harness.calls), []);
	assert.equal(screenReads(harness.calls).length, 3);
});

test('falls back when the screen cannot be read', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screenFails: true});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});

	await tick(1500);
	assert.equal(notifications(harness.calls).length, 0);

	await tick(6500);
	assert.equal(notifications(harness.calls).length, 1);
});

test('dismisses the exact alert when the tool starts', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(1500);
	assert.equal(notifications(harness.calls).length, 1);

	harness.events.get('tool_running')({toolName: 'shell_command'});
	await flush();

	assert.deepEqual(dismissals(harness.calls), ['notification-1']);
});

test('denial before the window cancels the alert', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	harness.events.get('tool_denied')();

	await tick(8000);

	assert.deepEqual(notifications(harness.calls), []);
	assert.deepEqual(screenReads(harness.calls), []);
});

test('a hook block cancels the alert', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'write_file',
		input: {file_path: '/tmp/report.txt'},
		isSafetyPrompt: false,
	});
	harness.events.get('tool_hook_blocked')();

	await tick(8000);

	assert.deepEqual(notifications(harness.calls), []);
});

test('file tools include the path in the body', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'write_file',
		input: {file_path: '/tmp/report.txt'},
		isSafetyPrompt: false,
	});
	await tick(1500);

	assert.equal(notifications(harness.calls)[0].body, 'Write /tmp/report.txt');
});

test('safety prompts are labelled', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'read_file',
		input: {file_path: '~/.ssh/id_rsa'},
		isSafetyPrompt: true,
	});
	await tick(1500);

	assert.equal(
		notifications(harness.calls)[0].body,
		'Safety approval: Read ~/.ssh/id_rsa',
	);
});

test('run end posts the final text and skips interrupted runs', async () => {
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	await harness.hooks.onRunEnd({
		result: {finalText: 'All done.\nSecond line', stopReason: 'end_turn'},
	});
	await flush();

	assert.deepEqual(notifications(harness.calls), [
		{
			title: 'Command Code — done',
			subtitle: 'project',
			body: 'All done. Second line',
			json: true,
		},
	]);

	await harness.hooks.onRunEnd({
		result: {finalText: 'ignored', stopReason: 'interrupted'},
	});
	await flush();

	assert.equal(notifications(harness.calls).length, 1);
});

test('run end dismisses a posted approval alert', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(1500);

	await harness.hooks.onRunEnd({
		result: {finalText: 'Approved and finished', stopReason: 'end_turn'},
	});
	await flush();

	assert.deepEqual(dismissals(harness.calls), ['notification-1']);
	assert.equal(notifications(harness.calls).length, 2);
});

test('cancels only the matching tool', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	harness.hooks.onPermissionRequest({
		toolName: 'write_file',
		input: {file_path: '/tmp/report.txt'},
		isSafetyPrompt: false,
	});

	harness.events.get('tool_running')({toolName: 'shell_command'});
	await tick(1500);

	const posted = notifications(harness.calls);
	assert.equal(posted.length, 1);
	assert.equal(posted[0].body, 'Write /tmp/report.txt');
});

test('malformed notify output is ignored', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({
		notifyStdout: 'not-json',
		screens: ['Execute Shell Command'],
	});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(1500);

	assert.equal(notifications(harness.calls).length, 1);

	harness.events.get('tool_running')({toolName: 'shell_command'});
	await flush();

	assert.deepEqual(dismissals(harness.calls), []);
});

test('is a no-op outside cmux', async t => {
	useTimers(t);
	delete process.env.CMUX_SURFACE_ID;

	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(8000);

	await harness.hooks.onRunEnd({
		result: {finalText: 'done', stopReason: 'end_turn'},
	});
	await flush();

	assert.deepEqual(harness.calls, []);
});

test('labels edit, read, write, and unknown tools', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	const cases = [
		{toolName: 'edit_file', input: {file_path: '/tmp/e.txt'}, body: 'Edit /tmp/e.txt'},
		{toolName: 'read_file', input: {}, body: 'Read is waiting for approval'},
		{toolName: 'write_file', input: {}, body: 'Write is waiting for approval'},
		{toolName: 'custom_tool', input: {}, body: 'custom_tool is waiting for approval'},
	];
	for (const item of cases) {
		harness.hooks.onPermissionRequest({
			toolName: item.toolName,
			input: item.input,
			isSafetyPrompt: false,
		});
	}
	await tick(1500);

	const bodies = notifications(harness.calls).map(notification => notification.body);
	for (const item of cases) assert.ok(bodies.includes(item.body), item.body);
});

test('uses the cwd when it has no final path segment', async () => {
	const mod = await loadMod();
	const harness = createHarness({cwd: '/'});
	mod(harness.cmd);

	await harness.hooks.onRunEnd({
		result: {finalText: 'done', stopReason: 'end_turn'},
	});
	await flush();

	assert.equal(notifications(harness.calls)[0].subtitle, '/');
});

test('falls back to the stop reason and truncates long text', async () => {
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	await harness.hooks.onRunEnd({
		result: {finalText: '', stopReason: 'max_turns'},
	});
	await flush();
	assert.equal(notifications(harness.calls)[0].body, 'Run ended: max_turns');

	await harness.hooks.onRunEnd({
		result: {finalText: 'a'.repeat(250), stopReason: 'end_turn'},
	});
	await flush();
	const body = notifications(harness.calls)[1].body;
	assert.equal(body.length, 200);
	assert.ok(body.endsWith('…'));
});

test('times out a hung notify call', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({hangNotify: true});
	mod(harness.cmd);

	const done = harness.hooks.onRunEnd({
		result: {finalText: 'done', stopReason: 'end_turn'},
	});
	await tick(2000);
	await done;

	assert.deepEqual(dismissals(harness.calls), []);
});

test('run_end event dismisses a posted alert', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(1500);

	harness.events.get('run_end')();
	await flush();

	assert.deepEqual(dismissals(harness.calls), ['notification-1']);
});

test('denial after the alert posts dismisses it', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screens: ['Execute Shell Command']});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(1500);
	assert.equal(notifications(harness.calls).length, 1);

	harness.events.get('tool_denied')();
	await flush();

	assert.deepEqual(dismissals(harness.calls), ['notification-1']);
});

test('a failed notify call is harmless', async () => {
	const mod = await loadMod();
	const harness = createHarness({notifyFails: true});
	mod(harness.cmd);

	await harness.hooks.onRunEnd({
		result: {finalText: 'done', stopReason: 'end_turn'},
	});
	await flush();

	assert.deepEqual(dismissals(harness.calls), []);
});

test('dismisses an alert that resolves while the notify is in flight', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({
		screens: ['Execute Shell Command'],
		notifyDelayMs: 500,
	});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(1500);

	harness.events.get('tool_running')({toolName: 'shell_command'});
	await tick(500);
	await flush();

	assert.deepEqual(dismissals(harness.calls), ['notification-1']);
});

test('a rejected notify call is harmless', async () => {
	const mod = await loadMod();
	const harness = createHarness({notifyRejects: true});
	mod(harness.cmd);

	await harness.hooks.onRunEnd({
		result: {finalText: 'done', stopReason: 'end_turn'},
	});
	await flush();

	assert.deepEqual(dismissals(harness.calls), []);
});

test('a rejected screen read falls back to the timer', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({screenRejects: true});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	await tick(1500);
	assert.equal(notifications(harness.calls).length, 0);

	await tick(6500);
	assert.equal(notifications(harness.calls).length, 1);
});
