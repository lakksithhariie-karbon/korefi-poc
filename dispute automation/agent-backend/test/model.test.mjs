import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import { INSTRUCTIONS } from '../src/agent.mjs';
import { modelConfig } from '../src/constants.mjs';
import { buildPrompt } from '../src/prompt.mjs';

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

test('the agent reads the platform\'s own dispute rules on the page first', () => {
  assert.match(INSTRUCTIONS, /READ THE PLATFORM'S RULES ON THE PAGE FIRST/);
  assert.match(INSTRUCTIONS, /Never tell the operator to use a Dispute button the page does not show/);
});

test('a closed dispute window on the page is put in front of the agent; an open one is not mistaken for closed', () => {
  const base = { platform: 'ubereats', storeId: 's1', orderId: '365D6', conversation: [], screenshots: [], amount: 2 };
  const closed = buildPrompt({ ...base, facts: { notice: 'Customer had reported they didn’t receive their order. Refunds on orders placed more than 30 days ago can’t be disputed. Contact support if you think we got this wrong.' }, redactedText: '' });
  assert.match(closed, /The page says: "Refunds on orders placed more than 30 days ago can’t be disputed\." The platform's dispute route for this charge is closed/);
  assert.match(closed, /Charge: 2 USD/);
  const open = buildPrompt({ ...base, facts: { disputeStatus: 'available', notice: '1 customisation wrong' }, redactedText: 'Dispute access is available to authorised users only.' });
  assert.doesNotMatch(open, /route for this charge is closed/);
  assert.match(open, /The page shows a Dispute button for this charge/);
  assert.doesNotMatch(open, /DoorDash/, 'an Uber Eats prompt does not mention DoorDash');
});
