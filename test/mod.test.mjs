import assert from 'node:assert/strict';
import test, {mock} from 'node:test';
import {createJiti} from 'jiti';

const jiti = createJiti(import.meta.url);
const loadMod = async () => (await jiti.import('../index.ts')).default;

const flush = async () => {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
};

function createHarness({notifyStdout} = {}) {
	const hooks = {};
	const events = new Map();
	const calls = [];
	let nextId = 1;

	const cmd = {
		cwd: '/Users/test/project',
		hooks(value) {
			Object.assign(hooks, value);
		},
		on(event, handler) {
			events.set(event, handler);
			return {dispose() {}};
		},
		async exec({command, args}) {
			calls.push({command, args});
			if (command === 'cmux' && args[0] === 'notify') {
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

function useTimers(t) {
	mock.timers.enable({apis: ['setTimeout']});
	t.after(() => mock.timers.reset());
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

test('auto-accepted calls stay silent', async t => {
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

	mock.timers.tick(8000);
	await flush();

	assert.deepEqual(notifications(harness.calls), []);
	assert.deepEqual(dismissals(harness.calls), []);
});

test('a prompt notifies only after the grace window', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {command: 'touch report.txt'},
		isSafetyPrompt: false,
	});

	mock.timers.tick(7999);
	await flush();
	assert.equal(notifications(harness.calls).length, 0);

	mock.timers.tick(1);
	await flush();

	assert.deepEqual(notifications(harness.calls), [
		{
			title: 'Command Code — approval needed',
			subtitle: 'project',
			body: 'Shell command is waiting for approval',
			json: true,
		},
	]);
});

test('dismisses the exact alert when the tool starts', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {command: 'touch report.txt'},
		isSafetyPrompt: false,
	});
	mock.timers.tick(8000);
	await flush();
	assert.equal(notifications(harness.calls).length, 1);

	harness.events.get('tool_running')({toolName: 'shell_command'});
	await flush();

	assert.deepEqual(dismissals(harness.calls), ['notification-1']);
});

test('denial before the window cancels the alert', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	harness.events.get('tool_denied')();

	mock.timers.tick(8000);
	await flush();

	assert.deepEqual(notifications(harness.calls), []);
	assert.deepEqual(dismissals(harness.calls), []);
});

test('a hook block cancels the alert', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'write_file',
		input: {file_path: '/tmp/report.txt'},
		isSafetyPrompt: false,
	});
	harness.events.get('tool_hook_blocked')();

	mock.timers.tick(8000);
	await flush();

	assert.deepEqual(notifications(harness.calls), []);
});

test('file tools include the path in the body', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'write_file',
		input: {file_path: '/tmp/report.txt'},
		isSafetyPrompt: false,
	});
	mock.timers.tick(8000);
	await flush();

	assert.equal(
		notifications(harness.calls)[0].body,
		'Write /tmp/report.txt',
	);
});

test('safety prompts are labelled', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'read_file',
		input: {file_path: '~/.ssh/id_rsa'},
		isSafetyPrompt: true,
	});
	mock.timers.tick(8000);
	await flush();

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
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	mock.timers.tick(8000);
	await flush();

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
	const harness = createHarness();
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
	mock.timers.tick(8000);
	await flush();

	const posted = notifications(harness.calls);
	assert.equal(posted.length, 1);
	assert.equal(posted[0].body, 'Write /tmp/report.txt');
});

test('malformed notify output is ignored', async t => {
	useTimers(t);
	const mod = await loadMod();
	const harness = createHarness({notifyStdout: 'not-json'});
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	mock.timers.tick(8000);
	await flush();

	assert.equal(notifications(harness.calls).length, 1);

	harness.events.get('tool_running')({toolName: 'shell_command'});
	await flush();

	assert.deepEqual(dismissals(harness.calls), []);
});

test('is a no-op outside cmux', async t => {
	useTimers(t);
	delete process.env.CMUX_SURFACE_ID;

	const mod = await loadMod();
	const harness = createHarness();
	mod(harness.cmd);

	harness.hooks.onPermissionRequest({
		toolName: 'shell_command',
		input: {},
		isSafetyPrompt: false,
	});
	mock.timers.tick(8000);
	await flush();

	await harness.hooks.onRunEnd({
		result: {finalText: 'done', stopReason: 'end_turn'},
	});
	await flush();

	assert.deepEqual(harness.calls, []);
});
