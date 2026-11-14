import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_AGENTS,
  buildChatHistoryPayload,
  calculateCompactMetricC,
  classifyCommandRisk,
  compactifyValue,
  isConnectMyAiCommand,
  selectOllamaModelName,
  validateOllamaHostUrl,
  validateOperatorTokenFormat,
} from './svlLogic';

test('TopologicalInfinityEngine compactifies [-Infinity, +Infinity] to [-1, 1] with c = 2.5', () => {
  assert.equal(compactifyValue(Number.NEGATIVE_INFINITY), -1.0);
  assert.equal(compactifyValue(Number.POSITIVE_INFINITY), 1.0);
  assert.equal(compactifyValue(0), 0.0);

  const res = calculateCompactMetricC(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  assert.equal(res.compactStart, -1.0);
  assert.equal(res.compactEnd, 1.0);
  assert.equal(res.domainLength, 2.0);
  assert.equal(res.orthogonalB, 1.5);
  assert.equal(res.metricC, 2.5);
});

test('isConnectMyAiCommand recognizes Polish diacritics and case variations', () => {
  assert.equal(isConnectMyAiCommand('podłącz moje ai'), true);
  assert.equal(isConnectMyAiCommand('PODŁĄCZ MOJE AI'), true);
  assert.equal(isConnectMyAiCommand('  podlacz   moje ai '), true);
  assert.equal(isConnectMyAiCommand('status systemu'), false);
});

test('validateOperatorTokenFormat blocks hardcoded 364_OMNIKLUCZ_ROOT and short tokens', () => {
  const legacy = validateOperatorTokenFormat('364_OMNIKLUCZ_ROOT');
  assert.equal(legacy.valid, false);
  assert.ok(legacy.error?.includes('364_OMNIKLUCZ_ROOT'));

  const shortToken = validateOperatorTokenFormat('short_secret_123');
  assert.equal(shortToken.valid, false);

  const validToken = validateOperatorTokenFormat('svl_operator_production_secret_token_36_chars');
  assert.equal(validToken.valid, true);
  assert.equal(validToken.error, null);
});

test('classifyCommandRisk detects Polkit/sudo high-risk commands', () => {
  assert.equal(classifyCommandRisk('uname -a').highRisk, false);
  assert.equal(classifyCommandRisk('sudo systemctl restart svl-python-os').highRisk, true);
  assert.equal(classifyCommandRisk('rm -rf /tmp/test').highRisk, true);
});

test('CANONICAL_AGENTS preserves exact SVL_System identifiers (si_1, Alex, Astyria, Aurelius)', () => {
  const ids = CANONICAL_AGENTS.map((a) => a.id);
  assert.deepEqual(ids, ['si_1', 'Alex', 'Astyria', 'Aurelius']);
});

test('validateOllamaHostUrl validates http/https endpoints cleanly', () => {
  assert.equal(validateOllamaHostUrl('http://127.0.0.1:11434/').normalized, 'http://127.0.0.1:11434');
  assert.equal(validateOllamaHostUrl('https://ollama.example.com').valid, true);
  assert.equal(validateOllamaHostUrl('ftp://bad-host').valid, false);
  assert.equal(validateOllamaHostUrl('').valid, false);
});

test('buildChatHistoryPayload filters system errors and preserves multi-turn order', () => {
  const history = buildChatHistoryPayload([
    { role: 'system', content: 'Błąd' },
    { role: 'user', content: 'Cześć!' },
    { role: 'assistant', content: 'Hej, w czym pomóc?' },
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: 'Cześć!' },
    { role: 'assistant', content: 'Hej, w czym pomóc?' },
  ]);
});

test('selectOllamaModelName honors explicit selection and prefers llama3.2-vision:11b when available', () => {
  const models = [
    { name: 'dolphin-qwen2.5:32b', vision_supported: false },
    { name: 'llama3.2-vision:11b', vision_supported: true },
  ];
  assert.equal(selectOllamaModelName('ollama:dolphin-qwen2.5:32b', models, false), 'dolphin-qwen2.5:32b');
  assert.equal(selectOllamaModelName('svl-hybrid-router', models, true), 'llama3.2-vision:11b');
  assert.equal(selectOllamaModelName('svl-hybrid-router', models, false), 'llama3.2-vision:11b');
});

