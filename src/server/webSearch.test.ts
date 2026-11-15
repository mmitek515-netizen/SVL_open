import assert from 'node:assert/strict';
import test from 'node:test';
import { appendWebSources, collectWebSources, isWebSearchRequest } from './webSearch.ts';

test('web search intent recognizes link requests and current information', () => {
  assert.equal(isWebSearchRequest('Podaj mi linki z internetu o SD-Turbo.'), true);
  assert.equal(isWebSearchRequest('Jaka jest najnowsza wersja Node.js?'), true);
  assert.equal(isWebSearchRequest('Sprawdź w sieci aktualne informacje.'), true);
});

test('web search intent does not mistake a bug report or coding request for a search', () => {
  assert.equal(isWebSearchRequest('AI nie wysyła linków z internetu, napraw to.'), false);
  assert.equal(isWebSearchRequest('Dodaj link do przycisku w kodzie.'), false);
  assert.equal(isWebSearchRequest('Wyjaśnij różnicę między HTTP i HTTPS.'), false);
});

test('grounding sources are validated, deduplicated and rendered as clickable Markdown links', () => {
  const sources = collectWebSources({
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            { web: { title: 'Dokumentacja [oficjalna]', uri: 'https://example.com/docs' } },
            { web: { title: 'Duplikat', uri: 'https://example.com/docs' } },
            { web: { title: 'Niebezpieczne', uri: 'javascript:alert(1)' } },
            { web: { title: 'Lokalne', uri: 'http://localhost:3000' } },
          ],
        },
      },
    ],
  });

  assert.deepEqual(sources, [{ title: 'Dokumentacja oficjalna', uri: 'https://example.com/docs' }]);
  assert.equal(
    appendWebSources('Oto odpowiedź.', sources),
    'Oto odpowiedź.\n\n### Źródła z internetu\n- [Dokumentacja oficjalna](https://example.com/docs)',
  );
  assert.equal(appendWebSources('Bez źródeł.', []), 'Bez źródeł.');
});
