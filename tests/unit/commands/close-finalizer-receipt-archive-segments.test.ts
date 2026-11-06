import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCloseFinalizerHarness } from './close-finalizer.fixture.js';

const harness = await createCloseFinalizerHarness();
const { handleCloseCommand, swarmDir, writePlan } = harness;

const SEGMENTS = {
	'knowledge-receipts-v2-archive.jsonl': '{"segment":0}\n',
	'knowledge-receipts-v2-archive.000001.jsonl': '{"segment":1}\n',
	'knowledge-receipts-v2-archive.000002.jsonl': '{"segment":2}\n',
} as const;

function latestArchive(): string {
	const base = path.join(swarmDir(), 'archive');
	const entry = readdirSync(base)
		.filter((name) => name.startsWith('swarm-'))
		.sort()
		.at(-1);
	if (!entry) throw new Error('no close archive bundle was created');
	return path.join(base, entry);
}

describe('handleCloseCommand — receipt archive segments', () => {
	it('copies every archive segment into the bundle and never removes the originals', async () => {
		await writePlan();
		for (const [name, content] of Object.entries(SEGMENTS)) {
			writeFileSync(path.join(swarmDir(), name), content);
		}
		// Decoys that merely resemble segments must not be treated as receipts.
		writeFileSync(
			path.join(swarmDir(), 'knowledge-receipts-v2-archive.000000.jsonl'),
			'decoy\n',
		);
		writeFileSync(
			path.join(swarmDir(), 'knowledge-receipts-v2-archive.7.jsonl'),
			'decoy\n',
		);

		await handleCloseCommand(harness.testDir, []);

		const bundle = latestArchive();
		for (const [name, content] of Object.entries(SEGMENTS)) {
			expect(readFileSync(path.join(bundle, name), 'utf8')).toBe(content);
			// Receipt authority survives close (#2031): copy for forensics only.
			expect(readFileSync(path.join(swarmDir(), name), 'utf8')).toBe(content);
		}
		expect(
			existsSync(
				path.join(bundle, 'knowledge-receipts-v2-archive.000000.jsonl'),
			),
		).toBe(false);
		expect(
			existsSync(path.join(bundle, 'knowledge-receipts-v2-archive.7.jsonl')),
		).toBe(false);
	});

	it('is a no-op for projects that only have the base archive file', async () => {
		await writePlan();
		writeFileSync(
			path.join(swarmDir(), 'knowledge-receipts-v2-archive.jsonl'),
			'{"segment":0}\n',
		);

		await handleCloseCommand(harness.testDir, []);

		const bundle = latestArchive();
		expect(
			readdirSync(bundle).filter((name) =>
				name.startsWith('knowledge-receipts-v2-archive'),
			),
		).toEqual(['knowledge-receipts-v2-archive.jsonl']);
	});
});
