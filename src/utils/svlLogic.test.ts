import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_AGENTS,
  DEFAULT_DEV_OPERATOR_TOKEN,
  buildChatHistoryPayload,
  calculateCompactMetricC,
  classifyCommandRisk,
  compactifyValue,
  extractExplicitChatModuleDirective,
  formatAgentDisplayName,
  formatIrisNotificationMessage,
  getSvlOperatorAccessToken,
  hasSvlOperatorAccessToken,
  isConnectMyAiCommand,
  isGitHubWorkspaceSyncRequest,
  mergeConversationThreads,
  normalizeAgentCanonicalName,
  parseWorkOrCodexCommand,
  resolveAvatarProfileKey,
  safeParseJsonResponse,
  selectNextDuplexSpeaker,
  selectOllamaModelName,
  setSvlOperatorAccessToken,
  validateAvatarUrlOrDataUri,
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

test('isGitHubWorkspaceSyncRequest recognizes Polish inflections used in chat', () => {
  assert.equal(isGitHubWorkspaceSyncRequest('synchronizuj z GitHubem'), true);
  assert.equal(isGitHubWorkspaceSyncRequest('sync workspace GitHub.com'), true);
  assert.equal(isGitHubWorkspaceSyncRequest('sprawdź GitHub'), false);
  assert.equal(isGitHubWorkspaceSyncRequest('synchronizuj pliki lokalnie'), false);
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

test('CANONICAL_AGENTS retains only active Agata Mitek identifier after removing Aria/Alex/Astyria/Aurelius', () => {
  const ids = CANONICAL_AGENTS.map((a) => a.id);
  assert.deepEqual(ids, ['Agata']);
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

test('mergeConversationThreads preserves pending in-flight messages and respects deleted threads', () => {
  const remote = [
    {
      id: 'c1',
      title: 'Sesja 1',
      updatedAt: '12:00',
      messages: [
        { id: 'm1', role: 'user' as const, sender: 'Op', content: 'Cześć', timestamp: '12:00' },
      ],
    },
    {
      id: 'c-deleted',
      title: 'Stara',
      updatedAt: '11:00',
      messages: [
        { id: 'm0', role: 'user' as const, sender: 'Op', content: 'Usuń mnie', timestamp: '11:00' },
      ],
    },
  ];
  const local = [
    {
      id: 'c1',
      title: 'Sesja 1',
      updatedAt: '12:01',
      messages: [
        { id: 'm1', role: 'user' as const, sender: 'Op', content: 'Cześć', timestamp: '12:00' },
        { id: 'm2', role: 'assistant' as const, sender: 'Agata', content: 'Odpowiedź w locie', timestamp: '12:01' },
      ],
    },
    {
      id: 'c-new',
      title: 'Nowa sesja',
      updatedAt: '12:02',
      messages: [
        { id: 'm3', role: 'assistant' as const, sender: 'SVL System Kernel', content: 'Start', timestamp: '12:02' },
      ],
    },
  ];

  const merged = mergeConversationThreads(remote, local, new Set(['m2', 'm3']), new Set(['c-deleted']));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'c-new');
  assert.deepEqual(merged[1].messages.map((m) => m.id), ['m1', 'm2']);
});

test('empty authoritative conversation snapshots do not restore stale local threads', () => {
  const staleLocal = [
    {
      id: 'stale-conversation',
      title: 'Stara sesja',
      updatedAt: '12:00',
      messages: [
        { id: 'stale-message', role: 'user' as const, sender: 'Op', content: 'Stara treść', timestamp: '12:00' },
      ],
    },
  ];

  assert.deepEqual(mergeConversationThreads([], staleLocal), []);
});

test('safeParseJsonResponse handles HTML <!doctype> and non-JSON payloads without SyntaxError', async () => {
  const htmlResp = new Response('<!doctype html><html><body>502 Bad Gateway</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  const htmlRes = await safeParseJsonResponse(htmlResp);
  assert.equal(htmlRes.ok, false);
  assert.equal(htmlRes.data, null);
  assert.equal(htmlRes.proxyHtml, true);
  assert.equal(htmlRes.offline, true);
  assert.ok(htmlRes.error?.includes('HTML'));

  const proxiedErrResp = new Response(
    JSON.stringify({ ok: false, upstreamStatus: 503, error: 'Chwilowe przeciążenie modelu AI.' }),
    { status: 424, headers: { 'Content-Type': 'application/json' } },
  );
  const proxiedErr = await safeParseJsonResponse(proxiedErrResp);
  assert.equal(proxiedErr.ok, false);
  assert.equal(proxiedErr.status, 424);
  assert.equal(proxiedErr.offline, true);
  assert.equal(proxiedErr.error, 'Chwilowe przeciążenie modelu AI.');

  const jsonResp = new Response(JSON.stringify({ ok: true, reply: 'Działa' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const jsonRes = await safeParseJsonResponse<{ ok: boolean; reply: string }>(jsonResp);
  assert.equal(jsonRes.ok, true);
  assert.equal(jsonRes.data?.reply, 'Działa');
  assert.equal(jsonRes.error, null);
});

test('extractExplicitChatModuleDirective detects svl-364 and explicit module commands', () => {
  const apex = extractExplicitChatModuleDirective('Skonfiguruj system dla statku svl-364 ebon apex');
  assert.ok(apex);
  assert.equal(apex.id, 'svl-364');
  assert.equal(apex.name, 'SVL-364 Ebon Apex');
  assert.equal(apex.config.async_event_bus_buffer, 4096);

  const custom = extractExplicitChatModuleDirective('Dodaj moduł telemetry-bridge-v2 do backendu');
  assert.ok(custom);
  assert.equal(custom.id, 'telemetry-bridge-v2');

  assert.equal(extractExplicitChatModuleDirective('Cześć Agata, jak minął dzień?'), null);
});

test('operator token initializes synchronously with valid default and formatAgentDisplayName accepts only Agata and Rodzina Mitek', () => {
  assert.equal(hasSvlOperatorAccessToken(), true);
  assert.equal(getSvlOperatorAccessToken(), DEFAULT_DEV_OPERATOR_TOKEN);
  assert.equal(validateOperatorTokenFormat(DEFAULT_DEV_OPERATOR_TOKEN).valid, true);

  setSvlOperatorAccessToken('custom-operator-secret-token-for-testing-36-chars');
  assert.equal(getSvlOperatorAccessToken(), 'custom-operator-secret-token-for-testing-36-chars');
  setSvlOperatorAccessToken(DEFAULT_DEV_OPERATOR_TOKEN);

  assert.equal(formatAgentDisplayName('Agata'), 'Agata Mitek');
  assert.equal(formatAgentDisplayName('Rodzina Mitek'), 'Rodzina Mitek (wszyscy)');
  assert.equal(normalizeAgentCanonicalName('Agata Mitek'), 'Agata');
  assert.equal(normalizeAgentCanonicalName('Aria'), null);
  assert.equal(normalizeAgentCanonicalName('si_1'), null);
  assert.equal(normalizeAgentCanonicalName('Alex'), null);
  assert.equal(normalizeAgentCanonicalName('Astyria'), null);
  assert.equal(normalizeAgentCanonicalName('Aurelius'), null);
});

test('parseWorkOrCodexCommand extracts @work directives and defaults to Agata while rejecting removed @codex', () => {
  const workDefault = parseWorkOrCodexCommand('@work sprawdź status modułów');
  assert.ok(workDefault);
  assert.equal(workDefault.mode, 'work');
  assert.equal(workDefault.targetAgent, 'Agata');
  assert.equal(workDefault.taskBody, 'sprawdź status modułów');

  const workTargeted = parseWorkOrCodexCommand('@work Agata: uruchom testy jądra');
  assert.ok(workTargeted);
  assert.equal(workTargeted.mode, 'work');
  assert.equal(workTargeted.targetAgent, 'Agata');
  assert.equal(workTargeted.taskBody, 'uruchom testy jądra');

  assert.equal(parseWorkOrCodexCommand('Proszę @codex status'), null);
  assert.equal(parseWorkOrCodexCommand('Zwykła rozmowa bez dyrektyw'), null);
});

test('formatIrisNotificationMessage builds standardized [Iris][count] lines and selectNextDuplexSpeaker routes to Agata', () => {
  const line = formatIrisNotificationMessage(7, 'WARN', 'Wykryto różnice GitHub', 'Nowe pliki: 2');
  assert.equal(line, '[Iris][7] WARN: Wykryto różnice GitHub\nNowe pliki: 2');

  assert.equal(selectNextDuplexSpeaker(['Agata Mitek'], 'Agata'), 'Agata');
  assert.equal(selectNextDuplexSpeaker(['Iris AI', 'Mateusz Mitek (Operator)']), 'Agata');
});

test('resolveAvatarProfileKey maps Agata, Iris AI, and Operator while ignoring removed agents', () => {
  assert.equal(resolveAvatarProfileKey('Agata Mitek', 'Agata'), 'Agata');
  assert.equal(resolveAvatarProfileKey('Iris AI', 'iris'), 'Iris');
  assert.equal(resolveAvatarProfileKey('Mateusz Mitek (Operator)', null), 'Operator');
  assert.equal(resolveAvatarProfileKey('Aria Mitek', 'si_1'), null);
  assert.equal(resolveAvatarProfileKey('Alex', null), null);
  assert.equal(resolveAvatarProfileKey('Astyria Mitek', 'Astyria'), null);
  assert.equal(resolveAvatarProfileKey('Aurelius Mitek', 'Aurelius'), null);
  assert.equal(resolveAvatarProfileKey('System SVL', null), null);
});

test('validateAvatarUrlOrDataUri accepts safe image URIs and rejects unsafe schemes', () => {
  assert.equal(validateAvatarUrlOrDataUri('https://example.com/agata.png').ok, true);
  assert.equal(validateAvatarUrlOrDataUri('data:image/png;base64,AAAA').ok, true);
  assert.equal(validateAvatarUrlOrDataUri('/assets/agata.jpg').ok, true);
  assert.equal(validateAvatarUrlOrDataUri('javascript:alert(1)').ok, false);
  assert.equal(validateAvatarUrlOrDataUri('data:text/html;base64,AAAA').ok, false);
  assert.equal(validateAvatarUrlOrDataUri('').ok, false);
});
