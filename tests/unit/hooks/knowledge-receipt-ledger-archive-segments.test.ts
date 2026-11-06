import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import {
	isReceiptArchiveSegmentName,
	listReceiptArchiveSegments,
	MAX_RECEIPT_ARCHIVE_SEGMENT_INDEX,
	receiptArchiveSegmentPath,
	resolveReceiptLedgerPaths,
} from '../../../src/hooks/knowledge-receipt-ledger-storage.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const DAY_MS = 86_400_000;
const cleanups: Array<() => void> = [];
const originalNowMs = _internals.nowMs;
const originalMaxArchiveRecords = _internals.maxArchiveRecords;
const originalMaxHistory = _internals.maxArchiveHistoryBytes;
const originalAtomicWrite = _internals.atomicWriteFsynced;

afterEach(() => {
	_internals.nowMs = originalNowMs;
	_internals.maxArchiveRecords = originalMaxArchiveRecords;
	_internals.maxArchiveHistoryBytes = originalMaxHistory;
	_internals.atomicWriteFsynced = originalAtomicWrite;
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
const segmentName = (index: number): string =>
	index === 0
		? 'knowledge-receipts-v2-archive.jsonl'
		: `knowledge-receipts-v2-archive.${String(index).padStart(6, '0')}.jsonl`;

/** Segment file names in segment order (base file first). */
function segmentFiles(directory: string): string[] {
	const indexOf = (name: string): number =>
		name === segmentName(0) ? 0 : Number(name.split('.')[1]);
	return fs
		.readdirSync(swarm(directory))
		.filter((name) => isReceiptArchiveSegmentName(name))
		.sort((left, right) => indexOf(left) - indexOf(right));
}

function rowsIn(directory: string, name: string): Array<{ entry_id: string }> {
	return fs
		.readFileSync(swarm(directory, name), 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { entry_id: string });
}

/** A closed phase whose rows are expired at `days` after `base`. */
async function closedPhase(
	directory: string,
	base: number,
	phase: string,
	entries: string[],
	session = 'session-b',
): Promise<void> {
	_internals.nowMs = () => base;
	unwrap(
		await commitDisplayedMembership(directory, {
			trace_id: `trace-${phase}`,
			session_id: session,
			phase,
			entries: entries.map((entry_id) => ({ entry_id, critical: false })),
			exposure_kind: 'delegate_directive',
		}),
	);
	unwrap(await commitPhaseClosed(directory, phase, 'session-closer'));
}

const identity = (file: string): string => {
	const info = fs.statSync(file);
	return `${info.ino}:${info.size}:${info.mtimeMs}`;
};

describe('receipt archive segments', () => {
	test('a full tail rolls over to numbered segments, each pass writes one file, and sealed segments are never rewritten', async () => {
		const directory = project('receipt-segments-tail-only-');
		const base = Date.now();
		_internals.maxArchiveRecords = 2;
		const sweepAt = async (days: number): Promise<void> => {
			_internals.nowMs = () => base + days * DAY_MS;
			unwrap(await compactKnowledgeReceiptLedger(directory));
		};

		// Pass 1: three rows exceed the 2-row threshold, but a pass is never
		// split and an empty tail accepts it whole, so segment 0 holds all three.
		await closedPhase(directory, base, 'Phase 1', ['a1', 'a2', 'a3']);
		await sweepAt(8);
		expect(segmentFiles(directory)).toEqual([segmentName(0)]);
		expect(rowsIn(directory, segmentName(0))).toHaveLength(3);
		const segment0 = identity(swarm(directory, segmentName(0)));

		// Pass 2: the tail is over its threshold, so it is sealed (untouched: it
		// holds nothing live) and the pass becomes segment 1.
		await closedPhase(directory, base + 9 * DAY_MS, 'Phase 2', ['b1', 'b2']);
		await sweepAt(20);
		expect(segmentFiles(directory)).toEqual([segmentName(0), segmentName(1)]);
		expect(identity(swarm(directory, segmentName(0)))).toBe(segment0);
		expect(rowsIn(directory, segmentName(1))).toHaveLength(2);
		const segment1 = identity(swarm(directory, segmentName(1)));

		// Pass 3: segment 1 is full too, so it is sealed and segment 2 is created.
		await closedPhase(directory, base + 21 * DAY_MS, 'Phase 3', ['c1']);
		await sweepAt(40);
		expect(segmentFiles(directory)).toEqual([
			segmentName(0),
			segmentName(1),
			segmentName(2),
		]);
		expect(identity(swarm(directory, segmentName(0)))).toBe(segment0);
		expect(identity(swarm(directory, segmentName(1)))).toBe(segment1);
		expect(rowsIn(directory, segmentName(2))).toHaveLength(1);

		const history = unwrap(await queryHistoricalOutcomes(directory));
		expect(history.memberships.map((m) => m.entry_id).sort()).toEqual([
			'a1',
			'a2',
			'a3',
			'b1',
			'b2',
			'c1',
		]);
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
	});

	test('the newest copy of a key wins across segments', async () => {
		// Same trace/entry in two directories: one unresolved, one resolved.
		const unresolved = project('receipt-segments-newest-a-');
		const resolved = project('receipt-segments-newest-b-');
		const base = Date.now();
		for (const directory of [unresolved, resolved]) {
			await closedPhase(directory, base, 'Phase 1', ['x'], 'session-x');
		}
		unwrap(
			await validateAndCommitTerminalBatch(resolved, {
				trace_id: 'trace-Phase 1',
				session_id: 'session-x',
				items: [{ entry_id: 'x', outcome: 'applied' }],
			}),
		);
		_internals.nowMs = () => base + 8 * DAY_MS;
		unwrap(await compactKnowledgeReceiptLedger(unresolved));
		unwrap(await compactKnowledgeReceiptLedger(resolved));

		// Older copy (unresolved) in the sealed base segment, newer copy
		// (resolved) in segment 1, exactly what an interrupted pass followed by
		// a later terminal produces.
		const target = project('receipt-segments-newest-target-');
		fs.mkdirSync(swarm(target), { recursive: true });
		fs.copyFileSync(
			swarm(unresolved, segmentName(0)),
			swarm(target, segmentName(0)),
		);
		fs.copyFileSync(
			swarm(resolved, segmentName(0)),
			swarm(target, segmentName(1)),
		);

		const history = unwrap(await queryHistoricalOutcomes(target, ['x']));
		expect(history.memberships).toHaveLength(1);
		expect(history.memberships[0]?.terminal?.outcome).toBe('applied');
	});

	test('a damaged sealed segment fails history typed but never blocks live receipt operations', async () => {
		const directory = project('receipt-segments-sealed-corrupt-');
		const base = Date.now();
		_internals.maxArchiveRecords = 1;
		await closedPhase(directory, base, 'Phase 1', ['c1']);
		_internals.nowMs = () => base + 8 * DAY_MS;
		unwrap(await compactKnowledgeReceiptLedger(directory));
		await closedPhase(directory, base + 9 * DAY_MS, 'Phase 2', ['c2']);
		_internals.nowMs = () => base + 20 * DAY_MS;
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(segmentFiles(directory)).toHaveLength(2);

		// Segment 0 is now sealed; damage it.
		fs.writeFileSync(swarm(directory, segmentName(0)), '{not valid}\n');

		const history = await queryHistoricalOutcomes(directory);
		expect(history.ok).toBe(false);
		if (!history.ok) expect(history.code).toBe('store_corrupt');
		// Terminals, gates and compaction never read a sealed segment.
		_internals.nowMs = () => base + 9 * DAY_MS;
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-fresh',
				session_id: 'session-fresh',
				phase: 'Phase 9',
				entries: [{ entry_id: 'fresh', critical: false }],
				exposure_kind: 'delegate_directive',
			}),
		);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(
			unwrap(await queryLiveMemberships(directory)).memberships.map(
				(m) => m.entry_id,
			),
		).toEqual(['fresh']);
	});

	test('a history read over the budget fails typed while live operations keep working', async () => {
		const directory = project('receipt-segments-budget-');
		const base = Date.now();
		await closedPhase(directory, base, 'Phase 1', ['d1']);
		_internals.nowMs = () => base + 8 * DAY_MS;
		unwrap(await compactKnowledgeReceiptLedger(directory));

		_internals.maxArchiveHistoryBytes = 1;
		const originalWarn = console.warn;
		console.warn = () => undefined; // the one-time budget warning is expected
		const history = await queryHistoricalOutcomes(directory).finally(() => {
			console.warn = originalWarn;
		});
		expect(history.ok).toBe(false);
		if (!history.ok) {
			expect(history.code).toBe('store_unavailable');
			expect(history.detail).toContain('history read budget');
		}
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
	});

	test('files that only look like segments are ignored, and real ones must be regular files', async () => {
		const directory = project('receipt-segments-names-');
		const base = Date.now();
		await closedPhase(directory, base, 'Phase 1', ['n1']);
		_internals.nowMs = () => base + 8 * DAY_MS;
		unwrap(await compactKnowledgeReceiptLedger(directory));

		for (const decoy of [
			'knowledge-receipts-v2-archive.000000.jsonl',
			'knowledge-receipts-v2-archive.1.jsonl',
			'knowledge-receipts-v2-archive.abc123.jsonl',
			'knowledge-receipts-v2-archive.000009.jsonl.1234.tmp',
			'knowledge-receipts-v2-archive.jsonl.bak',
		]) {
			fs.writeFileSync(swarm(directory, decoy), '{garbage}\n');
			expect(isReceiptArchiveSegmentName(decoy)).toBe(false);
		}
		const paths = resolveReceiptLedgerPaths(directory);
		const listing = await listReceiptArchiveSegments(paths);
		expect(listing.segments.map((s) => s.index)).toEqual([0]);
		expect([...listing.occupied]).toEqual([0]);
		expect(listing.irregular).toEqual([]);
		expect(
			unwrap(await queryHistoricalOutcomes(directory)).memberships,
		).toHaveLength(1);

		// A segment that is a symlink is refused, never followed.
		const link = swarm(directory, segmentName(3));
		try {
			fs.symlinkSync(swarm(directory, segmentName(0)), link);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') return;
			throw error;
		}
		const refused = await queryHistoricalOutcomes(directory);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.code).toBe('store_unavailable');
	});

	test('segment paths are zero-padded, contained, and bounded', () => {
		const directory = project('receipt-segments-paths-');
		fs.mkdirSync(swarm(directory), { recursive: true });
		const paths = resolveReceiptLedgerPaths(directory);
		expect(receiptArchiveSegmentPath(paths, 0)).toBe(paths.archive);
		expect(receiptArchiveSegmentPath(paths, 7)).toBe(
			swarm(paths.root, segmentName(7)),
		);
		for (const bad of [-1, 1.5, MAX_RECEIPT_ARCHIVE_SEGMENT_INDEX + 1]) {
			expect(() => receiptArchiveSegmentPath(paths, bad)).toThrow(
				'segment index is out of range',
			);
		}
	});

	test('an interrupted pass followed by a terminal replaces the stale copy instead of losing it', async () => {
		const directory = project('receipt-segments-replace-');
		const base = Date.now();
		_internals.nowMs = () => base;
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-replace',
				session_id: 'session-replace',
				phase: 'Phase 1',
				grace_days: 0,
				entries: [{ entry_id: 'r1', critical: false }],
				exposure_kind: 'delegate_directive',
			}),
		);
		// The close archives the unresolved row, then the checkpoint write
		// "crashes": the row is now BOTH live and archived (unresolved copy).
		let archiveWritten = false;
		_internals.atomicWriteFsynced = async (target, content) => {
			if (target.endsWith(segmentName(0))) archiveWritten = true;
			if (archiveWritten && target.endsWith('knowledge-receipts-v2.jsonl')) {
				throw new Error('injected checkpoint crash');
			}
			await originalAtomicWrite(target, content);
		};
		const crashed = await commitPhaseClosed(
			directory,
			'Phase 1',
			'session-replace',
		);
		expect(crashed.ok).toBe(false);
		expect(archiveWritten).toBe(true);
		_internals.atomicWriteFsynced = originalAtomicWrite;
		expect(rowsIn(directory, segmentName(0))).toHaveLength(1);

		// The live row is then resolved; the next pass must write the NEWER copy.
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-replace',
				session_id: 'session-replace',
				items: [{ entry_id: 'r1', outcome: 'applied' }],
			}),
		);
		unwrap(await compactKnowledgeReceiptLedger(directory));

		expect(rowsIn(directory, segmentName(0))).toHaveLength(1);
		const history = unwrap(await queryHistoricalOutcomes(directory, ['r1']));
		expect(history.memberships).toHaveLength(1);
		expect(history.memberships[0]?.terminal?.outcome).toBe('applied');
	});
});
