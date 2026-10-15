// REQ-126: an agent is named "<profile label>-<model version>-<thinking level>" ("실행_Sol-6.1-High") wherever Kanban names it — the
// card's line two (a lead's too) and the detail. The version is the first run of digits in the model's display name (the host's model
// list, else the name read from the id); the thinking level is the option id with a capital. Exceptions: no label → the model's name,
// a label that already ends with its version (before 09-30) → no second version. Worked out when shown, from the agent as the host
// reports it now: the ledger keeps agent ids only. The screens: tests/plugin-ui.test.mjs ("REQ-126 …"), tests/web/run.mjs ("req126-…").
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentModelName, assigneeName, modelDisplayName, modelVersion, thinkingText } from '../dist/client/card-meta.js';
import { detailAgentIds, moveReasonText } from '../dist/client/move-reason.js';
import { copy } from '../dist/client/i18n.js';

const ID = 'abcdef12-3456-4789-8abc-def012345678';

test('REQ-126 the version is the first run of digits in the model\'s name', () => {
  assert.equal(modelVersion('Opus 5.5'), '5.5');
  assert.equal(modelVersion('GPT-6.1-Sol'), '6.1');
  assert.equal(modelVersion('GPT-6-Astra'), '6');
  assert.equal(modelVersion('Gemini 3.5 Flash'), '3.5');
  assert.equal(modelVersion('Opus 4.8 1M'), '4.8', 'the first run only');
  assert.equal(modelVersion('Claude Auto'), null);
  assert.equal(modelVersion(null), null);
});

test('REQ-126 the thinking level: its first letter capital, "xhigh" as XHigh, none left out', () => {
  assert.deepEqual(['high', 'xhigh', 'max', 'medium', 'low', 'ultra'].map(thinkingText), ['High', 'XHigh', 'Max', 'Medium', 'Low', 'Ultra']);
  assert.equal(thinkingText('XHIGH'), 'XHigh');
  assert.equal(thinkingText(null), null);
  assert.equal(thinkingText('  '), null);
});

test('REQ-126 the model\'s name: the host\'s list first, else read from the id', () => {
  assert.equal(modelDisplayName({ provider: 'codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1-Sol' }), 'GPT-6.1-Sol');
  assert.equal(modelDisplayName({ provider: 'codex', model: 'gpt-6.1-sol' }), 'GPT-6.1 Sol', 'no list: the id read (REQ-73)');
  assert.equal(modelDisplayName({ provider: 'claude', model: 'claude-opus-5-5', modelLabel: '  ' }), 'Opus 5.5');
  assert.equal(modelDisplayName({ provider: 'claude', model: null }), null);
});

test('REQ-126 label-version-thinking, and its three exceptions', () => {
  const sol = { provider: 'codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1-Sol', thinkingOptionId: 'high', profile: '실행_Sol' };
  const opus = { provider: 'claude', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', thinkingOptionId: 'high', profile: '총괄_Opus' };
  assert.equal(agentModelName(sol), '실행_Sol-6.1-High');
  assert.equal(agentModelName(opus), '총괄_Opus-5.5-High');
  assert.equal(agentModelName({ ...sol, model: 'gpt-6-astra', modelLabel: 'GPT-6-Astra', profile: '검증_Astra' }), '검증_Astra-6-High');
  assert.equal(agentModelName({ provider: 'gemini', model: 'gemini-3.5-flash', modelLabel: 'Gemini 3.5 Flash', thinkingOptionId: 'low',
    profile: '조사_Gemini' }), '조사_Gemini-3.5-Low');
  // ① No label: the model's own name stands in its place.
  assert.equal(agentModelName({ ...opus, profile: null }), 'Opus-5.5-High');
  assert.equal(agentModelName({ ...sol, profile: '' }), 'GPT-6.1-Sol-High');
  assert.equal(agentModelName({ provider: 'gemini', model: 'gemini-3.5-flash' }), 'Gemini-3.5-Flash', 'no thinking level: left out');
  // ② An archived agent is named from the last values the host gave (the store keeps them); nothing here tells it apart.
  assert.equal(agentModelName({ ...sol }), agentModelName(sol));
  // ③ A label from before 09-30 already ends with a version: the thinking level alone follows.
  assert.equal(agentModelName({ ...sol, model: 'gpt-6-sol', modelLabel: 'GPT-6-Sol', profile: '실행_Sol-6' }), '실행_Sol-6-High');
  assert.equal(agentModelName({ ...opus, profile: '총괄_Opus-5.5' }), '총괄_Opus-5.5-High');
  assert.equal(agentModelName({ ...sol, profile: '실행_환경_Astra-6', model: 'gpt-6-astra', modelLabel: 'GPT-6-Astra' }), '실행_환경_Astra-6-High');
  // A part the host does not say is left out.
  assert.equal(agentModelName({ ...sol, thinkingOptionId: null }), '실행_Sol-6.1');
  assert.equal(agentModelName({ profile: '실행_Sol', thinkingOptionId: 'high' }), '실행_Sol-High', 'no model known');
  assert.equal(agentModelName({ profile: '실행_Sol' }), '실행_Sol');
  // Only the agent's own thinkingOptionId: none (null, undefined, empty) leaves the level out even when the host says
  // what the agent runs with (`effectiveThinkingOptionId`); its own one is shown.
  for (const own of [null, undefined, '', '  ']) {
    for (const effective of ['high', 'max', 'xhigh', null]) {
      assert.equal(agentModelName({ ...sol, thinkingOptionId: own, effectiveThinkingOptionId: effective }), '실행_Sol-6.1',
        `own ${JSON.stringify(own)}, effective ${effective}`);
    }
  }
  assert.equal(agentModelName({ ...sol, thinkingOptionId: 'high', effectiveThinkingOptionId: 'medium' }), '실행_Sol-6.1-High');
  assert.equal(agentModelName({ ...opus, profile: null, thinkingOptionId: '', effectiveThinkingOptionId: 'high' }), 'Opus-5.5', 'no label: the same');
  assert.equal(agentModelName({ title: 'Only a title' }), null);
  assert.equal(agentModelName(undefined), null);
});

test('REQ-126 the name everywhere: then the title, then the id, as before', () => {
  assert.equal(assigneeName(ID, { provider: 'codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1-Sol', thinkingOptionId: 'xhigh', profile: '실행_Sol' }),
    '실행_Sol-6.1-XHigh');
  assert.equal(assigneeName(ID, { title: 'Only a title' }), 'Only a title');
  assert.equal(assigneeName(ID, undefined), 'abcdef12', 'an unknown agent: its id, as before');
});

test('REQ-126 the move\'s reason names the agent that moved the card; by default by its id, as before', () => {
  const m = copy('ko'), at = '2026-10-01T01:00:00.000Z', now = Date.parse(at);
  const reason = { by: 'agent', cause: null, agentId: ID, at, created: false };
  assert.match(moveReasonText(reason, m, now), /^다른 에이전트가 옮김\(abcdef12\) · /);
  assert.match(moveReasonText(reason, m, now, [ID], () => '실행_Sol-6.1-High · abcdef12'), /^이 카드의 에이전트가 옮김\(실행_Sol-6\.1-High · abcdef12\) · /);
  assert.match(moveReasonText({ ...reason, by: 'user', agentId: null }, m, now, [], () => 'never'), /^사람이 옮김 · /);
});

test('REQ-126 the detail reads every agent it names: author, the one that moved it, those in its history — once each', () => {
  const agent = agentId => ({ kind: 'agent', agentId });
  const ids = detailAgentIds({ card: { createdBy: agent('b') }, reason: { by: 'agent', agentId: 'c' },
    history: [{ actor: agent('b') }, { actor: { kind: 'user' } }, { actor: agent('a') }] });
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.deepEqual(detailAgentIds({ card: { createdBy: { kind: 'user' } }, history: [] }), []);
});
