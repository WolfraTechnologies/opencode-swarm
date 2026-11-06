import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

const { phase_complete } = await import('../../../src/tools/phase-complete');

interface GateEntry {
	id: string;
	code: string;
	outcome: string;
	detail?: string;
}

describe('phase_complete snapshot_identity gate: budget wiring', () => {
	let tempDir: string;
	let originalCwd: string;
	let cleanupEnv: (() => void) | null = null;

	beforeEach(() => {
		resetSwarmState();
		const { configDir, cleanup } = createIsolatedTestEnv();
		tempDir = configDir;
		cleanupEnv = cleanup;
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		ensureAgentSession('sess1');
	});

	afterEach(() => {
		process.chdir(originalCwd);
		cleanupEnv?.();
		resetSwarmState();
	});

	function writeConfig(phaseComplete: Record<string, unknown>): void {
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
					...phaseComplete,
				},
			}),
		);
	}

	async function snapshotGate(): Promise<GateEntry> {
		const parsed = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		const entry = (
			parsed.gate_report?.entries as GateEntry[] | undefined
		)?.find((candidate) => candidate.id === 'snapshot_identity');
		if (!entry) {
			throw new Error(
				`no snapshot_identity entry in gate report: ${JSON.stringify(parsed).slice(0, 400)}`,
			);
		}
		return entry;
	}

	test('the reported deadlock shape (17,090,443 total bytes, default budget) passes the gate', async () => {
		// Exact sizes from the report: journal 16,557,428 + evidence 526,628 +
		// spec 6,387 = 17,090,443, over the old fixed 16,777,216 cap. Sparse
		// files keep the fixture fast; the hash still walks every byte.
		writeConfig({});
		const ledger = path.join(tempDir, '.swarm', 'knowledge-receipts-v2.jsonl');
		fs.writeFileSync(ledger, '');
		fs.truncateSync(ledger, 16_557_428);
		const evidence = path.join(tempDir, '.swarm', 'evidence', 'bulk.json');
		fs.writeFileSync(evidence, '');
		fs.truncateSync(evidence, 526_628);
		const spec = path.join(tempDir, '.swarm', 'spec.md');
		fs.writeFileSync(spec, '');
		fs.truncateSync(spec, 6_387);

		const entry = await snapshotGate();
		expect(entry.outcome).toBe('pass');
	});

	test('phase_complete.snapshot_max_bytes is the evidence budget the gate enforces', async () => {
		writeConfig({ snapshot_max_bytes: 1_048_576 });
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', 'big.json'),
			Buffer.alloc(1_048_576 + 1, 'y'),
		);

		const entry = await snapshotGate();
		expect(entry.code).toBe('SNAPSHOT_IDENTITY_ERROR');
		expect(entry.outcome).toBe('error');
		expect(entry.detail).toContain('PHASE_SNAPSHOT_BYTE_LIMIT');
		expect(entry.detail).toContain('.swarm/evidence/big.json');
		expect(entry.detail).toContain('1048577 bytes');
		expect(entry.detail).toContain('1048576-byte limit');
	});

	test('raising the budget clears evidence that exceeds the default budget', async () => {
		// 17 MiB is over the 16 MiB default, so this passes ONLY if the configured
		// budget (not the default) reaches the gate.
		writeConfig({ snapshot_max_bytes: 32 * 1024 * 1024 });
		const big = path.join(tempDir, '.swarm', 'evidence', 'big.json');
		fs.writeFileSync(big, '');
		fs.truncateSync(big, 17 * 1024 * 1024);

		const entry = await snapshotGate();
		expect(entry.outcome).toBe('pass');
	});
});
