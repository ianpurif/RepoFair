import { describe, expect, it } from 'vitest';
import { indexFixture } from '../../apps/worker/src/fixture-service.ts';
import { answerLocal, lookupSource, validateLocalIndex } from '../../packages/core/src/local/index.ts';
import { FIXTURE_IDS } from '../../packages/contracts/src/local.ts';

describe('trusted authored fixture workflow', () => {
  it('loads every catalogued immutable snapshot with actual source graph evidence', async () => {
    for (const id of FIXTURE_IDS) {
      const index = await indexFixture(id); validateLocalIndex(index);
      expect(index.snapshot.snapshotId).toBe(id); expect(index.snapshot.kind).toBe('fixture');
      expect(index.nodes.length).toBeGreaterThan(3); expect(index.edges.length).toBeGreaterThan(0);
      expect(index.evidence.every(item => item.source.revision === index.snapshot.revision)).toBe(true);
      expect(lookupSource(index, 'src/index.ts', 1, 1).original).toBe(index.files.find(file => file.path === 'src/index.ts')!.text.split('\n')[0]);
    }
  });
  it('binds both application file-linked dependencies to the catalog exact versions', async () => {
    const index = await indexFixture('jobboard-app@1.0.0');
    expect(index.dependencies.map(item => [item.packageName, item.version, item.status]).sort()).toEqual([
      ['@atlas-fixture/event-log', '1.0.0', 'exact'], ['@atlas-fixture/retry-kit', '1.0.0', 'exact'],
    ]);
    const answer = answerLocal(index, 'How does this application retry failed jobs, and what could be affected by changing that behavior?');
    expect(answer.status).toBe('evidence_ready'); expect(answer.citations.some(item => item.source.path === 'src/run-job.ts')).toBe(true);
    expect(answer.missingEvidence.some(item => item.includes('@atlas-fixture/retry-kit@1.0.0'))).toBe(true);
  });
  it('keeps 1.0.0 and 2.0.0 answers bound to their own original source', async () => {
    const first = answerLocal(await indexFixture('retry-kit@1.0.0'), 'Does retry-kit 1.0.0 stop retries for permanent errors?');
    const second = answerLocal(await indexFixture('retry-kit@2.0.0'), 'Does retry-kit 2.0.0 stop retries for permanent errors?');
    expect(first.answer).toContain('void error'); expect(first.answer).not.toContain('if (error.permanent');
    expect(second.answer).toContain('if (error.permanent === true) return false');
    expect(first.citations.every(item => item.source.snapshotId === 'retry-kit@1.0.0')).toBe(true);
    expect(second.citations.every(item => item.source.snapshotId === 'retry-kit@2.0.0')).toBe(true);
    expect(answerLocal(await indexFixture('retry-kit@2.0.0'), 'Explain retry-kit 9.0.0 behavior.').status).toBe('abstained');
  });
  it('rejects paths and unsupported versions before any source read', async () => {
    await expect(indexFixture('../retry-kit@1.0.0' as never)).rejects.toThrow('Unsupported fixture');
    await expect(indexFixture('retry-kit@9.0.0' as never)).rejects.toThrow('Unsupported fixture');
  });
});
