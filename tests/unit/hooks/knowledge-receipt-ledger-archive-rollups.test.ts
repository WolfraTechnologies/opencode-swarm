import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { readAuthoritativeKnowledgeCounterRollups } from '../../../src/hooks/knowledge-events.js';
import {
	_internals,
	commitDisplayedMembership,
	commitPhaseClosed,
	compactKnowledgeReceiptLedger,
	queryHistoricalOutcomes,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { isReceiptArchiveSegmentName } from '../../../src/hooks/knowledge-receipt-ledger-storage.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;
const cleanups: Array<() => void> = [];
const originalNowMs = _internals.nowMs;
const originalMaxArchiveRecords = _internals.maxArchiveRecords;
const originalMaxArchiveBytes = _internals.maxArchiveBytes;
const originalMaxHistory = _internals.maxArchiveHistoryBytes;
const originalReadSegment = _internals.readArchiveSegmentFile;
const originalConsoleWarn = console.warn;

afterEach(() => {
	_internals.nowMs = originalNowMs;
	_internals.maxArchiveRecords = originalMaxArchiveRecords;
	_internals.maxArchiveBytes = originalMaxArchiveBytes;
	_internals.maxArchiveHistoryBytes = originalMaxHistory;
	_internals.readArchiveSegmentFile = originalReadSegment;
	console.warn = originalConsoleWarn;
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string): string {
	const fixture = createSafeTestDir(prefix);
	cleanups.push(fixture.cleanup);
	fs.mkdirSync(path.join(fixture.dir, '.git'));
	return fixture.dir;
}

function unwrap<T>(result: ReceiptLedgerResult<T>): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
	return result;
}

const swarm = (directory: string, name = ''): string =>
	path.join(directory, '.swarm', name);

/** Archive segment file names in segment order: base file first. */
function archiveNames(directory: string): string[] {
	const indexOf = (name: string): number =>
		name === 'knowledge-receipts-v2-archive.jsonl'
			? 0
			: Number(name.split('.')[1]);
	return fs
		.readdirSync(swarm(directory))
		.filter((name) => isReceiptArchiveSegmentName(name))
		.sort((left, right) => indexOf(left) - indexOf(right));
}

/** Expose `entries` in `phase`, close the phase, and sweep 8 days later. */
async function expireOne(
	directory: string,
	base: number,
	phase: string,
	entries: string[],
	apply: string[] = [],
): Promise<void> {
	_internals.nowMs = () => base;
	unwrap(
		await commitDisplayedMembership(directory, {
			trace_id: `trace-${phase}`,
			session_id: `session-${phase}`,
			phase,
			entries: entries.map((entry_id) => ({ entry_id, critical: false })),
			exposure_kind: 'delegate_directive',
		}),
	);
	if (apply.length > 0) {
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: `trace-${phase}`,
				session_id: `session-${phase}`,
				items: apply.map((entry_id) => ({ entry_id, outcome: 'applied' })),
			}),
		);
	}
	unwrap(await commitPhaseClosed(directory, phase, `session-${phase}`));
	_internals.nowMs = () => base + 8 * DAY_MS;
	unwrap(await compactKnowledgeReceiptLedger(directory));
}

describe('archive segments and the counter rollups', () => {
	test('rollups over live + tail + sealed segments equal the exact full-history fold', async () => {
		const directory = project('receipt-rollups-exact-');
		const base = Date.now();
		_internals.maxArchiveRecords = 2;
		await expireOne(directory, base, 'Phase 1', ['x', 'y', 'z'], ['x']);
		await expireOne(
			directory,
			base + DAY_MS,
			'Phase 2',
			['x', 'w'],
			['x', 'w'],
		);
		await expireOne(directory, base + 2 * DAY_MS, 'Phase 3', ['y'], []);
		// One still-live exposure so the live leg contributes too.
		_internals.nowMs = () => base + 20 * DAY_MS;
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-live',
				session_id: 'session-live',
				phase: 'Phase 9',
				entries: [{ entry_id: 'x', critical: false }],
				exposure_kind: 'delegate_directive',
			}),
		);
		expect(archiveNames(directory).length).toBeGreaterThanOrEqual(3);

		const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
		// Reference: fold the exact merged history by hand.
		const history = unwrap(await queryHistoricalOutcomes(directory));
		const expected = new Map<string, { shown: number; applied: number }>();
		for (const m of history.memberships) {
			const row = expected.get(m.entry_id) ?? { shown: 0, applied: 0 };
			row.shown += 1;
			if (m.terminal?.outcome === 'applied') row.applied += 1;
			expected.set(m.entry_id, row);
		}
		expect(rollups.size).toBe(expected.size);
		for (const [entryId, row] of expected) {
			expect(rollups.get(entryId)?.shown_count).toBe(row.shown);
			expect(rollups.get(entryId)?.applied_explicit_count).toBe(row.applied);
		}
		// Sanity on the concrete numbers: x was shown in P1, P2 and live.
		expect(rollups.get('x')?.shown_count).toBe(3);
		expect(rollups.get('x')?.applied_explicit_count).toBe(2);
	});

	test('repeated rollups do not re-read sealed segments, but do notice a rewritten one', async () => {
		const directory = project('receipt-rollups-cache-');
		const base = Date.now();
		_internals.maxArchiveRecords = 1;
		await expireOne(directory, base, 'Phase 1', ['a', 'b', 'c']);
		const names = archiveNames(directory);
		expect(names).toHaveLength(3);
		const sealed = new Set(
			names.slice(0, -1).map((name) => swarm(directory, name)),
		);

		const reads: string[] = [];
		_internals.readArchiveSegmentFile = (filePath) => {
			reads.push(filePath);
			return originalReadSegment(filePath);
		};
		const first = await readAuthoritativeKnowledgeCounterRollups(directory);
		const second = await readAuthoritativeKnowledgeCounterRollups(directory);
		const third = await readAuthoritativeKnowledgeCounterRollups(directory);

		const sealedReads = reads.filter((file) => sealed.has(file));
		// Each sealed segment is streamed once, then served from the cache.
		expect(sealedReads).toHaveLength(sealed.size);
		expect(new Set(sealedReads).size).toBe(sealed.size);
		// The tail is re-read by every call; it is the only archive file that is.
		expect(reads.filter((file) => !sealed.has(file)).length).toBe(3);
		expect([...second]).toEqual([...first]);
		expect([...third]).toEqual([...first]);

		// Rewriting a sealed segment changes its identity, so it is read again.
		const victim = [...sealed][0] as string;
		const body = fs.readFileSync(victim, 'utf8');
		fs.writeFileSync(`${victim}.next`, body);
		fs.renameSync(`${victim}.next`, victim);
		reads.length = 0;
		await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(reads.filter((file) => file === victim)).toHaveLength(1);
	});

	test('rollups ignore the full-history budget that stops full-history queries', async () => {
		const directory = project('receipt-rollups-budget-');
		const base = Date.now();
		_internals.maxArchiveRecords = 1;
		await expireOne(directory, base, 'Phase 1', ['p', 'q'], ['p']);

		_internals.maxArchiveHistoryBytes = 1;
		console.warn = () => undefined; // the one-time budget warning is expected
		const history = await queryHistoricalOutcomes(directory);
		expect(history.ok).toBe(false);
		const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(rollups.get('p')?.shown_count).toBe(1);
		expect(rollups.get('p')?.applied_explicit_count).toBe(1);
		expect(rollups.get('q')?.shown_count).toBe(1);
	});

	test('the full-history budget is raised by config, and its warning is logged once', async () => {
		const directory = project('receipt-history-budget-config-');
		const base = Date.now();
		await expireOne(directory, base, 'Phase 1', ['k']);
		// Nine 15 MiB segments of blank lines (valid, empty JSONL) take the total
		// past the 128 MiB default without making any single segment unreadable.
		const filler = Buffer.alloc(15 * MIB, '\n');
		for (let index = 1; index <= 9; index++) {
			fs.writeFileSync(
				swarm(
					directory,
					`knowledge-receipts-v2-archive.${String(100 + index).padStart(6, '0')}.jsonl`,
				),
				filler,
			);
		}

		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		const over = await queryHistoricalOutcomes(directory);
		const overAgain = await queryHistoricalOutcomes(directory);
		expect(over.ok).toBe(false);
		expect(overAgain.ok).toBe(false);
		if (!over.ok) {
			expect(over.code).toBe('store_unavailable');
			expect(over.detail).toContain('receipt_archive_history_budget_mb');
		}
		expect(
			warnings.filter((line) => line.includes('CRITICAL-WARN')),
		).toHaveLength(1);
		expect(warnings.join('\n')).toContain('receipt_archive_history_budget_mb');

		fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ knowledge: { receipt_archive_history_budget_mb: 256 } }),
		);
		const raised = await queryHistoricalOutcomes(directory);
		expect(raised.ok).toBe(true);
		if (raised.ok) {
			expect(raised.memberships.map((m) => m.entry_id)).toEqual(['k']);
		}
	});

	test('the history budget key defaults to 128 MiB and can only be raised, up to 4096', () => {
		expect(
			KnowledgeConfigSchema.parse({}).receipt_archive_history_budget_mb,
		).toBe(128);
		for (const ok of [128, 256, 4096]) {
			expect(
				KnowledgeConfigSchema.safeParse({
					receipt_archive_history_budget_mb: ok,
				}).success,
			).toBe(true);
		}
		for (const bad of [127, 0, 4097, 128.5]) {
			expect(
				KnowledgeConfigSchema.safeParse({
					receipt_archive_history_budget_mb: bad,
				}).success,
			).toBe(false);
		}
	});

	test('a stray non-regular segment name never wedges compaction and is never reused', async () => {
		const directory = project('receipt-segments-stray-');
		const base = Date.now();
		fs.mkdirSync(swarm(directory), { recursive: true });
		// A directory squatting on segment 3's name.
		fs.mkdirSync(
			swarm(directory, 'knowledge-receipts-v2-archive.000003.jsonl'),
		);

		await expireOne(directory, base, 'Phase 1', ['s1', 's2']);

		// The expired rows left the journal despite the stray entry...
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		const written = archiveNames(directory).filter(
			(name) => name !== 'knowledge-receipts-v2-archive.000003.jsonl',
		);
		expect(written).toEqual(['knowledge-receipts-v2-archive.jsonl']);
		// ...and the squatter was left alone.
		expect(
			fs
				.statSync(
					swarm(directory, 'knowledge-receipts-v2-archive.000003.jsonl'),
				)
				.isDirectory(),
		).toBe(true);

		// Roll over: the new segment is allocated ABOVE the squatter, not into it.
		_internals.maxArchiveRecords = 2;
		await expireOne(directory, base + DAY_MS, 'Phase 2', ['s3']);
		expect(archiveNames(directory)).toContain(
			'knowledge-receipts-v2-archive.000004.jsonl',
		);
		expect(
			fs
				.statSync(
					swarm(directory, 'knowledge-receipts-v2-archive.000003.jsonl'),
				)
				.isDirectory(),
		).toBe(true);

		// Full-history reads still fail closed on it: a replaced segment would
		// silently drop history.
		const history = await queryHistoricalOutcomes(directory);
		expect(history.ok).toBe(false);
		if (!history.ok) expect(history.code).toBe('store_unavailable');
		const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(rollups.size).toBe(0);
	});

	test('a row larger than a whole segment stays live instead of producing an unreadable file', async () => {
		const directory = project('receipt-segments-oversized-');
		const base = Date.now();
		_internals.maxArchiveBytes = 10;
		await expireOne(directory, base, 'Phase 1', ['big']);

		expect(
			unwrap(await queryLiveMemberships(directory)).memberships.map(
				(m) => m.entry_id,
			),
		).toEqual(['big']);
		expect(archiveNames(directory)).toEqual([]);

		// Nothing moved, so repeated sweeps must not rewrite an identical journal.
		const journal = swarm(directory, 'knowledge-receipts-v2.jsonl');
		const before = fs.readFileSync(journal, 'utf8');
		unwrap(await compactKnowledgeReceiptLedger(directory));
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(fs.readFileSync(journal, 'utf8')).toBe(before);
	});
});
