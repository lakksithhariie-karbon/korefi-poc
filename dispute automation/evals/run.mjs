import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { draftLength, investigate, placeholders } from '../agent-backend/src/agent.mjs';
import { DRAFT_LIMITS, PROMPT_VERSION, RECOMMENDATIONS, UNRESOLVED_STORE, modelConfig } from '../agent-backend/src/constants.mjs';
import { sanitizeCapture, sanitizeMessage } from '../agent-backend/src/validation.mjs';
import { gradeWithCursor } from './judge.mjs';

const STARTER_QUERY = 'Check this order’s error charge and help me dispute it.';
const location = (path) => new URL(path, import.meta.url);
const readYaml = async (path) => parse(await readFile(location(path), 'utf8'));
const safeName = (name) => typeof name === 'string' && /^[a-z0-9][a-z0-9_.-]*$/i.test(name);
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const noRows = async () => [];
const fixtureStore = {
  history: {
    similarCases: noRows,
    getFinancials: noRows,
    getCharges: noRows,
    getIssueReports: noRows,
    getStorePatterns: noRows,
  },
  startToolCall: async () => null,
};

async function loadScenario(id) {
  const { id: scenarioId, source, input, expected } = await readYaml(`scenarios/${id}.yaml`);
  const rubric = expected?.rubric;
  if (scenarioId !== id || !input?.capture || !RECOMMENDATIONS.includes(expected?.recommendation)
    || !['present', 'absent'].includes(expected.draft)
    || !(expected.customer_comment === null || typeof expected.customer_comment === 'string')
    || !Array.isArray(rubric) || !rubric.length
    || rubric.some((item) => !safeName(item?.id) || typeof item.criterion !== 'string' || !item.criterion.trim())
    || new Set(rubric.map((item) => item.id)).size !== rubric.length) {
    throw new Error(`Invalid scenario: ${id}`);
  }

  if (!safeName(input.page_text)) throw new Error(`Invalid page text fixture in ${id}`);
  const pageText = await readFile(location(`fixtures/${input.page_text}`), 'utf8');
  const photoNames = input.customer_photos ?? [];
  const screenshotNames = input.screenshots ?? [];
  if (!Array.isArray(photoNames) || !Array.isArray(screenshotNames)
    || [...photoNames, ...screenshotNames].some((name) => !safeName(name) || !/\.(png|jpe?g)$/i.test(name))
    || (rubric.some((item) => item.requires_images) && !photoNames.length && !screenshotNames.length)) {
    throw new Error(`Invalid image fixtures in ${id}`);
  }
  const images = await Promise.all([...photoNames, ...screenshotNames].map(async (name, index) => ({
    name,
    kind: index < photoNames.length ? 'customer photo' : 'order screenshot',
    mime: /\.png$/i.test(name) ? 'image/png' : 'image/jpeg',
    bytes: await readFile(location(`fixtures/${name}`)),
  })));
  const query = sanitizeMessage({ text: input.query ?? STARTER_QUERY }).text;
  const request = sanitizeCapture({
    ...input.capture,
    operator_question: query,
    redacted_page_text: pageText,
    screenshots: images.map(({ mime, bytes }) => `data:${mime};base64,${bytes.toString('base64')}`),
    structured_facts: {
      ...input.capture.structured_facts,
      attached_images: { customer_photos: photoNames.length },
    },
  });
  if (!(request.platform in DRAFT_LIMITS)) throw new Error(`Unsupported eval platform in ${id}`);
  return { id, source, expected, request: { ...request, storeId: request.storeId ?? UNRESOLVED_STORE }, images };
}

function sidebarOutput(answer) {
  const points = answer.key_points ?? [];
  return {
    recommendation: answer.recommendation,
    headline: points.length ? answer.headline : null,
    customer_comment: points.length ? answer.customer_comment : null,
    key_points: points,
    plain_text: points.length ? null : answer.reasoning_summary,
    draft: answer.draft_text || null,
  };
}

function exactChecks(output, expected, platform) {
  const limit = DRAFT_LIMITS[platform];
  const hasDraft = Boolean(output.draft);
  return [
    { id: 'recommendation', pass: output.recommendation === expected.recommendation, expected: expected.recommendation, actual: output.recommendation },
    { id: 'draft_presence', pass: hasDraft === (expected.draft === 'present'), expected: expected.draft, actual: hasDraft ? 'present' : 'absent' },
    { id: 'customer_comment', pass: output.customer_comment === expected.customer_comment, expected: expected.customer_comment, actual: output.customer_comment },
    { id: 'first_answer_format', pass: Boolean(output.headline?.trim()) && output.key_points.length >= 1 && output.key_points.length <= 6 },
    ...(hasDraft ? [
      { id: 'draft_length', pass: draftLength(output.draft) <= limit, limit, actual: draftLength(output.draft) },
      { id: 'draft_placeholders', pass: placeholders(output.draft).length === 0 },
    ] : []),
  ];
}

async function evaluate(scenario, repeat, judgeConfig) {
  const { id, source, request, expected, images } = scenario;
  const result = { scenario: id, source, repeat, query: request.operatorQuestion };
  const started = Date.now();
  try {
    const answer = await investigate({
      store: fixtureStore, tenant: 'eval', request, runId: randomUUID(), transcript: [], log: () => {},
    });
    result.agent = { model: answer.model, duration_ms: Date.now() - started, tools: answer.tools_used };
    result.output = sidebarOutput(answer);
    result.code_checks = exactChecks(result.output, expected, request.platform);
  } catch (error) {
    return { ...result, status: 'agent_error', error: error.message, duration_ms: Date.now() - started };
  }

  try {
    const evidence = {
      platform: request.platform,
      page_text: request.redactedText,
      structured_facts: request.facts,
      image_kinds: images.map(({ kind }) => kind),
    };
    result.judge = await gradeWithCursor({
      evidence, query: result.query, output: result.output, rubric: expected.rubric, images, config: judgeConfig,
    });
  } catch (error) {
    return { ...result, status: 'judge_error', error: error.message };
  }

  const statuses = result.judge.checks.map(({ status }) => status);
  const failed = result.code_checks.some(({ pass }) => !pass) || statuses.includes('fail');
  result.status = failed ? 'fail' : statuses.includes('cannot_assess') ? 'cannot_assess' : 'pass';
  return result;
}

// Use the service's model selection and allow exported environment variables to take precedence.
try {
  loadEnvFile(fileURLToPath(location('../.env')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const model = modelConfig(process.env);
if (!model) throw new Error('Configure an agent provider in the project .env or environment.');

const matrix = await readYaml('matrix.yaml');
if (!Array.isArray(matrix.scenarios) || !matrix.scenarios.length || matrix.scenarios.some((id) => !safeName(id))
  || new Set(matrix.scenarios).size !== matrix.scenarios.length || !isPositiveInteger(matrix.repeats)
  || matrix.judge?.model !== 'grok-4.7-high' || !isPositiveInteger(matrix.judge.timeout_ms)) {
  throw new Error('Invalid eval matrix');
}
const scenarios = await Promise.all(matrix.scenarios.map(loadScenario));
if (matrix.source !== undefined && scenarios.some(({ source }) => source !== matrix.source)) {
  throw new Error('Scenario sources must match the matrix source');
}
const runId = randomUUID();
const directory = location(`results/${runId}/`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const results = [];

for (const scenario of scenarios) {
  for (let repeat = 1; repeat <= matrix.repeats; repeat++) {
    const result = await evaluate(scenario, repeat, matrix.judge);
    results.push(result);
    await writeFile(new URL(`${scenario.id}-r${repeat}.json`, directory), JSON.stringify(result, null, 2) + '\n');
    console.log(`${scenario.id} r${repeat}: ${result.status}`);
  }
}

const summary = scenarios.map(({ id }) => {
  const runs = results.filter(({ scenario }) => scenario === id);
  const verdicts = runs.flatMap(({ output }) => output ? [output.recommendation] : []);
  return {
    scenario: id,
    passed: runs.filter(({ status }) => status === 'pass').length,
    total: runs.length,
    verdict_consistent: verdicts.length === runs.length && new Set(verdicts).size === 1,
    statuses: runs.map(({ status }) => status),
  };
});
await writeFile(new URL('summary.json', directory), JSON.stringify({
  run_id: runId, source: matrix.source, agent: model, prompt_version: PROMPT_VERSION, judge: matrix.judge, summary,
}, null, 2) + '\n');
console.log(`Results: ${fileURLToPath(directory)}`);
if (results.some(({ status }) => status !== 'pass')) process.exitCode = 1;
