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
const originalAtomicWrite = _internals.atomicWriteFsynced;
const originalConsoleWarn = console.warn;
const BASE_SEGMENT = 'knowledge-receipts-v2-archive.jsonl';
const segmentName = (index: number): string =>
	index === 0
		? BASE_SEGMENT
		: `knowledge-receipts-v2-archive.${String(index).padStart(6, '0')}.jsonl`;

afterEach(() => {
	_internals.nowMs = originalNowMs;
	_internals.maxArchiveRecords = originalMaxArchiveRecords;
	_internals.maxArchiveBytes = originalMaxArchiveBytes;
	_internals.maxArchiveHistoryBytes = originalMaxHistory;
	_internals.readArchiveSegmentFile = originalReadSegment;
	_internals.atomicWriteFsynced = originalAtomicWrite;
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
		name === BASE_SEGMENT ? 0 : Number(name.split('.')[1]);
	return fs
		.readdirSync(swarm(directory))
		.filter((name) => isReceiptArchiveSegmentName(name))
		.sort((left, right) => indexOf(left) - indexOf(right));
}

function entryIdsIn(directory: string, name: string): string[] {
	return fs
		.readFileSync(swarm(directory, name), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { entry_id: string }).entry_id)
		.sort();
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

	test('sealed history is read once, extended incrementally, and rebuilt only if a sealed segment changes', async () => {
		const directory = project('receipt-rollups-cache-');
		const base = Date.now();
		_internals.maxArchiveRecords = 1;
		await expireOne(directory, base, 'Phase 1', ['a']);
		await expireOne(directory, base + DAY_MS, 'Phase 2', ['b']);
		await expireOne(directory, base + 2 * DAY_MS, 'Phase 3', ['c']);
		// Three one-row segments: base and 000001 are sealed, 000002 is the tail.
		expect(archiveNames(directory)).toEqual([
			segmentName(0),
			segmentName(1),
			segmentName(2),
		]);
		const file = (name: string): string => swarm(directory, name);

		const reads: string[] = [];
		_internals.readArchiveSegmentFile = (filePath) => {
			reads.push(filePath);
			return originalReadSegment(filePath);
		};
		const first = await readAuthoritativeKnowledgeCounterRollups(directory);
		const second = await readAuthoritativeKnowledgeCounterRollups(directory);
		const sealed = [file(segmentName(0)), file(segmentName(1))];
		// Each sealed segment is streamed once; the tail is re-read every call.
		expect(reads.filter((f) => sealed.includes(f))).toHaveLength(2);
		expect(reads.filter((f) => f === file(segmentName(2)))).toHaveLength(2);
		expect([...second]).toEqual([...first]);
		expect([...first.keys()].sort()).toEqual(['a', 'b', 'c']);

		// A new segment seals: only IT is read; the folded prefix is reused.
		await expireOne(directory, base + 3 * DAY_MS, 'Phase 4', ['d']);
		reads.length = 0;
		const third = await readAuthoritativeKnowledgeCounterRollups(directory);
		// Segment 2 was the tail and is now sealed: folded exactly once. The new
		// tail (segment 3) is read; segments 0 and 1 are served from the prefix.
		expect(reads.filter((f) => f === file(segmentName(2)))).toHaveLength(1);
		expect(reads.filter((f) => f === file(segmentName(3)))).toHaveLength(1);
		expect(reads.filter((f) => f === file(segmentName(0)))).toHaveLength(0);
		expect(reads.filter((f) => f === file(segmentName(1)))).toHaveLength(0);
		expect([...third.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);

		// Rewriting an already-folded sealed segment changes its identity, so the
		// cumulative rollup is rebuilt from scratch.
		const victim = file(segmentName(0));
		const body = fs.readFileSync(victim, 'utf8');
		fs.writeFileSync(`${victim}.next`, body);
		fs.renameSync(`${victim}.next`, victim);
		reads.length = 0;
		await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(reads.filter((f) => f === victim)).toHaveLength(1);
		expect(reads.filter((f) => f === file(segmentName(1)))).toHaveLength(1);
		expect(reads.filter((f) => f === file(segmentName(2)))).toHaveLength(1);
		expect(reads.filter((f) => f === file(segmentName(3)))).toHaveLength(1);
	});

	test('rollups ignore the full-history budget that stops full-history queries', async () => {
		const directory = project('receipt-rollups-budget-');
		const base = Date.now();
		_internals.maxArchiveRecords = 1;
		await expireOne(directory, base, 'Phase 1', ['p', 'q'], ['p']);
		await expireOne(directory, base + DAY_MS, 'Phase 2', ['r']);

		_internals.maxArchiveHistoryBytes = 1;
		console.warn = () => undefined; // the one-time budget warning is expected
		const history = await queryHistoricalOutcomes(directory);
		expect(history.ok).toBe(false);
		const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(rollups.get('p')?.shown_count).toBe(1);
		expect(rollups.get('p')?.applied_explicit_count).toBe(1);
		expect(rollups.get('q')?.shown_count).toBe(1);
		expect(rollups.get('r')?.shown_count).toBe(1);
	});

	test('the full-history budget is raised by config, and its warning is logged once', async () => {
		const directory = project('receipt-history-budget-config-');
		const base = Date.now();
		await expireOne(directory, base, 'Phase 1', ['k']);
		// Nine 15 MiB segments of blank lines (valid, empty JSONL) take the total
		// past the 128 MiB default without making any single segment unreadable.
		const filler = Buffer.alloc(15 * MIB, '\n');
		for (let index = 1; index <= 9; index++) {
			fs.writeFileSync(swarm(directory, segmentName(100 + index)), filler);
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

	test('stray non-regular segment names never wedge compaction and their indexes are skipped', async () => {
		const directory = project('receipt-segments-stray-');
		const base = Date.now();
		fs.mkdirSync(swarm(directory), { recursive: true });
		// Directories squatting on segment 1 and segment 3.
		fs.mkdirSync(swarm(directory, segmentName(1)));
		fs.mkdirSync(swarm(directory, segmentName(3)));
		_internals.maxArchiveRecords = 2;

		await expireOne(directory, base, 'Phase 1', ['s1', 's2', 's3']);
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		// The empty tail (segment 0) takes the whole pass.
		expect(entryIdsIn(directory, segmentName(0))).toEqual(['s1', 's2', 's3']);

		// Segment 0 is over its threshold, so the next pass needs a new segment:
		// index 1 is squatted, so it lands on 2; the squatters are left alone.
		await expireOne(directory, base + DAY_MS, 'Phase 2', ['s4']);
		expect(entryIdsIn(directory, segmentName(2))).toEqual(['s4']);
		// The tail is now 2; adding past its threshold skips squatted 3 -> 4.
		_internals.maxArchiveRecords = 1;
		await expireOne(directory, base + 2 * DAY_MS, 'Phase 3', ['s5']);
		expect(entryIdsIn(directory, segmentName(4))).toEqual(['s5']);
		for (const squat of [1, 3]) {
			expect(
				fs.statSync(swarm(directory, segmentName(squat))).isDirectory(),
			).toBe(true);
		}

		// Full-history reads still fail closed: a replaced segment would silently
		// drop history, and the rollups report unavailable rather than guess.
		const history = await queryHistoricalOutcomes(directory);
		expect(history.ok).toBe(false);
		if (!history.ok) expect(history.code).toBe('store_unavailable');
		console.warn = () => undefined;
		expect(
			(await readAuthoritativeKnowledgeCounterRollups(directory)).size,
		).toBe(0);
	});

	test('a symlink at the BASE archive name does not wedge any receipt operation', async () => {
		const directory = project('receipt-segments-base-link-');
		const base = Date.now();
		fs.mkdirSync(swarm(directory), { recursive: true });
		fs.writeFileSync(swarm(directory, 'elsewhere.jsonl'), '');
		try {
			fs.symlinkSync(
				swarm(directory, 'elsewhere.jsonl'),
				swarm(directory, BASE_SEGMENT),
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') return;
			throw error;
		}

		// Every receipt operation still works (preparePaths no longer rejects the
		// base name), compaction archives into segment 1, and the link is untouched.
		await expireOne(directory, base, 'Phase 1', ['l1']);
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		expect(entryIdsIn(directory, segmentName(1))).toEqual(['l1']);
		expect(fs.lstatSync(swarm(directory, BASE_SEGMENT)).isSymbolicLink()).toBe(
			true,
		);
		expect(fs.readFileSync(swarm(directory, 'elsewhere.jsonl'), 'utf8')).toBe(
			'',
		);
		const history = await queryHistoricalOutcomes(directory);
		expect(history.ok).toBe(false);
	});

	test('a pass larger than the segment thresholds lands whole in one readable file', async () => {
		const directory = project('receipt-segments-big-pass-');
		const base = Date.now();
		_internals.maxArchiveBytes = 10;
		_internals.maxArchiveRecords = 1;
		await expireOne(directory, base, 'Phase 1', ['big1', 'big2', 'big3']);

		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		expect(archiveNames(directory)).toEqual([segmentName(0)]);
		expect(entryIdsIn(directory, segmentName(0))).toEqual([
			'big1',
			'big2',
			'big3',
		]);
		const history = unwrap(await queryHistoricalOutcomes(directory));
		expect(history.memberships).toHaveLength(3);
	});

	test('an interrupted pass followed by a rollover never leaves a key in two segments', async () => {
		const directory = project('receipt-segments-compound-');
		const base = Date.now();
		_internals.nowMs = () => base;
		// Y: resolved, in a phase closed now; only eligible after 7 days.
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-y',
				session_id: 'session-y',
				phase: 'Phase 2',
				entries: [{ entry_id: 'y', critical: false }],
				exposure_kind: 'delegate_directive',
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-y',
				session_id: 'session-y',
				items: [{ entry_id: 'y', outcome: 'applied' }],
			}),
		);
		unwrap(await commitPhaseClosed(directory, 'Phase 2', 'session-y'));
		// X: unresolved, eligible immediately once its phase closes (grace 0).
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-x',
				session_id: 'session-x',
				phase: 'Phase 1',
				grace_days: 0,
				entries: [{ entry_id: 'x', critical: false }],
				exposure_kind: 'delegate_directive',
			}),
		);

		// The closing sweep archives X, then the checkpoint "crashes": X is now
		// BOTH live and in segment 0.
		let archiveWritten = false;
		_internals.atomicWriteFsynced = async (target, content) => {
			if (target.endsWith(BASE_SEGMENT)) archiveWritten = true;
			if (archiveWritten && target.endsWith('knowledge-receipts-v2.jsonl')) {
				throw new Error('injected checkpoint crash');
			}
			await originalAtomicWrite(target, content);
		};
		const crashed = await commitPhaseClosed(directory, 'Phase 1', 'session-x');
		expect(crashed.ok).toBe(false);
		_internals.atomicWriteFsynced = originalAtomicWrite;
		expect(entryIdsIn(directory, BASE_SEGMENT)).toEqual(['x']);

		// Segment 0 is full; a later ORDINARY pass (Y's grace elapsed) rolls over
		// and seals it. It must drop the still-live copy of X first.
		_internals.maxArchiveRecords = 1;
		_internals.nowMs = () => base + 8 * DAY_MS;
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-z',
				session_id: 'session-z',
				phase: 'Phase 9',
				entries: [{ entry_id: 'z', critical: false }],
				exposure_kind: 'delegate_directive',
			}),
		);
		expect(entryIdsIn(directory, segmentName(1))).toEqual(['y']);
		expect(entryIdsIn(directory, BASE_SEGMENT)).toEqual([]);

		// The next sweep archives X again - exactly once overall.
		unwrap(await compactKnowledgeReceiptLedger(directory));
		const holders = archiveNames(directory).filter((name) =>
			entryIdsIn(directory, name).includes('x'),
		);
		expect(holders).toHaveLength(1);
		const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(rollups.get('x')?.shown_count).toBe(1);
		expect(rollups.get('y')?.applied_explicit_count).toBe(1);
	});
});
