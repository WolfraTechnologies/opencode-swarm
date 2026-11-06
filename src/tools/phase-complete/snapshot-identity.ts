import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES } from '../../hooks/knowledge-receipt-ledger-storage.js';

const MAX_SNAPSHOT_FILES = 512;
const MAX_SNAPSHOT_ENTRIES = 2_048;
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Default byte budget for the evidence-class snapshot inputs. Operators can
 * raise or lower it with `phase_complete.snapshot_max_bytes`; the schema's
 * default literal is pinned to this constant by a unit test.
 */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The receipt journal is project state, not task evidence: it grows with
 * every knowledge exposure, independently of how much evidence a phase
 * produced. It is therefore hashed in full (identity stays byte-exact) under
 * its OWN bound — the journal reader's cap — instead of competing with the
 * evidence budget. A journal the receipt store can still read can never wedge
 * `phase_complete`, and the two limits cannot disagree.
 */
const RECEIPT_LEDGER_INPUT = '.swarm/knowledge-receipts-v2.jsonl';

const INPUTS = [
	'.swarm/evidence',
	'.swarm/spec.md',
	RECEIPT_LEDGER_INPUT,
	'specs',
	'openspec/specs',
	'openspec/changes',
] as const;

export interface PhaseEvidenceSnapshotOptions {
	/**
	 * Byte budget for every input except the receipt journal. Defaults to
	 * {@link DEFAULT_SNAPSHOT_MAX_BYTES}.
	 */
	maxBytes?: number;
}

interface SnapshotEntry {
	path: string;
	sha256: string;
	bytes: number;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

/**
 * Byte-exact portable relative path (Windows separators become forward
 * slashes; no case-folding — two paths differing only by case hash
 * differently on every platform, including case-insensitive NTFS).
 *
 * Single source for the verification-receipts substrate (#2968) and its
 * verifier (#2970): emission and verification share this normalizer by
 * import, so the two can never drift apart.
 */
export function toPortableRelativePath(root: string, absolute: string): string {
	return path.relative(root, absolute).replaceAll('\\', '/');
}

/**
 * Derived receipt artifacts live under `.swarm/evidence/receipts/` but are
 * REBUILDABLE projections of the gate outputs they summarize — hashing them
 * as source evidence would make every receipt emission mutate the
 * phase-evidence identity the gates enforce (#2968 R2, plan-critic round 1:
 * an emitted receipt flipped `computePhaseEvidenceSnapshot` and would trip
 * `PHASE_PREFLIGHT_STALE`). The snapshot therefore skips exactly this one
 * top-level entry of the `.swarm/evidence` root; behavior is byte-identical
 * when the directory does not exist.
 *
 * FB-008 (#2968 swarm-pr-review): exported as the single source of truth for
 * "derived, non-task top-level entries of `.swarm/evidence`" — the evidence
 * task-ID listing (`listEvidenceTaskIds`, consumed by `/swarm doctor`'s
 * Orphaned-Evidence check) must treat the SAME entries as reserved, or every
 * project that completes a phase gets a false "Orphaned Evidence [receipts]"
 * red on its primary health surface.
 */
export const SNAPSHOT_EXCLUDED_EVIDENCE_ENTRIES = new Set(['receipts']);

/**
 * SHA-256 of a file's exact bytes, read in bounded chunks so the memory
 * footprint is independent of file size. The descriptor is re-validated
 * against the lstat the caller already took (identity + size) and against
 * itself after the read (size + mtime + ctime), so a concurrent writer is a
 * hard failure, never a torn digest.
 */
function hashRegularFile(
	absolute: string,
	stat: fs.Stats,
): { sha256: string; bytes: number } {
	const descriptor = fs.openSync(
		absolute,
		fs.constants.O_RDONLY |
			((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
	);
	try {
		const opened = fs.fstatSync(descriptor);
		if (
			!opened.isFile() ||
			opened.dev !== stat.dev ||
			opened.ino !== stat.ino ||
			opened.size !== stat.size
		) {
			throw new Error('PHASE_SNAPSHOT_CONCURRENT_MUTATION');
		}
		const hash = createHash('sha256');
		const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, opened.size));
		let consumed = 0;
		while (consumed < opened.size) {
			const read = fs.readSync(
				descriptor,
				chunk,
				0,
				Math.min(chunk.length, opened.size - consumed),
				consumed,
			);
			if (read === 0) throw new Error('PHASE_SNAPSHOT_CONCURRENT_MUTATION');
			hash.update(chunk.subarray(0, read));
			consumed += read;
		}
		const after = fs.fstatSync(descriptor);
		if (
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs
		) {
			throw new Error('PHASE_SNAPSHOT_CONCURRENT_MUTATION');
		}
		return { sha256: hash.digest('hex'), bytes: consumed };
	} finally {
		fs.closeSync(descriptor);
	}
}

export function computePhaseEvidenceSnapshot(
	directory: string,
	options: PhaseEvidenceSnapshotOptions = {},
): string {
	const maxBytes = options.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error('PHASE_SNAPSHOT_INVALID_LIMIT');
	}
	const root = fs.realpathSync(directory);
	const evidenceRoot = path.join(root, '.swarm', 'evidence');
	const entries: SnapshotEntry[] = [];
	// Evidence-class bytes (everything but the receipt journal), tracked per
	// top-level input so a limit failure can name where the budget went.
	const bytesByInput = new Map<string, number>();
	let evidenceBytes = 0;
	let visitedEntries = 0;

	const byteLimitError = (
		relativePath: string,
		isJournal: boolean,
		fileBytes: number,
	): Error => {
		if (isJournal) {
			return new Error(
				`PHASE_SNAPSHOT_BYTE_LIMIT: ${relativePath} is ${fileBytes} bytes, over the ${MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES}-byte receipt journal limit that the receipt store itself also enforces`,
			);
		}
		const breakdown = [...bytesByInput]
			.map(([name, bytes]) => `${name}=${bytes}`)
			.join(', ');
		return new Error(
			`PHASE_SNAPSHOT_BYTE_LIMIT: hashing ${relativePath} brought the phase evidence snapshot to ${evidenceBytes} bytes, over the ${maxBytes}-byte limit (bytes per input so far: ${breakdown}); raise phase_complete.snapshot_max_bytes or prune the largest input`,
		);
	};

	const visit = (absolute: string, input: string): void => {
		if (!isContained(root, absolute)) {
			throw new Error('PHASE_SNAPSHOT_PATH_ESCAPE');
		}
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(
				`PHASE_SNAPSHOT_UNSAFE_PATH: ${path.relative(root, absolute)}`,
			);
		}
		if (stat.isDirectory()) {
			const names: string[] = [];
			const handle = fs.opendirSync(absolute);
			try {
				for (;;) {
					const entry = handle.readSync();
					if (!entry) break;
					visitedEntries += 1;
					if (visitedEntries > MAX_SNAPSHOT_ENTRIES) {
						throw new Error('PHASE_SNAPSHOT_ENTRY_LIMIT');
					}
					names.push(entry.name);
				}
			} finally {
				handle.closeSync();
			}
			const isEvidenceRoot = absolute === evidenceRoot;
			for (const name of names.sort(compareUtf8)) {
				if (isEvidenceRoot && SNAPSHOT_EXCLUDED_EVIDENCE_ENTRIES.has(name)) {
					continue;
				}
				visit(path.join(absolute, name), input);
			}
			return;
		}
		if (!stat.isFile()) {
			throw new Error(
				`PHASE_SNAPSHOT_NON_REGULAR: ${path.relative(root, absolute)}`,
			);
		}
		if (entries.length >= MAX_SNAPSHOT_FILES) {
			throw new Error('PHASE_SNAPSHOT_FILE_LIMIT');
		}
		const relativePath = toPortableRelativePath(root, absolute);
		// The journal exemption is keyed on the exact regular file at the ledger
		// path, never on the input label: a directory that merely carries the
		// ledger's name must not turn everything inside it into exempt bytes.
		const isJournal = relativePath === RECEIPT_LEDGER_INPUT;
		if (isJournal) {
			if (stat.size > MAX_KNOWLEDGE_RECEIPT_JOURNAL_BYTES) {
				throw byteLimitError(relativePath, true, stat.size);
			}
		} else {
			evidenceBytes += stat.size;
			bytesByInput.set(input, (bytesByInput.get(input) ?? 0) + stat.size);
			if (evidenceBytes > maxBytes) {
				throw byteLimitError(relativePath, false, stat.size);
			}
		}
		const hashed = hashRegularFile(absolute, stat);
		entries.push({
			path: relativePath,
			sha256: hashed.sha256,
			bytes: hashed.bytes,
		});
	};

	for (const relative of INPUTS) {
		visit(path.join(root, ...relative.split('/')), relative);
	}
	entries.sort((left, right) => compareUtf8(left.path, right.path));
	return createHash('sha256')
		.update(JSON.stringify({ schemaVersion: 1, entries }))
		.digest('hex');
}
