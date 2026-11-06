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
	type ReceiptExposureKind,
	type ReceiptLedgerResult,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const DAY_MS = 86_400_000;
const cleanups: Array<() => void> = [];
const originalNowMs = _internals.nowMs;
const originalMaxArchiveRecords = _internals.maxArchiveRecords;
const originalMaxJournalRecords = _internals.maxJournalRecords;

afterEach(() => {
	_internals.nowMs = originalNowMs;
	_internals.maxArchiveRecords = originalMaxArchiveRecords;
	_internals.maxJournalRecords = originalMaxJournalRecords;
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

const journalPath = (directory: string): string =>
	path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl');
const archivePath = (directory: string): string =>
	path.join(directory, '.swarm', 'knowledge-receipts-v2-archive.jsonl');

async function expose(
	directory: string,
	input: {
		trace: string;
		session: string;
		phase: string;
		phaseId?: number;
		entries: string[];
		kind?: ReceiptExposureKind;
	},
): Promise<void> {
	unwrap(
		await commitDisplayedMembership(directory, {
			trace_id: input.trace,
			session_id: input.session,
			phase: input.phase,
			...(input.phaseId !== undefined ? { phase_id: input.phaseId } : {}),
			entries: input.entries.map((entry_id) => ({ entry_id, critical: false })),
			exposure_kind: input.kind ?? 'delegate_directive',
		}),
	);
}

/** Pin the ledger clock `days` from a fixed base; commits stamp with it. */
function clockAt(base: number, days: number): void {
	_internals.nowMs = () => base + days * DAY_MS;
}

async function liveEntryIds(directory: string): Promise<string[]> {
	const live = unwrap(await queryLiveMemberships(directory, {}));
	return live.memberships.map((m) => m.entry_id).sort();
}

function archivedEntryIds(directory: string): string[] {
	if (!fs.existsSync(archivePath(directory))) return [];
	return fs
		.readFileSync(archivePath(directory), 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { entry_id: string }).entry_id)
		.sort();
}

describe('closed-phase receipt expiry', () => {
	test('unresolved exposures from sessions that never closed the phase age out after grace', async () => {
		const directory = project('receipt-expiry-orphans-');
		const base = Date.now();
		clockAt(base, 0);
		// Session A closes the phase; B (a delegate lane / earlier session) never does.
		await expose(directory, {
			trace: 't-a',
			session: 'session-a',
			phase: 'Phase 1',
			entries: ['a-1', 'a-2'],
			kind: 'architect_directive',
		});
		await expose(directory, {
			trace: 't-b',
			session: 'session-b',
			phase: 'Phase 1',
			entries: ['b-1', 'b-2', 'b-3'],
		});
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));

		// Inside the grace window nothing moves, for either session.
		clockAt(base, 6);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual([
			'a-1',
			'a-2',
			'b-1',
			'b-2',
			'b-3',
		]);
		expect(archivedEntryIds(directory)).toEqual([]);

		// Past grace, BOTH sessions' unresolved rows are archived.
		clockAt(base, 8);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual([]);
		expect(archivedEntryIds(directory)).toEqual([
			'a-1',
			'a-2',
			'b-1',
			'b-2',
			'b-3',
		]);
	});

	test('archiving preserves historical outcome authority and the shown-count rollups', async () => {
		const directory = project('receipt-expiry-history-');
		const base = Date.now();
		clockAt(base, 0);
		await expose(directory, {
			trace: 't-1',
			session: 'session-a',
			phase: 'Phase 1',
			entries: ['resolved', 'unresolved'],
		});
		await expose(directory, {
			trace: 't-2',
			session: 'session-b',
			phase: 'Phase 1',
			entries: ['orphan'],
		});
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 't-1',
				session_id: 'session-a',
				items: [{ entry_id: 'resolved', outcome: 'applied' }],
			}),
		);
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));
		const historyBefore = unwrap(await queryHistoricalOutcomes(directory));
		const rollupsBefore =
			await readAuthoritativeKnowledgeCounterRollups(directory);
		expect(rollupsBefore.get('orphan')?.shown_count).toBe(1);
		expect(rollupsBefore.get('unresolved')?.shown_count).toBe(1);

		clockAt(base, 8);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual([]);
		expect(archivedEntryIds(directory)).toEqual([
			'orphan',
			'resolved',
			'unresolved',
		]);

		const historyAfter = unwrap(await queryHistoricalOutcomes(directory));
		expect(historyAfter.memberships.length).toBe(
			historyBefore.memberships.length,
		);
		expect(
			historyAfter.memberships.find((m) => m.entry_id === 'resolved')?.terminal,
		).toMatchObject({ outcome: 'applied' });
		// The rollups are derived from live + archive, so moving rows between the
		// two must not change a single counter.
		const rollupsAfter =
			await readAuthoritativeKnowledgeCounterRollups(directory);
		expect([...rollupsAfter.entries()].sort()).toEqual(
			[...rollupsBefore.entries()].sort(),
		);
	});

	test('an open phase is never expired, however old its exposures are', async () => {
		const directory = project('receipt-expiry-open-');
		const base = Date.now();
		clockAt(base, 0);
		await expose(directory, {
			trace: 't-1',
			session: 'session-a',
			phase: 'Phase 1',
			entries: ['closed-1'],
		});
		await expose(directory, {
			trace: 't-2',
			session: 'session-a',
			phase: 'Phase 2',
			entries: ['open-1'],
		});
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));

		clockAt(base, 400);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual(['open-1']);
	});

	test('the stable phase id outranks a drifted label', async () => {
		const directory = project('receipt-expiry-id-');
		const base = Date.now();
		clockAt(base, 0);
		// Label says "Phase 1" but the explicit id is 2: this exposure belongs to
		// phase 2, which is still open. A label coincidence must not expire it.
		await expose(directory, {
			trace: 't-1',
			session: 'session-b',
			phase: 'Phase 1',
			phaseId: 2,
			entries: ['id-two'],
		});
		await expose(directory, {
			trace: 't-2',
			session: 'session-b',
			phase: 'Phase 1',
			phaseId: 1,
			entries: ['id-one'],
		});
		unwrap(
			await commitPhaseClosed(directory, 'Phase 1', 'session-a', undefined, 1),
		);

		clockAt(base, 8);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual(['id-two']);
	});

	test('phase ids reused by a later plan are not expired by an earlier plan close', async () => {
		// `/swarm close` keeps the receipt ledger, and a new plan restarts at
		// phase 1. The old plan's closed lifecycle for phase id 1 must not expire
		// the new plan's exposures of its own, still-open, phase 1.
		const directory = project('receipt-expiry-reused-id-');
		const base = Date.now();
		clockAt(base, -40);
		await expose(directory, {
			trace: 't-old',
			session: 'session-a',
			phase: 'Phase 1',
			phaseId: 1,
			entries: ['old-plan'],
		});
		unwrap(
			await commitPhaseClosed(directory, 'Phase 1', 'session-a', undefined, 1),
		);

		// New plan, new session, phase 1 open: committed 10 days ago, which is
		// well past the 7-day grace measured from ITS OWN commit.
		clockAt(base, -10);
		await expose(directory, {
			trace: 't-new',
			session: 'session-b',
			phase: 'Phase 1',
			phaseId: 1,
			entries: ['new-plan'],
		});

		clockAt(base, 0);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual(['new-plan']);
		expect(archivedEntryIds(directory)).toEqual(['old-plan']);
		const terminal = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 't-new',
				session_id: 'session-b',
				items: [{ entry_id: 'new-plan', outcome: 'applied' }],
			}),
		);
		expect(terminal.committed.length).toBe(1);

		// Still live a long time later — only a close that FOLLOWS its commit can
		// expire it, and the new plan has not closed phase 1.
		clockAt(base, 90);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual(['new-plan']);

		// Once the new plan really closes phase 1 (from another session, so only
		// the lifecycle fallback can reach it), the grace clock runs from that
		// close and the row ages out normally.
		unwrap(
			await commitPhaseClosed(directory, 'Phase 1', 'session-c', undefined, 1),
		);
		clockAt(base, 100);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual([]);
		expect(archivedEntryIds(directory)).toEqual(['new-plan', 'old-plan']);
	});

	test('ordinary operations leave unresolved expiry to the sweep', async () => {
		const directory = project('receipt-expiry-sweep-gate-');
		const base = Date.now();
		clockAt(base, 0);
		await expose(directory, {
			trace: 't-1',
			session: 'session-b',
			phase: 'Phase 1',
			entries: ['orphan'],
		});
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));

		clockAt(base, 8);
		// An unrelated membership commit runs the per-operation compaction. It
		// keeps its original cost profile: unresolved rows are not even scanned.
		await expose(directory, {
			trace: 't-2',
			session: 'session-d',
			phase: 'Phase 2',
			entries: ['unrelated'],
		});
		expect(await liveEntryIds(directory)).toEqual(['orphan', 'unrelated']);
		expect(archivedEntryIds(directory)).toEqual([]);

		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(await liveEntryIds(directory)).toEqual(['unrelated']);
		expect(archivedEntryIds(directory)).toEqual(['orphan']);
	});

	test('closing a later phase sweeps earlier phases whose grace has elapsed', async () => {
		// Phase close is the production trigger for the sweep. Nothing here calls
		// compactKnowledgeReceiptLedger.
		const directory = project('receipt-expiry-close-trigger-');
		const base = Date.now();
		clockAt(base, 0);
		await expose(directory, {
			trace: 't-1',
			session: 'session-b',
			phase: 'Phase 1',
			entries: ['phase-one-orphan'],
		});
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));

		clockAt(base, 8);
		await expose(directory, {
			trace: 't-2',
			session: 'session-a',
			phase: 'Phase 2',
			entries: ['phase-two'],
		});
		// Still live: an ordinary operation never sweeps.
		expect(await liveEntryIds(directory)).toEqual([
			'phase-one-orphan',
			'phase-two',
		]);

		unwrap(await commitPhaseClosed(directory, 'Phase 2', 'session-a'));
		expect(archivedEntryIds(directory)).toEqual(['phase-one-orphan']);
		// Phase 2 just closed: its own grace window has not elapsed.
		expect(await liveEntryIds(directory)).toEqual(['phase-two']);
	});

	test('the record-count checkpoint threshold also sweeps expired closed-phase rows', async () => {
		const directory = project('receipt-expiry-threshold-trigger-');
		const base = Date.now();
		clockAt(base, 0);
		await expose(directory, {
			trace: 't-1',
			session: 'session-b',
			phase: 'Phase 1',
			entries: ['orphan'],
		});
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));

		clockAt(base, 8);
		// An ordinary operation forces a checkpoint rewrite once the journal
		// holds more records than the threshold; the rewrite is the moment the
		// sweep rides along.
		_internals.maxJournalRecords = 1;
		await expose(directory, {
			trace: 't-2',
			session: 'session-d',
			phase: 'Phase 2',
			entries: ['unrelated'],
		});
		expect(archivedEntryIds(directory)).toEqual(['orphan']);
		expect(await liveEntryIds(directory)).toEqual(['unrelated']);
	});

	test('a session cannot add exposures to a phase it already closed, which the id-reuse rule relies on', async () => {
		const directory = project('receipt-expiry-same-session-');
		const base = Date.now();
		clockAt(base, 0);
		await expose(directory, {
			trace: 't-1',
			session: 'session-a',
			phase: 'Phase 1',
			phaseId: 1,
			entries: ['before-close'],
		});
		unwrap(
			await commitPhaseClosed(directory, 'Phase 1', 'session-a', undefined, 1),
		);

		const later = await commitDisplayedMembership(directory, {
			trace_id: 't-2',
			session_id: 'session-a',
			phase: 'Phase 1',
			phase_id: 1,
			entries: [{ entry_id: 'after-close', critical: false }],
			exposure_kind: 'delegate_directive',
		});
		expect(later.ok).toBe(false);
		expect(await liveEntryIds(directory)).toEqual(['before-close']);
	});

	test('resolved history is offered to a short archive before expired unresolved exposures', async () => {
		const directory = project('receipt-expiry-priority-');
		const base = Date.now();
		clockAt(base, 0);
		// The unresolved row is OLDER and would win a first-come race.
		await expose(directory, {
			trace: 't-unresolved',
			session: 'session-b',
			phase: 'Phase 1',
			entries: ['unresolved-first'],
		});
		await expose(directory, {
			trace: 't-resolved',
			session: 'session-a',
			phase: 'Phase 1',
			entries: ['resolved-later'],
		});
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 't-resolved',
				session_id: 'session-a',
				items: [{ entry_id: 'resolved-later', outcome: 'applied' }],
			}),
		);
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));

		_internals.maxArchiveRecords = 1;
		clockAt(base, 8);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(archivedEntryIds(directory)).toEqual(['resolved-later']);
		expect(await liveEntryIds(directory)).toEqual(['unresolved-first']);
	});

	test('archive capacity pressure keeps the overflow live and does not rewrite the journal', async () => {
		const directory = project('receipt-expiry-capacity-');
		const base = Date.now();
		clockAt(base, 0);
		await expose(directory, {
			trace: 't-1',
			session: 'session-b',
			phase: 'Phase 1',
			entries: ['e-1', 'e-2', 'e-3'],
		});
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'session-a'));

		_internals.maxArchiveRecords = 1;
		clockAt(base, 8);
		unwrap(await compactKnowledgeReceiptLedger(directory));
		// Exactly one row fits; prior authority is never discarded for the rest.
		expect((await liveEntryIds(directory)).length).toBe(2);
		expect(archivedEntryIds(directory)).toHaveLength(1);
		const historical = unwrap(await queryHistoricalOutcomes(directory));
		expect(historical.memberships.map((m) => m.entry_id).sort()).toEqual([
			'e-1',
			'e-2',
			'e-3',
		]);

		// Still over capacity and nothing more can move: further sweeps must not
		// rewrite an identical checkpoint each time.
		const journalBefore = fs.readFileSync(journalPath(directory), 'utf8');
		unwrap(await compactKnowledgeReceiptLedger(directory));
		unwrap(await compactKnowledgeReceiptLedger(directory));
		expect(fs.readFileSync(journalPath(directory), 'utf8')).toBe(journalBefore);
	});
});
