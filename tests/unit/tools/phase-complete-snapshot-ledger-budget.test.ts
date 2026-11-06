import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PhaseCompleteConfigSchema } from '../../../src/config/schema';
import { MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES } from '../../../src/hooks/knowledge-receipt-ledger-storage';
import {
	computePhaseEvidenceSnapshot,
	DEFAULT_SNAPSHOT_MAX_BYTES,
} from '../../../src/tools/phase-complete/snapshot-identity';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixtureRoot(prefix: string): string {
	const fixture = createSafeTestDir(prefix);
	cleanups.push(fixture.cleanup);
	fs.mkdirSync(path.join(fixture.dir, '.swarm', 'evidence'), {
		recursive: true,
	});
	return fixture.dir;
}

const sha256 = (bytes: Buffer): string =>
	createHash('sha256').update(bytes).digest('hex');

/** The identity as the pre-streaming implementation defined it. */
function referenceIdentity(
	entries: Array<{ path: string; bytes: Buffer }>,
): string {
	const sorted = [...entries]
		.map((entry) => ({
			path: entry.path,
			sha256: sha256(entry.bytes),
			bytes: entry.bytes.byteLength,
		}))
		.sort((left, right) =>
			Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
		);
	return createHash('sha256')
		.update(JSON.stringify({ schemaVersion: 1, entries: sorted }))
		.digest('hex');
}

describe('phase snapshot identity: receipt journal budget', () => {
	test('streamed digests are byte-identical to the whole-file algorithm, across chunk boundaries', () => {
		const root = fixtureRoot('phase-snapshot-ref-');
		// 2.5 MiB spans three 1 MiB hash chunks; the odd tail catches an
		// off-by-one at the final partial chunk.
		const ledger = Buffer.alloc(2 * 1024 * 1024 + 512 * 1024 + 7, 'abc\n');
		const evidence = Buffer.from('{"pass":true}');
		const empty = Buffer.alloc(0);
		fs.writeFileSync(
			path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl'),
			ledger,
		);
		fs.writeFileSync(
			path.join(root, '.swarm', 'evidence', 'gate.json'),
			evidence,
		);
		fs.writeFileSync(path.join(root, '.swarm', 'spec.md'), empty);

		expect(computePhaseEvidenceSnapshot(root)).toBe(
			referenceIdentity([
				{ path: '.swarm/knowledge-receipts-v2.jsonl', bytes: ledger },
				{ path: '.swarm/evidence/gate.json', bytes: evidence },
				{ path: '.swarm/spec.md', bytes: empty },
			]),
		);
	});

	test('a journal larger than the evidence budget does not consume it', () => {
		const root = fixtureRoot('phase-snapshot-ledger-');
		const ledgerPath = path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl');
		fs.writeFileSync(ledgerPath, Buffer.alloc(8192, 'x'));
		fs.writeFileSync(path.join(root, '.swarm', 'evidence', 'a.json'), '{}');

		// The journal alone (8192) is 8x the evidence budget (1024) and the
		// pre-fix implementation threw PHASE_SNAPSHOT_BYTE_LIMIT right here.
		const identity = computePhaseEvidenceSnapshot(root, { maxBytes: 1024 });
		expect(identity).toMatch(/^[0-9a-f]{64}$/);
	});

	test('the reported deadlock shape (17,090,443 total bytes) hashes under the default budget', () => {
		const root = fixtureRoot('phase-snapshot-repro-');
		const sparse = (relative: string, size: number): void => {
			const target = path.join(root, ...relative.split('/'));
			fs.writeFileSync(target, '');
			fs.truncateSync(target, size);
		};
		sparse('.swarm/knowledge-receipts-v2.jsonl', 16_557_428);
		sparse('.swarm/evidence/bulk.json', 526_628);
		sparse('.swarm/spec.md', 6_387);
		expect(16_557_428 + 526_628 + 6_387).toBeGreaterThan(
			DEFAULT_SNAPSHOT_MAX_BYTES,
		);

		expect(computePhaseEvidenceSnapshot(root)).toMatch(/^[0-9a-f]{64}$/);
	});

	test('identity still tracks the journal byte-for-byte, including same-size edits', () => {
		const root = fixtureRoot('phase-snapshot-ledger-edit-');
		const ledgerPath = path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl');
		fs.writeFileSync(ledgerPath, `${'a'.repeat(4096)}\n`);
		const before = computePhaseEvidenceSnapshot(root);

		fs.writeFileSync(ledgerPath, `${'a'.repeat(2048)}b${'a'.repeat(2047)}\n`);
		expect(fs.statSync(ledgerPath).size).toBe(4097);
		expect(computePhaseEvidenceSnapshot(root)).not.toBe(before);

		fs.writeFileSync(ledgerPath, `${'a'.repeat(4096)}\n`);
		expect(computePhaseEvidenceSnapshot(root)).toBe(before);

		fs.appendFileSync(ledgerPath, '{"kind":"membership_committed"}\n');
		expect(computePhaseEvidenceSnapshot(root)).not.toBe(before);
	});

	test('evidence over budget fails naming the file, observed total, limit and per-input bytes', () => {
		const root = fixtureRoot('phase-snapshot-evidence-over-');
		fs.writeFileSync(path.join(root, '.swarm', 'spec.md'), Buffer.alloc(300));
		fs.writeFileSync(
			path.join(root, '.swarm', 'evidence', 'big.json'),
			Buffer.alloc(900),
		);

		let message = '';
		try {
			computePhaseEvidenceSnapshot(root, { maxBytes: 1000 });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message.startsWith('PHASE_SNAPSHOT_BYTE_LIMIT:')).toBe(true);
		// Inputs are visited in INPUTS order: evidence (900) then spec (300), so
		// spec.md is the file that crosses the 1000-byte budget.
		expect(message).toContain('hashing .swarm/spec.md');
		expect(message).toContain('1200 bytes');
		expect(message).toContain('1000-byte limit');
		expect(message).toContain('.swarm/evidence=900');
		expect(message).toContain('.swarm/spec.md=300');
		expect(message).toContain('phase_complete.snapshot_max_bytes');
	});

	test('evidence budget is honoured exactly at the boundary', () => {
		const root = fixtureRoot('phase-snapshot-boundary-');
		fs.writeFileSync(
			path.join(root, '.swarm', 'evidence', 'exact.json'),
			Buffer.alloc(1000),
		);
		expect(() =>
			computePhaseEvidenceSnapshot(root, { maxBytes: 1000 }),
		).not.toThrow();
		expect(() => computePhaseEvidenceSnapshot(root, { maxBytes: 999 })).toThrow(
			'PHASE_SNAPSHOT_BYTE_LIMIT',
		);
	});

	test('a journal over the receipt store limit fails with a path/size/limit message, before reading it', () => {
		const root = fixtureRoot('phase-snapshot-ledger-cap-');
		const ledgerPath = path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl');
		// Sparse: no 32 MiB of real I/O.
		fs.writeFileSync(ledgerPath, '');
		fs.truncateSync(ledgerPath, MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES + 1);

		let message = '';
		try {
			computePhaseEvidenceSnapshot(root);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message.startsWith('PHASE_SNAPSHOT_BYTE_LIMIT:')).toBe(true);
		expect(message).toContain('.swarm/knowledge-receipts-v2.jsonl');
		expect(message).toContain(
			`${MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES + 1} bytes`,
		);
		expect(message).toContain(`${MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES}-byte`);

		// At exactly the store limit the journal is still hashable.
		fs.truncateSync(ledgerPath, MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES);
		expect(computePhaseEvidenceSnapshot(root)).toMatch(/^[0-9a-f]{64}$/);
	});

	test('a directory that merely carries the journal name is not exempt from the evidence budget', () => {
		const root = fixtureRoot('phase-snapshot-lookalike-');
		const impostor = path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl');
		fs.mkdirSync(impostor);
		for (const name of ['a.bin', 'b.bin', 'c.bin']) {
			fs.writeFileSync(path.join(impostor, name), Buffer.alloc(600));
		}

		// 1800 bytes in files under a look-alike directory: charged to the
		// evidence budget like any other input, not hashed for free.
		expect(() =>
			computePhaseEvidenceSnapshot(root, { maxBytes: 1000 }),
		).toThrow('PHASE_SNAPSHOT_BYTE_LIMIT');
		expect(() =>
			computePhaseEvidenceSnapshot(root, { maxBytes: 4000 }),
		).not.toThrow();
	});

	test('rejects a non-positive or non-integer budget instead of silently widening it', () => {
		const root = fixtureRoot('phase-snapshot-invalid-limit-');
		for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => computePhaseEvidenceSnapshot(root, { maxBytes })).toThrow(
				'PHASE_SNAPSHOT_INVALID_LIMIT',
			);
		}
	});

	test('the config default is pinned to the snapshot default and bounded', () => {
		expect(PhaseCompleteConfigSchema.parse({}).snapshot_max_bytes).toBe(
			DEFAULT_SNAPSHOT_MAX_BYTES,
		);
		expect(DEFAULT_SNAPSHOT_MAX_BYTES).toBe(16 * 1024 * 1024);
		expect(
			PhaseCompleteConfigSchema.safeParse({ snapshot_max_bytes: 1_048_575 })
				.success,
		).toBe(false);
		expect(
			PhaseCompleteConfigSchema.safeParse({ snapshot_max_bytes: 1_048_576 })
				.success,
		).toBe(true);
		expect(
			PhaseCompleteConfigSchema.safeParse({ snapshot_max_bytes: 268_435_457 })
				.success,
		).toBe(false);
		expect(
			PhaseCompleteConfigSchema.safeParse({ snapshot_max_bytes: 1_500_000.5 })
				.success,
		).toBe(false);
	});
});
