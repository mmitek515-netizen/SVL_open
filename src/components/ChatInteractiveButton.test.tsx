import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatInteractiveButton } from './ChatInteractiveButton';
import { renderFormattedContent } from './ChatWorkspace';
import { isUnsafeChatInteractiveAction, parseChatInteractiveToken } from '../utils/svlLogic';

test('AI chat action tokens render as Compound buttons', () => {
  const parsed = parseChatInteractiveToken('[btn: Otwórz panel agentów|tab:agents]');
  assert.ok(parsed);

  const html = renderToStaticMarkup(
    React.createElement(ChatInteractiveButton, {
      ...parsed,
      disabled: isUnsafeChatInteractiveAction(parsed.action),
    }),
  );

  assert.match(html, /role="button"/);
  assert.match(html, /aria-disabled="false"/);
  assert.match(html, /type="button"/);
  assert.match(html, />Otwórz panel agentów<\/button>/);
});

test('unsafe AI chat actions render disabled in the Compound component', () => {
  const parsed = parseChatInteractiveToken('[btn: Niebezpieczna akcja|send:/exec id]');
  assert.ok(parsed);

  const html = renderToStaticMarkup(
    React.createElement(ChatInteractiveButton, {
      ...parsed,
      disabled: isUnsafeChatInteractiveAction(parsed.action),
    }),
  );

  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /Przyciski czatu nie mogą uruchamiać poleceń powłoki/);
});

test('formatted chat and notification content render the same safe interactive actions', () => {
  const content = renderFormattedContent(
    '**Aktualizacja**\n[btn: Otwórz panel agentów|tab:agents]\n[btn: Nie uruchamiaj powłoki|send:/exec id]',
    () => {},
  );
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, content));

  assert.match(html, /<strong[^>]*>Aktualizacja<\/strong>/);
  assert.match(html, /Otwórz panel agentów/);
  assert.match(html, /aria-disabled="false"/);
  assert.match(html, /aria-disabled="true"/);
});
