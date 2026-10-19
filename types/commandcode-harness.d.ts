// Local stub for the subset of the Command Code ModApi this mod uses.
// The real types ship with Command Code and are not published to npm.
declare module '@commandcode/harness' {
	export interface Disposable {
		dispose(): void;
	}

	export interface PermissionRequest {
		toolName: string;
		input?: Record<string, unknown>;
		description?: string | null;
		isSafetyPrompt?: boolean;
	}

	export interface RunEndEvent {
		result: {
			finalText?: string | null;
			stopReason: string;
		};
	}

	export interface ModHooks {
		onPermissionRequest?(
			request: PermissionRequest,
		): 'allow' | 'deny' | undefined;
		onRunEnd?(event: RunEndEvent): void | Promise<void>;
	}

	export interface ExecResult {
		stdout: string;
		stderr: string;
		code: number;
	}

	export interface ModApi {
		readonly cwd: string;
		readonly clock: {
			after(ms: number, callback: () => void): Disposable;
			every(ms: number, callback: () => void): Disposable;
		};
		hooks(hooks: ModHooks): Disposable;
		on(
			event: 'tool_running',
			handler: (event: {toolName: string}) => void,
		): Disposable;
		on(
			event: 'tool_denied' | 'tool_hook_blocked' | 'run_end',
			handler: (event: unknown) => void,
		): Disposable;
		exec(input: {
			command: string;
			args?: string[];
			cwd?: string;
		}): Promise<ExecResult>;
	}
}
