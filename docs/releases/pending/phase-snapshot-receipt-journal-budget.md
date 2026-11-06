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
  `/swarm close`) can never expire the new plan's open-phase exposures. Resolved rows are offered
  to the archive first. The archive keeps the full row, so outcome and shown-count rollups are
  unchanged.
- **Compaction no longer rewrites an unchanged journal on every operation** when archive
  capacity leaves every eligible row live.

## Known limit

The archive keeps its existing capacity bounds (10,000 rows / 16 MiB) and, as before, never
discards prior authority when it is full: overflow rows stay live in the journal. A project whose
closed-phase exposures outpace the archive can therefore still grow its journal toward the receipt
store's 32 MiB read limit, beyond which every receipt operation reports `store_corrupt` and
`phase_complete` reports `PHASE_SNAPSHOT_BYTE_LIMIT`. Archive capacity policy (segmenting or
evicting old unresolved exposures) is intentionally not changed here.

Two further cases keep rows live because no close instant exists for them (both unchanged from
before): rows of a phase that is never closed, and rows of a later plan that reuses a phase id when
the same session that closed that id earlier closes it again (the ledger deduplicates a repeated
close for the same session and phase id).

## Migration

No action needed. A project already over the old limit recovers on its next `phase_complete`, as
long as its journal is still under 32 MiB. Rows that become eligible are archived by the next
sweep. A terminal filed for a membership that has since been archived is rejected as an unknown
trace/entry, like any other archived membership.
