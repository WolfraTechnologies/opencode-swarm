import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { resetSwarmState } from '../../../src/state';
import {
	executePhaseComplete,
	phaseCompleteCommitInternals,
	phaseCompletePreflightInternals,
	phaseCompleteReceiptInternals,
} from '../../../src/tools/phase-complete';
import type { GateResult } from '../../../src/tools/phase-complete/gates/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { writeRetroBundle } from './_phase-complete-test-helpers';

const original = { ...phaseCompletePreflightInternals };
const originalReceipts = { ...phaseCompleteReceiptInternals };
const originalCommit = { ...phaseCompleteCommitInternals };

const MIB = 1024 * 1024;

function pass(): GateResult {
	return {
		blocked: false,
		agentsDispatched: [],
		agentsMissing: [],
		warnings: [],
	};
}

/**
 * End-to-end through the authoritative transition: the preflight snapshot, the
 * commit-boundary preflight, and the savePlan pre-commit CAS all compute the
 * snapshot identity. A run that completes with evidence larger than the
 * default budget can only happen if EVERY one of those sites passes
 * `phase_complete.snapshot_max_bytes` through.
 */
describe('phase_complete snapshot budget: every call site honours the config key', () => {
	let directory: string;

	beforeEach(() => {
		resetSwarmState();
		directory = canonicalMkdtemp('phase-snapshot-commit-wiring-');
		fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), {
			recursive: true,
		});
		fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		writeRetroBundle(directory, 1, 'pass');
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Snapshot budget wiring',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
			}),
		);
		// 17 MiB of (sparse) evidence: over the 16 MiB default budget.
		const bulk = path.join(directory, '.swarm', 'evidence', 'bulk.json');
		fs.writeFileSync(bulk, '');
		fs.truncateSync(bulk, 17 * MIB);
		Object.assign(phaseCompletePreflightInternals, original);
		Object.assign(phaseCompleteReceiptInternals, originalReceipts);
		Object.assign(phaseCompleteCommitInternals, originalCommit);
		phaseCompletePreflightInternals.runCompletionVerifyGate = async () =>
			pass();
		phaseCompletePreflightInternals.runDriftGate = async () => pass();
		phaseCompletePreflightInternals.runFinalReviewGate = async () => pass();
		phaseCompletePreflightInternals.runHallucinationGate = async () => pass();
		phaseCompletePreflightInternals.runMutationGate = async () => pass();
		phaseCompletePreflightInternals.runPhaseCouncilGate = async () => pass();
		phaseCompletePreflightInternals.runArchitectureSupervisorGate = async () =>
			pass();
		phaseCompletePreflightInternals.runFinalCouncilGate = async () => pass();
	});

	afterEach(() => {
		Object.assign(phaseCompletePreflightInternals, original);
		Object.assign(phaseCompleteReceiptInternals, originalReceipts);
		Object.assign(phaseCompleteCommitInternals, originalCommit);
		resetSwarmState();
		closeProjectDb(directory);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	function writeConfig(extra: Record<string, unknown>): void {
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				knowledge: { enabled: false },
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
					...extra,
				},
			}),
		);
	}

	/** Count real commit-boundary saves; the real savePlan still runs. */
	function countSavePlanCalls(): { calls: number } {
		const counter = { calls: 0 };
		phaseCompleteCommitInternals.savePlan = async (root, plan, options) => {
			counter.calls += 1;
			return originalCommit.savePlan(root, plan, options);
		};
		return counter;
	}

	const planStatus = (): string =>
		JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf8'),
		).phases[0].status;

	test('with the budget raised, a phase with more evidence than the default completes', async () => {
		writeConfig({ snapshot_max_bytes: 32 * MIB });
		const saves = countSavePlanCalls();

		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'snapshot-wiring-raised' },
				directory,
			),
		);

		expect(result.reason).not.toBe('PHASE_PREFLIGHT_STALE');
		expect(result.success).toBe(true);
		// The authoritative plan write ran, so its pre-commit snapshot CAS
		// (the third snapshot call site) computed the identity under the raised
		// budget and agreed with the preflight's.
		expect(saves.calls).toBe(1);
	});

	test('negative control: the same evidence at the default budget is refused with an actionable error', async () => {
		writeConfig({});
		const saves = countSavePlanCalls();

		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'snapshot-wiring-default' },
				directory,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('SNAPSHOT_IDENTITY_ERROR');
		const gate = (
			result.gate_report.entries as Array<{ id: string; detail?: string }>
		).find((entry) => entry.id === 'snapshot_identity');
		expect(gate?.detail).toContain('PHASE_SNAPSHOT_BYTE_LIMIT');
		expect(gate?.detail).toContain('.swarm/evidence/bulk.json');
		expect(gate?.detail).toContain(`${16 * MIB}-byte limit`);
		expect(saves.calls).toBe(0);
		expect(planStatus()).toBe('in_progress');
	});
});
