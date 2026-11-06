---
---

## phase_complete no longer wedges on a large knowledge receipt journal; closed-phase receipts now age out

- **The receipt journal no longer counts against the phase snapshot byte budget.**
  `snapshot_identity` hashed `.swarm/knowledge-receipts-v2.jsonl` into the same fixed 16 MiB
  budget as the phase evidence. In a delegation-heavy project the journal alone grows several MB
  per day, so once journal + evidence passed 16 MiB every `phase_complete` failed with
  `SNAPSHOT_IDENTITY_ERROR` / `PHASE_SNAPSHOT_BYTE_LIMIT` — and because phase closure is what
  triggers receipt compaction, the project could not recover on its own. The journal is now
  hashed in full (identity is unchanged: a change to any byte still invalidates the preflight)
  under its own bound — the receipt store's 32 MiB journal read limit — so the snapshot can never
  reject a journal the store itself still accepts. Digests for unchanged content are
  byte-identical to before, and every input is now hashed in bounded 1 MiB chunks instead of being
  read whole into memory. The exemption applies only to the regular file at the exact journal path.
- **New `phase_complete.snapshot_max_bytes`** (default `16777216`, range 1 MiB–256 MiB) sets the
  budget for the remaining snapshot inputs (`.swarm/evidence/`, `.swarm/spec.md`, `specs/`,
  `openspec/`). The snapshot is computed several times per completion and hashed synchronously, so
  raise it only as far as the evidence set needs.
- **`PHASE_SNAPSHOT_BYTE_LIMIT` now says what overflowed.** The error names the file that crossed
  the budget, the observed total, the configured limit, the bytes per input, and the config key to
  raise.
- **Receipts of closed phases are now garbage-collected after the grace period even without a
  terminal receipt.** Closing a phase only stamped the closing session's own memberships, and
  compaction only archived *resolved* ones, so exposures from delegate lanes and earlier sessions
  — and any exposure that never got a terminal — stayed live forever. A sweep (run at phase
  close and whenever the 2,000-record threshold already forces a checkpoint rewrite) now archives
  any membership whose phase was durably closed, once
  `knowledge.receipt_close_grace_days` has elapsed. A close only counts if it was recorded at or
  after the membership was committed, so phase ids reused by a later plan (the ledger survives
  `/swarm close`) can never expire the new plan's open-phase exposures. The archive keeps the full
  row, so outcome and shown-count rollups are unchanged.
- **The receipt archive is now segmented, so it can no longer fill up and strand rows in the
  journal.** Previously a full archive (10,000 rows / 16 MiB) left every further expired row live
  in the journal, which could then grow toward the 32 MiB read limit and wedge every receipt
  operation. The legacy `knowledge-receipts-v2-archive.jsonl` is now segment 0 and further segments
  are `knowledge-receipts-v2-archive.NNNNNN.jsonl`. When the active (highest-numbered) segment is
  full the remainder rolls into a new one; sealed segments are immutable and compaction only ever
  reads or rewrites the tail, so hot-path cost does not grow with history. The old per-segment
  bounds are unchanged, nothing is discarded, and no migration is needed: an existing archive file
  simply becomes the tail. A row already in the tail is skipped only when identical, and a changed
  copy replaces it, which also closes a window where a terminal filed after an interrupted archive
  pass could be lost. Readers resolve a key to its newest copy.
- **History reads no longer hold the ledger lock.** `queryHistoricalOutcomes` reads the tail under
  the lock and the immutable sealed segments after releasing it, bounded by a 128 MiB history read
  budget (typed `store_unavailable` beyond it; live operations are unaffected). A damaged sealed
  segment fails history with `store_corrupt` without blocking live operations.
- **`/swarm close` copies every archive segment** into its forensic bundle and still never removes
  them.

## Known limits

Two cases keep rows live because no close instant exists for them (both unchanged from before):
rows of a phase that is never closed, and rows of a later plan that reuses a phase id when the same
session that closed that id earlier closes it again (the ledger deduplicates a repeated close for
the same session and phase id). A journal made only of such rows, or of an unusually large open
phase, can still grow toward the receipt store's 32 MiB journal read limit, beyond which every
receipt operation reports `store_corrupt` and `phase_complete` reports `PHASE_SNAPSHOT_BYTE_LIMIT`.
Total archive history is lossless and unbounded on disk; only the 128 MiB history read budget bounds
what a single rollup query will read.

## Migration

No action needed. A project already over the old limit recovers on its next `phase_complete`, as
long as its journal is still under 32 MiB. Rows that become eligible are archived by the next
sweep. A terminal filed for a membership that has since been archived is rejected as an unknown
trace/entry, like any other archived membership.
