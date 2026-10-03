import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { indexFixture } from '../apps/worker/src/fixture-service.ts';
import { answerLocal } from '../packages/core/src/local/index.ts';
import type { FixtureId } from '../packages/contracts/src/index.ts';

const questions = JSON.parse(await readFile('fixtures/questions.json', 'utf8')) as { cases: { id: string; question: string; expectedSources: string[] }[] };
const cases: { id: string; fixtureId: FixtureId; prefix: string }[] = [
  { id: 'retry-overview', fixtureId: 'jobboard-app@1.0.0', prefix: 'jobboard-app/' },
  { id: 'permanent-v1', fixtureId: 'retry-kit@1.0.0', prefix: 'retry-kit/v1/' },
  { id: 'permanent-v2', fixtureId: 'retry-kit@2.0.0', prefix: 'retry-kit/v2/' },
];
const words = (text: string) => (text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 2);
const rows = [];
for (const spec of cases) {
  const question = questions.cases.find(q => q.id === spec.id)!;
  const index = await indexFixture(spec.fixtureId);
  const corpus = index.files.filter(f => /\.[cm]?[jt]sx?$/.test(f.path));
  const tokenized = corpus.map(f => words(`${f.path} ${f.text}`));
  const query = [...new Set(words(question.question))];
  const average = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / tokenized.length;
  const scores = corpus.map((file, i) => ({ file, score: query.reduce((score, term) => {
    const tf = tokenized[i]!.filter(word => word === term).length;
    const df = tokenized.filter(tokens => tokens.includes(term)).length;
    const idf = Math.log(1 + (corpus.length - df + .5) / (df + .5));
    return score + idf * (tf * 2.2) / (tf + 1.2 * (.25 + .75 * tokenized[i]!.length / average));
  }, 0) })).filter(row => row.score > 0).sort((a,b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const baselineFiles: string[] = []; let characters = 0;
  for (const row of scores) { if (characters + row.file.text.length > 12000) continue; baselineFiles.push(row.file.path); characters += row.file.text.length; }
  const answer = answerLocal(index, question.question);
  const graphFiles = [...new Set(answer.citations.map(c => c.source.path))];
  const expected = question.expectedSources.filter(path => path.startsWith(spec.prefix)).map(path => path.slice(spec.prefix.length));
  const recall = (actual: string[]) => expected.length ? expected.filter(path => actual.includes(path)).length / expected.length : null;
  rows.push({ id: spec.id, fixtureId: spec.fixtureId, availableFiles: corpus.map(f => f.path), expectedFiles: expected,
    baseline: { method: 'BM25 over original source files', files: baselineFiles, sourceCharacters: characters, fileRecall: recall(baselineFiles) },
    graph: { method: 'lexical passages plus parsed graph neighborhood', files: graphFiles, sourceCharacters: answer.citations.reduce((sum,c) => sum+c.original.length,0), fileRecall: recall(graphFiles) },
  });
}
const guardrails = [];
for (const id of ['unsupported-version','runtime-result']) {
  const q = questions.cases.find(q => q.id === id)!;
  const answer = answerLocal(await indexFixture('jobboard-app@1.0.0'), q.question);
  guardrails.push({ id, status: answer.status, citationCount: answer.citations.length, passed: answer.status === 'abstained' && answer.citations.length === 0 });
}
const result = { recordedAt: new Date().toISOString(), mode: 'fixture', sourceAccess: 'Identical original snapshot files for both methods',
  responseCharacterBudget: 12000, rows, guardrails,
  limitations: ['Five reviewed questions and tiny authored fixtures are not a benchmark of general code understanding.',
    'Recall measures supporting file presence, not answer correctness. No generation model or vector baseline was used.',
    'Both methods share source access and a character ceiling; whole-file BM25 and passage retrieval have different granularity.',
    'No accuracy, latency, cost or superiority claim follows from these observations.'] };
await mkdir('docs/evidence', { recursive: true });
await writeFile('docs/evidence/retrieval-evaluation.json', JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ rows: rows.length, guardrails, evidence: 'docs/evidence/retrieval-evaluation.json' },null,2));
if (guardrails.some(g => !g.passed)) process.exitCode = 1;
