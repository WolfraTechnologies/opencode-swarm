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

/**
 * Deterministic randomized crash test for the receipt archive. Each trial runs
 * a random sequence of exposures, terminals, phase closes, time jumps, sweeps
 * and INJECTED CRASHES (a failed write at a random point of a compaction
 * pass), under a random segment threshold. After EVERY step it asserts the
 * three properties the segmented archive exists to guarantee:
 *   1. nothing is lost  - every committed row is live or in a segment;
 *   2. nothing is duplicated across segments;
 *   3. the counter rollups count every row exactly once.
 * Failures print the seed, step and operation so they replay exactly.
 *
 * Verified power: it fails on a pass that loses rows when a retried pass seals
 * the tail, and on a pass without the seal-time purge of still-live rows. It
 * does NOT detect a dropped "rewrite the tail when a changed row's stale copy
 * was removed" (see the deterministic safety test), nor does it exercise empty
 * traces, concurrent processes, repair, or partial files inside a write.
 */

const DAY_MS = 86_400_000;
const TRIALS = 45;
const STEPS = 16;
const cleanups: Array<() => void> = [];
const originalNowMs = _internals.nowMs;
const originalMaxArchiveRecords = _internals.maxArchiveRecords;
const originalMaxArchiveBytes = _internals.maxArchiveBytes;
const originalAtomicWrite = _internals.atomicWriteFsynced;

afterEach(() => {
	_internals.nowMs = originalNowMs;
	_internals.maxArchiveRecords = originalMaxArchiveRecords;
	_internals.maxArchiveBytes = originalMaxArchiveBytes;
	_internals.atomicWriteFsynced = originalAtomicWrite;
	while (cleanups.length > 0) cleanups.pop()?.();
});

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

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

function segmentHolders(directory: string): Map<string, string[]> {
	const swarm = path.join(directory, '.swarm');
	const holders = new Map<string, string[]>();
	for (const name of fs.readdirSync(swarm)) {
		if (!isReceiptArchiveSegmentName(name)) continue;
		for (const line of fs
			.readFileSync(path.join(swarm, name), 'utf8')
			.split('\n')) {
			if (!line) continue;
			const id = (JSON.parse(line) as { entry_id: string }).entry_id;
			holders.set(id, [...(holders.get(id) ?? []), name]);
		}
	}
	return holders;
}

async function assertInvariants(
	directory: string,
	universe: Set<string>,
	/** Ids for which a terminal commit was acknowledged: it must never be lost. */
	resolvedIds: Set<string>,
	label: string,
): Promise<void> {
	const live = new Set(
		unwrap(await queryLiveMemberships(directory, {})).memberships.map(
			(m) => m.entry_id,
		),
	);
	const holders = segmentHolders(directory);
	const rollups = await readAuthoritativeKnowledgeCounterRollups(directory);
	const history = unwrap(await queryHistoricalOutcomes(directory));
	const historyIds = history.memberships.map((m) => m.entry_id);
	for (const id of universe) {
		const files = holders.get(id) ?? [];
		const where = { label, id, live: live.has(id), files };
		// 1. no loss
		expect({ ...where, lost: !live.has(id) && files.length === 0 }).toEqual({
			...where,
			lost: false,
		});
		// 2. no duplication across segments
		expect({ ...where, copies: files.length <= 1 }).toEqual({
			...where,
			copies: true,
		});
		// 3. exact counters, and exact full history
		expect({ ...where, shown: rollups.get(id)?.shown_count }).toEqual({
			...where,
			shown: 1,
		});
		expect({
			...where,
			inHistory: historyIds.filter((x) => x === id).length,
		}).toEqual({ ...where, inHistory: 1 });
		// 4. an acknowledged terminal is never hidden behind a stale archived copy
		if (resolvedIds.has(id)) {
			const outcome = history.memberships.find((m) => m.entry_id === id)
				?.terminal?.outcome;
			expect({ ...where, outcome }).toEqual({ ...where, outcome: 'applied' });
		}
	}
}

describe('receipt archive: randomized crash/rollover invariants', () => {
	test(`${TRIALS} seeded trials x ${STEPS} random steps never lose, duplicate or miscount a row`, async () => {
		for (let seed = 1; seed <= TRIALS; seed++) {
			const rand = mulberry32(seed * 7919);
			const pick = <T>(items: readonly T[]): T =>
				items[Math.floor(rand() * items.length)] as T;
			const directory = project(`receipt-archive-fuzz-${seed}-`);
			let clock = Date.now();
			_internals.nowMs = () => clock;
			const profile = seed % 3;
			// Rows are ~300-700 bytes: 1500 holds a few, 3000 more, 16 MiB never
			// binds. Profile 2 pins a byte cap that fits three plain rows but not
			// two plus one that carries a terminal, with a record cap that never
			// binds, so only a CHANGED row can force a seal.
			_internals.maxArchiveRecords = profile === 2 ? 50 : pick([1, 2, 3, 50]);
			_internals.maxArchiveBytes =
				profile === 2 ? 1200 : pick([1500, 3000, 16 * 1024 * 1024]);

			const universe = new Set<string>();
			const resolvedIds = new Set<string>();
			const groups: Array<{ trace: string; session: string; ids: string[] }> =
				[];
			/** File a terminal for a whole group; remember it only if acknowledged. */
			const fileTerminal = async (group: {
				trace: string;
				session: string;
				ids: string[];
			}): Promise<void> => {
				const result = await validateAndCommitTerminalBatch(directory, {
					trace_id: group.trace,
					session_id: group.session,
					items: group.ids.map((entry_id) => ({
						entry_id,
						outcome: 'applied' as const,
					})),
				});
				if (result.ok && result.rejected.length === 0) {
					for (const id of group.ids) resolvedIds.add(id);
				}
			};
			const open: Array<{ phase: string; session: string }> = [];
			let nextRow = 0;
			let nextPhase = 0;

			/**
			 * Inject a failure into the next compaction: at the k-th atomic write,
			 * or ('checkpoint') exactly when the journal checkpoint is written —
			 * i.e. AFTER every archive file of the pass is on disk, the one moment
			 * that leaves rows both live and archived.
			 */
			const failWrite = (mode: number | 'checkpoint'): void => {
				let writes = 0;
				_internals.atomicWriteFsynced = async (target, content) => {
					writes += 1;
					const isCheckpoint = target.endsWith('knowledge-receipts-v2.jsonl');
					if (mode === 'checkpoint' ? isCheckpoint : writes === mode) {
						throw new Error('injected write failure');
					}
					await originalAtomicWrite(target, content);
				};
			};
			/**
			 * Three generator profiles, rotated by seed, because each reaches
			 * interleavings the others rarely do:
			 *  - 0: grace and time jumps independent of resolution (finds retries
			 *    of an interrupted over-threshold pass);
			 *  - 1: unresolved rows expire the moment their phase closes (sweep
			 *    only) while resolved rows wait a week (eligible to ORDINARY passes
			 *    once it elapses), and time jumps often cross that week - the mix
			 *    that lets an ordinary pass seal a tail an interrupted sweep left
			 *    rows in;
			 *  - 2: rows are never resolved up front; crashed closes leave them
			 *    live AND in a nearly-full tail, then late terminals change them,
			 *    so the next pass must replace a stale copy (and possibly seal).
			 *    This profile PROBES that interleaving but was not observed to
			 *    detect its worst case (a stale copy left in a sealed tail); that
			 *    is guarded deterministically by the "changed live row ... forces
			 *    a seal" test in knowledge-receipt-ledger-archive-safety.test.ts.
			 */
			const graceFor = (resolved: boolean): number =>
				profile === 1
					? resolved
						? 7
						: 0
					: profile === 2
						? 0
						: pick([0, 0, 7]);
			const tickDays = (): number =>
				profile === 1
					? pick([0, 1, 8, 8])
					: profile === 2
						? pick([0, 1])
						: Math.floor(rand() * 9);
			const randomFailure = (): number | 'checkpoint' =>
				rand() < 0.6 ? 'checkpoint' : 1 + Math.floor(rand() * 3);
			const restoreWrites = (): void => {
				_internals.atomicWriteFsynced = originalAtomicWrite;
			};

			for (let step = 0; step < STEPS; step++) {
				const op = pick(
					profile === 2
						? ([
								'expose',
								'expose',
								'crash-close',
								'crash-close',
								'crash-close',
								'late-terminal',
								'late-terminal',
								'late-terminal',
								'sweep',
								'close',
							] as const)
						: ([
								'expose',
								'expose',
								'close',
								'close',
								'tick',
								'tick',
								'sweep',
								'crash-sweep',
								'crash-sweep',
								'crash-close',
								'late-terminal',
								'late-terminal',
							] as const),
				);
				const label = `seed ${seed} step ${step} op ${op} (threshold ${_internals.maxArchiveRecords})`;

				if (op === 'expose') {
					const phase = `P${nextPhase}`;
					const session = `S${nextPhase}`;
					nextPhase += 1;
					const ids = Array.from(
						{ length: 1 + Math.floor(rand() * 3) },
						() => `e${nextRow++}`,
					);
					const resolved = profile === 2 ? false : rand() < 0.5;
					unwrap(
						await commitDisplayedMembership(directory, {
							trace_id: `trace-${phase}`,
							session_id: session,
							phase,
							grace_days: graceFor(resolved),
							entries: ids.map((entry_id) => ({ entry_id, critical: false })),
							exposure_kind: 'delegate_directive',
						}),
					);
					for (const id of ids) universe.add(id);
					const group = { trace: `trace-${phase}`, session, ids };
					groups.push(group);
					if (resolved) await fileTerminal(group);
					open.push({ phase, session });
				} else if (op === 'late-terminal') {
					// A terminal filed after the row may already have been archived
					// (accepted while it is still live, rejected once it is gone).
					if (groups.length === 0) continue;
					await fileTerminal(pick(groups));
				} else if (op === 'close' || op === 'crash-close') {
					if (open.length === 0) continue;
					const at = Math.floor(rand() * open.length);
					const target = open[at] as { phase: string; session: string };
					if (op === 'crash-close') failWrite(randomFailure());
					const closed = await commitPhaseClosed(
						directory,
						target.phase,
						target.session,
					);
					restoreWrites();
					// A crash can land in the compaction that runs BEFORE the close
					// record is appended, so a failed close may not have happened at
					// all. Only a close that reported success removes the phase; the
					// settle step re-closes the rest (a repeated close is idempotent).
					if (closed.ok) open.splice(at, 1);
				} else if (op === 'tick') {
					clock += tickDays() * DAY_MS;
				} else if (op === 'sweep') {
					await compactKnowledgeReceiptLedger(directory);
				} else {
					failWrite(randomFailure());
					await compactKnowledgeReceiptLedger(directory);
					restoreWrites();
				}
				await assertInvariants(directory, universe, resolvedIds, label);
			}

			// Settle: no crashes, everything expired -> every row archived once.
			restoreWrites();
			clock += 60 * DAY_MS;
			for (const entry of open.splice(0)) {
				await commitPhaseClosed(directory, entry.phase, entry.session);
			}
			clock += 60 * DAY_MS;
			unwrap(await compactKnowledgeReceiptLedger(directory));
			await assertInvariants(
				directory,
				universe,
				resolvedIds,
				`seed ${seed} settled`,
			);
			const live = unwrap(await queryLiveMemberships(directory, {}));
			expect({ seed, live: live.memberships.length }).toEqual({
				seed,
				live: 0,
			});
		}
	}, 180_000);
});
