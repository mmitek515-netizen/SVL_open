import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoogleGenAI } from '@google/genai';
import { isValidAgentAvatar, searchLicensedAgentAvatars } from './agentAvatars.ts';

const validAvatar = {
  title: 'Test portrait',
  image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/test.jpg/256px-test.jpg',
  source_url: 'https://commons.wikimedia.org/wiki/File:Test.jpg',
  license: 'CC BY-SA 4.0',
  author: 'Test artist',
};

test('agent avatars must use verified Wikimedia image and file-page hosts', () => {
  assert.equal(isValidAgentAvatar(validAvatar), true);
  assert.equal(isValidAgentAvatar({ ...validAvatar, image_url: 'https://attacker.example/avatar.png' }), false);
  assert.equal(isValidAgentAvatar({ ...validAvatar, source_url: 'https://example.com/File:Test.jpg' }), false);
  assert.equal(isValidAgentAvatar({ ...validAvatar, image_url: 'https://user@upload.wikimedia.org/avatar.jpg' }), false);
});

test('agent avatars reject non-permissive or missing license metadata', () => {
  assert.equal(isValidAgentAvatar({ ...validAvatar, license: 'All rights reserved' }), false);
  assert.equal(isValidAgentAvatar({ ...validAvatar, license: 'CC BY-NC 4.0' }), false);
  assert.equal(isValidAgentAvatar({ ...validAvatar, author: 5 }), false);
});

test('avatar search checks Commons license metadata before returning a result', async () => {
  const ai = {
    models: {
      generateContent: async () => ({
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                { web: { title: 'Test portrait', uri: validAvatar.source_url } },
                { web: { title: 'Untrusted image', uri: 'https://images.example/avatar.jpg' } },
              ],
            },
          },
        ],
      }),
    },
  } as unknown as GoogleGenAI;

  const candidates = await searchLicensedAgentAvatars(ai, 'portrait', async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: {
            1: {
              imageinfo: [
                {
                  thumburl: validAvatar.image_url,
                  extmetadata: {
                    LicenseShortName: { value: 'CC BY-SA 4.0' },
                    Artist: { value: '<a>Test artist</a>' },
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  assert.deepEqual(candidates, [validAvatar]);
});
