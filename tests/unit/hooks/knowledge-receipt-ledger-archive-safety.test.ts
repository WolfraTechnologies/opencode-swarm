import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
const cleanups: Array<() => void> = [];
const originalNowMs = _internals.nowMs;
const originalMaxArchiveRecords = _internals.maxArchiveRecords;
const originalMaxArchiveBytes = _internals.maxArchiveBytes;
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

function segmentNames(directory: string): string[] {
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

/** Expose `entries` (grace 0: eligible the moment the phase closes). */
async function expose(
	directory: string,
	phase: string,
	entries: string[],
): Promise<void> {
	unwrap(
		await commitDisplayedMembership(directory, {
			trace_id: `trace-${phase}`,
			session_id: `session-${phase}`,
			phase,
			grace_days: 0,
			entries: entries.map((entry_id) => ({ entry_id, critical: false })),
			exposure_kind: 'delegate_directive',
		}),
	);
}

/** Make the next journal checkpoint fail AFTER an archive file was written. */
function crashAfterArchiveWrite(): void {
	let archiveWritten = false;
	_internals.atomicWriteFsynced = async (target, content) => {
		if (isReceiptArchiveSegmentName(path.basename(target))) {
			archiveWritten = true;
		}
		if (archiveWritten && target.endsWith('knowledge-receipts-v2.jsonl')) {
			throw new Error('injected checkpoint crash');
		}
		await originalAtomicWrite(target, content);
	};
}

describe('archive passes never lose a row', () => {
	test('an interrupted over-threshold pass, retried with a new row beside it, keeps every row exactly once', async () => {
		// The regression this guards: the rows of an interrupted pass sit in the
		// tail AND the journal. A retry that must seal the tail used to purge
		// those rows from the tail (they are live) while still skipping them as
		// "already archived", and then deleted them from the journal: gone from
		// both places.
		const directory = project('receipt-archive-safety-retry-');
		const base = Date.now();
		_internals.nowMs = () => base;
		_internals.maxArchiveRecords = 1;

		await expose(directory, 'Phase 1', ['r1', 'r2', 'r3']);
		crashAfterArchiveWrite();
		const crashed = await commitPhaseClosed(
			directory,
			'Phase 1',
			'session-Phase 1',
		);
		expect(crashed.ok).toBe(false);
		_internals.atomicWriteFsynced = originalAtomicWrite;
		// Segment 0 holds the whole 3-row pass (an empty tail accepts it) and the
		// rows are still live too.
		expect(entryIdsIn(directory, BASE_SEGMENT)).toEqual(['r1', 'r2', 'r3']);
		expect(
			unwrap(await queryLiveMemberships(directory)).memberships,
		).toHaveLength(3);

		// A new row becomes eligible: the retry now has r1..r3 (identical, kept)
		// plus r4 (new) against a tail that is over its 1-row threshold -> seal.
		await expose(directory, 'Phase 2', ['r4']);
		unwrap(await commitPhaseClosed(directory, 'Phase 2', 'session-Phase 2'));

		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		const holders = new Map<string, string[]>();
		for (const name of segmentNames(directory)) {
			for (const id of entryIdsIn(directory, name)) {
				holders.set(id, [...(holders.get(id) ?? []), name]);
			}
		}
		// Every row is archived exactly once.
		expect([...holders.keys()].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
		for (const [id, files] of holders) {
			expect({ id, files: files.length }).toEqual({ id, files: 1 });
		}
		const history = unwrap(await queryHistoricalOutcomes(directory));
		expect(history.memberships.map((m) => m.entry_id).sort()).toEqual([
			'r1',
			'r2',
			'r3',
			'r4',
		]);
		const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
		for (const id of ['r1', 'r2', 'r3', 'r4']) {
			expect(rollups.get(id)?.shown_count).toBe(1);
		}
	});

	test('a changed live row whose new version forces a seal never leaves its stale copy behind', async () => {
		// The regression this guards: a terminal filed after an interrupted pass
		// makes the live row differ from its archived copy. The retry deletes the
		// stale tail copy in memory; if it then SEALS the tail (the new, larger
		// version no longer fits) without rewriting it, the stale copy stays in
		// the sealed segment while the new version lands in the next one - the
		// same key in two segments, double-counted by the cached rollups.
		const directory = project('receipt-archive-safety-changed-seal-');
		const base = Date.now();
		_internals.nowMs = () => base;

		await expose(directory, 'Phase 1', ['a1', 'a2']);
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-Phase 1'));
		expect(entryIdsIn(directory, BASE_SEGMENT)).toEqual(['a1', 'a2']);
		const rowBytes = fs.statSync(swarm(directory, BASE_SEGMENT)).size / 2;
		// Three plain rows fit; two plain rows plus one carrying a terminal do not.
		_internals.maxArchiveBytes = Math.floor(rowBytes * 3 + 60);

		await expose(directory, 'Phase 2', ['q']);
		crashAfterArchiveWrite();
		const crashed = await commitPhaseClosed(
			directory,
			'Phase 2',
			'session-Phase 2',
		);
		expect(crashed.ok).toBe(false);
		_internals.atomicWriteFsynced = originalAtomicWrite;
		// q is live AND in the tail (its first version).
		expect(entryIdsIn(directory, BASE_SEGMENT)).toEqual(['a1', 'a2', 'q']);

		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-Phase 2',
				session_id: 'session-Phase 2',
				items: [{ entry_id: 'q', outcome: 'applied' }],
			}),
		);
		_internals.nowMs = () => base + DAY_MS;
		unwrap(await compactKnowledgeReceiptLedger(directory));

		// The new version did not fit, so the tail was sealed - and the stale
		// copy was removed from it first.
		expect(segmentNames(directory)).toEqual([BASE_SEGMENT, segmentName(1)]);
		expect(entryIdsIn(directory, BASE_SEGMENT)).toEqual(['a1', 'a2']);
		expect(entryIdsIn(directory, segmentName(1))).toEqual(['q']);
		const history = unwrap(await queryHistoricalOutcomes(directory, ['q']));
		expect(history.memberships).toHaveLength(1);
		expect(history.memberships[0]?.terminal?.outcome).toBe('applied');
		const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(rollups.get('q')?.shown_count).toBe(1);
		expect(rollups.get('q')?.applied_explicit_count).toBe(1);
	});

	test('an interrupted pass that is simply retried writes nothing new and loses nothing', async () => {
		const directory = project('receipt-archive-safety-plain-retry-');
		const base = Date.now();
		_internals.nowMs = () => base;
		_internals.maxArchiveRecords = 1;
		await expose(directory, 'Phase 1', ['p1', 'p2', 'p3']);
		crashAfterArchiveWrite();
		await commitPhaseClosed(directory, 'Phase 1', 'session-Phase 1');
		_internals.atomicWriteFsynced = originalAtomicWrite;
		const before = fs.readFileSync(swarm(directory, BASE_SEGMENT), 'utf8');

		_internals.nowMs = () => base + DAY_MS;
		unwrap(await compactKnowledgeReceiptLedger(directory));

		// Everything was already archived verbatim: the (over-threshold) tail is
		// neither sealed nor rewritten, and the rows leave the journal.
		expect(segmentNames(directory)).toEqual([BASE_SEGMENT]);
		expect(fs.readFileSync(swarm(directory, BASE_SEGMENT), 'utf8')).toBe(
			before,
		);
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		expect(
			unwrap(await queryHistoricalOutcomes(directory)).memberships,
		).toHaveLength(3);
	});
});

describe('archive read failures are typed and visible', () => {
	test('a listed segment that has vanished fails history typed instead of reading as empty', async () => {
		const directory = project('receipt-archive-safety-vanished-');
		const base = Date.now();
		_internals.maxArchiveRecords = 1;
		_internals.nowMs = () => base;
		await expose(directory, 'Phase 1', ['v1']);
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-Phase 1'));
		_internals.nowMs = () => base + 2 * DAY_MS;
		await expose(directory, 'Phase 2', ['v2']);
		unwrap(await commitPhaseClosed(directory, 'Phase 2', 'session-Phase 2'));
		expect(segmentNames(directory)).toEqual([segmentName(0), segmentName(1)]);

		// Segment 0 is listed (it exists) but its read comes back absent.
		_internals.readArchiveSegmentFile = async (filePath) =>
			filePath.endsWith(BASE_SEGMENT) ? null : originalReadSegment(filePath);
		const history = await queryHistoricalOutcomes(directory);
		expect(history.ok).toBe(false);
		if (!history.ok) {
			expect(history.code).toBe('store_unavailable');
			expect(history.detail).toContain('disappeared');
		}
	});

	test('an unavailable rollup raises one critical warning per project, not one per message', async () => {
		const directory = project('receipt-archive-safety-rollup-warn-');
		const base = Date.now();
		_internals.maxArchiveRecords = 1;
		_internals.nowMs = () => base;
		await expose(directory, 'Phase 1', ['w1']);
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-Phase 1'));
		_internals.nowMs = () => base + 2 * DAY_MS;
		await expose(directory, 'Phase 2', ['w2']);
		unwrap(await commitPhaseClosed(directory, 'Phase 2', 'session-Phase 2'));
		// Damage the sealed segment 0.
		fs.writeFileSync(swarm(directory, segmentName(0)), '{not valid}\n');

		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		const first = await readAuthoritativeKnowledgeCounterRollups(directory);
		const second = await readAuthoritativeKnowledgeCounterRollups(directory);

		expect(first.size).toBe(0);
		expect(second.size).toBe(0);
		const critical = warnings.filter((line) => line.includes('CRITICAL-WARN'));
		expect(critical).toHaveLength(1);
		expect(critical[0]).toContain('counter rollups unavailable');
	});
});
