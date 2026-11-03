/**
 * Completion gate × OpenCode v2 Code Mode `execute` wrapper.
 *
 * On OpenCode 2 every swarm tool is reached through the host's Code Mode
 * `execute` wrapper (input `{ code }`), and each nested `tools.<name>()` call
 * fires its own `tool.execute.before` event under its own name. The completion
 * gate used to judge the outer wrapper by its name — `execute` is neither
 * read-only nor a recovery tool — so while a task sat at `tests_run` it denied
 * every wrapper call, including the one whose nested `update_task_status` was
 * the only way to clear the gate. These tests pin that the marked wrapper
 * passes, that nested calls are still gated under their own names, and that an
 * unmarked `execute` (v1 host, or a non-host tool) keeps the old behavior.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	isCodeModeWrapperCall,
	recordCodeModeWrapperCall,
	resetCodeModeWrapperCalls,
} from '../../../src/hooks/code-mode-wrapper';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { registerV2ToolHooks } from '../../../src/host/v2/hooks';
import type {
	V1HooksSubset,
	V2ToolHookInput,
} from '../../../src/host/v2/types';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	makeConfig,
	recordPlanCriticApproval,
	seedAuthoritativeTaskWorkflow,
} from './_delegation-gate-helpers';

const SESSION = 'test-session';
const WRAPPER_CODE =
	'return await tools.update_task_status({ task_id: "1.1", status: "completed" });';

async function writePlan(dir: string): Promise<void> {
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Code Mode wrapper completion gate',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: ['1.1', '1.2'].map((id) => ({
					id,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `Task ${id}`,
					depends: [],
					files_touched: ['src/foo.ts'],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await recordPlanCriticApproval(dir, plan);
}

async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	return '';
}

let tempDir: string;

beforeEach(async () => {
	resetSwarmState();
	resetCodeModeWrapperCalls();
	tempDir = canonicalMkdtemp('completion-code-mode-');
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	await writePlan(tempDir);
	ensureAgentSession(SESSION).taskWorkflowStates.set('1.1', 'tests_run');
	await seedAuthoritativeTaskWorkflow(tempDir, '1.1', 'tests_run');
});

afterEach(() => {
	resetCodeModeWrapperCalls();
	resetSwarmState();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('completion gate: marked Code Mode wrapper (direct toolBefore)', () => {
	test('an unmarked execute { code } is still denied while 1.1 awaits completion', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const message = await rejectionOf(() =>
			hook.toolBefore(
				{ tool: 'execute', sessionID: SESSION, callID: 'unmarked-1' },
				{ args: { code: WRAPPER_CODE } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
		expect(message).toContain('1.1');
	});

	test('the marked host wrapper passes the completion gate', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		recordCodeModeWrapperCall(SESSION, 'wrapper-1');
		await hook.toolBefore(
			{ tool: 'execute', sessionID: SESSION, callID: 'wrapper-1' },
			{ args: { code: WRAPPER_CODE } },
		);
	});

	test('a mark on one call does not exempt a different execute call', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		recordCodeModeWrapperCall(SESSION, 'wrapper-1');
		const message = await rejectionOf(() =>
			hook.toolBefore(
				{ tool: 'execute', sessionID: SESSION, callID: 'other-call' },
				{ args: { code: WRAPPER_CODE } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});

	test('a mark in another session does not exempt this session', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		recordCodeModeWrapperCall('other-session', 'wrapper-1');
		const message = await rejectionOf(() =>
			hook.toolBefore(
				{ tool: 'execute', sessionID: SESSION, callID: 'wrapper-1' },
				{ args: { code: WRAPPER_CODE } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});

	test('a non-execute call sharing a marked call id is still gated under its own name', async () => {
		// Nested Code Mode calls reuse the wrapper's call id; the exemption is
		// bound to the wrapper's own tool name, so it can never leak to them.
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		recordCodeModeWrapperCall(SESSION, 'shared-1');
		const message = await rejectionOf(() =>
			hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'shared-1' },
				{ args: { subagent_type: 'mega_coder', task_id: '1.2' } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
		expect(message).toContain('1.1');
	});
});

describe('completion gate: real v2 adapter + real delegation gate', () => {
	async function captureBefore() {
		const gate = createDelegationGateHook(makeConfig(), tempDir);
		const hooks = {
			tool: {},
			agent: {},
			config: async () => {},
			event: async () => {},
			dispose: async () => {},
			'tool.execute.before': (
				input: { tool: string; sessionID: string; callID: string },
				output: { args: unknown },
			) => gate.toolBefore(input, output),
		} as unknown as V1HooksSubset;
		let before: ((event: V2ToolHookInput) => unknown) | undefined;
		const ctx = {
			tool: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
				hook: async (
					name: 'execute.before' | 'execute.after',
					cb: (event: V2ToolHookInput) => unknown,
				) => {
					if (name === 'execute.before') before = cb;
					return { dispose: async () => {} };
				},
			},
		};
		await registerV2ToolHooks(ctx as never, hooks, tempDir, []);
		if (!before) throw new Error('execute.before was not registered');
		return before;
	}

	function v2Event(overrides: Partial<V2ToolHookInput>): V2ToolHookInput {
		return {
			tool: 'execute',
			sessionID: SESSION,
			agent: 'architect',
			messageID: 'm1',
			id: 'call-1',
			input: { code: WRAPPER_CODE },
			...overrides,
		} as V2ToolHookInput;
	}

	test('the wrapper and its nested update_task_status for the awaiting task both pass', async () => {
		const before = await captureBefore();
		await before(v2Event({}));
		expect(isCodeModeWrapperCall(SESSION, 'call-1')).toBe(false);
		// The host fires the nested call under its own name with the wrapper's id.
		await before(
			v2Event({
				tool: 'update_task_status',
				input: { task_id: '1.1', status: 'completed' },
			}),
		);
	});

	test('a nested call that would start another task is still denied', async () => {
		const before = await captureBefore();
		await before(
			v2Event({
				input: {
					code: 'return await tools.declare_scope({ taskId: "1.2", files: ["src/bar.ts"] });',
				},
			}),
		);
		const message = await rejectionOf(async () => {
			await before(
				v2Event({
					tool: 'declare_scope',
					input: { taskId: '1.2', files: ['src/bar.ts'] },
				}),
			);
		});
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
		expect(message).toContain('1.1');
	});

	test('a v2 execute without a string code program is not treated as the wrapper', async () => {
		const before = await captureBefore();
		const message = await rejectionOf(async () => {
			await before(v2Event({ id: 'call-2', input: { command: 'ls' } }));
		});
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});
});
