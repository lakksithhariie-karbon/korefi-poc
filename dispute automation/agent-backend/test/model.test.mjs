import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import { INSTRUCTIONS } from '../src/agent.mjs';
import { modelConfig } from '../src/constants.mjs';

test('the Vercel AI Gateway key picks Claude Haiku 5.5; without it the service keeps using OpenAI', () => {
  assert.deepEqual(modelConfig({ AI_GATEWAY_API_KEY: 'k', OPENAI_API_KEY: 'sk' }), { provider: 'vercel-ai-gateway', id: 'anthropic/claude-haiku-5.5' });
  assert.deepEqual(modelConfig({ AI_GATEWAY_API_KEY: 'k', AI_MODEL: 'anthropic/claude-sonnet-5.5' }), { provider: 'vercel-ai-gateway', id: 'anthropic/claude-sonnet-5.5' });
  assert.deepEqual(modelConfig({ OPENAI_API_KEY: 'sk', OPENAI_MODEL: 'gpt-6-luna' }), { provider: 'openai', id: 'gpt-6-luna' });
  assert.equal(modelConfig({}), null);
});

test('Pi knows Claude Haiku 5.5 on the gateway, and that it reads images', () => {
  const models = createModels();
  models.setProvider(vercelAIGatewayProvider());
  const m = models.getModel('vercel-ai-gateway', 'anthropic/claude-haiku-5.5');
  assert.ok(m, 'model in the catalog');
  assert.ok(m.input.includes('image'));
});

test('the agent is told to win back money, never to make up facts, and to learn from past disputes', () => {
  assert.match(INSTRUCTIONS, /Dispute every error charge unless the evidence clearly shows the store made the mistake/);
  assert.match(INSTRUCTIONS, /NEVER MAKE UP FACTS/);
  assert.match(INSTRUCTIONS, /LEARN FROM PAST DISPUTES/);
  assert.doesNotMatch(INSTRUCTIONS, /If the evidence is thin, recommend needs_review/);
});
