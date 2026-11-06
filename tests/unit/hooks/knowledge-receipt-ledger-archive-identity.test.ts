import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAuthoritativeKnowledgeCounterRollups } from '../../../src/hooks/knowledge-events.js';
import {
	_internals,
	commitDisplayedMembership,
	commitPhaseClosed,
	queryHistoricalOutcomes,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { isReceiptArchiveSegmentName } from '../../../src/hooks/knowledge-receipt-ledger-storage.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

/**
 * Archive rows are identified by the membership INSTANCE (trace, entry AND the
 * immutable membership event id), not by (trace, entry) alone. A membership
 * that was archived leaves the live state, so the same (trace, entry) can be
 * committed again by a session whose own lifecycle is still open; that is a
 * NEW membership and must neither overwrite the archived one (losing its
 * outcome) nor be mistaken for a copy of it (double-counting a crash leftover).
 */

const TRACE = 'trace-shared';
const cleanups: Array<() => void> = [];
const originalNowMs = _internals.nowMs;
const originalMaxArchiveRecords = _internals.maxArchiveRecords;

afterEach(() => {
	_internals.nowMs = originalNowMs;
	_internals.maxArchiveRecords = originalMaxArchiveRecords;
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

/** Event ids of every archived row of `entryId`, per segment file. */
function archivedInstances(directory: string, entryId: string): string[] {
	const swarm = path.join(directory, '.swarm');
	return fs
		.readdirSync(swarm)
		.filter((name) => isReceiptArchiveSegmentName(name))
		.flatMap((name) =>
			fs
				.readFileSync(path.join(swarm, name), 'utf8')
				.split('\n')
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							entry_id: string;
							membership_event_id: string;
						},
				)
				.filter((row) => row.entry_id === entryId)
				.map((row) => `${name}#${row.membership_event_id}`),
		);
}

async function expose(
	directory: string,
	session: string,
	phase: string,
	entryId: string,
	trace = TRACE,
): Promise<void> {
	unwrap(
		await commitDisplayedMembership(directory, {
			trace_id: trace,
			session_id: session,
			phase,
			grace_days: 0,
			entries: [{ entry_id: entryId, critical: false }],
			exposure_kind: 'delegate_directive',
		}),
	);
}

describe('a re-created (trace, entry) is a new membership, never an overwrite or a duplicate', () => {
	test('an archived outcome is not replaced by a later unresolved exposure of the same trace/entry', async () => {
		const directory = project('receipt-archive-identity-tail-');
		let clock = Date.now();
		_internals.nowMs = () => clock;

		await expose(directory, 'SA', 'Phase 1', 'e1');
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: TRACE,
				session_id: 'SA',
				items: [{ entry_id: 'e1', outcome: 'applied' }],
			}),
		);
		clock += 1000;
		// A different session closes the phase: SA's resolved row is archived.
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'SB'));
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		expect(archivedInstances(directory, 'e1')).toHaveLength(1);

		// SA's own lifecycle is still open, so the same (trace, entry) is
		// accepted again as a brand-new membership; another session closes it.
		clock += 1000;
		await expose(directory, 'SA', 'Phase 1', 'e1');
		clock += 1000;
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'SC'));

		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		// Both instances survive: the applied outcome was not overwritten.
		expect(archivedInstances(directory, 'e1')).toHaveLength(2);
		const history = unwrap(await queryHistoricalOutcomes(directory, ['e1']));
		expect(history.memberships).toHaveLength(2);
		expect(
			history.memberships.filter((m) => m.terminal?.outcome === 'applied'),
		).toHaveLength(1);
		const rollup = (
			await readAuthoritativeKnowledgeCounterRollups(directory)
		).get('e1');
		expect(rollup?.shown_count).toBe(2);
		expect(rollup?.applied_explicit_count).toBe(1);
	});

	test('a re-created membership is counted once per instance even when the first one is sealed', async () => {
		const directory = project('receipt-archive-identity-sealed-');
		let clock = Date.now();
		_internals.nowMs = () => clock;
		_internals.maxArchiveRecords = 1;

		await expose(directory, 'SA', 'Phase 1', 'e1');
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: TRACE,
				session_id: 'SA',
				items: [{ entry_id: 'e1', outcome: 'applied' }],
			}),
		);
		clock += 1000;
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'SB'));
		// A second archived row seals the first segment (1-row threshold).
		clock += 1000;
		await expose(directory, 'S2', 'Phase 2', 'e2', 'trace-other');
		clock += 1000;
		unwrap(await commitPhaseClosed(directory, 'Phase 2', 'S2'));
		// ...and a third seals the second, so e1's first copy is deep in a
		// sealed segment the purge can never reach.
		clock += 1000;
		await expose(directory, 'S3', 'Phase 3', 'e3', 'trace-third');
		clock += 1000;
		unwrap(await commitPhaseClosed(directory, 'Phase 3', 'S3'));

		clock += 1000;
		await expose(directory, 'SA', 'Phase 1', 'e1');
		clock += 1000;
		unwrap(await commitPhaseClosed(directory, 'Phase 1', 'SC'));

		const instances = archivedInstances(directory, 'e1');
		expect(instances).toHaveLength(2);
		// Two distinct memberships in two different segment files.
		expect(new Set(instances.map((x) => x.split('#')[1])).size).toBe(2);
		expect(new Set(instances.map((x) => x.split('#')[0])).size).toBe(2);
		const history = unwrap(await queryHistoricalOutcomes(directory, ['e1']));
		expect(history.memberships).toHaveLength(2);
		const rollup = (
			await readAuthoritativeKnowledgeCounterRollups(directory)
		).get('e1');
		// Shown twice (two real exposures), applied once.
		expect(rollup?.shown_count).toBe(2);
		expect(rollup?.applied_explicit_count).toBe(1);
	});
});
