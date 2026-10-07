import { parseFixtureId, parseQuestion } from '@atlas/contracts';
import { answerWithAi, createAiProviders, parseAiProviderConfig } from '@atlas/core/ai';
import { indexFixture } from './fixture-service.ts';

/** Public fixture AI only. Keys never imply consent or activate this capability. */
export async function answerFixtureWithAi(id: unknown, question: unknown, approved: unknown,
  env: Record<string, string | undefined> = process.env, signal?: AbortSignal) {
  const fixtureId = parseFixtureId(id); const parsedQuestion = parseQuestion(question);
  if ((env.ATLAS_MODE ?? 'fixture') !== 'fixture' || env.ATLAS_AI_ENABLED !== 'true') throw new Error('AI integration is unavailable');
  if (approved !== true) throw new Error('Voyage and DeepSeek source disclosure approval is required');
  const config = parseAiProviderConfig(env);
  const index = await indexFixture(fixtureId);
  const deadline = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  return answerWithAi(index, parsedQuestion, createAiProviders(config), config, deadline);
}
