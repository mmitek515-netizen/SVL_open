import type { GoogleGenAI } from '@google/genai';
import { collectWebSources } from './webSearch.ts';

export type AgentAvatar = {
  title: string;
  image_url: string;
  source_url: string;
  license: string;
  author: string;
};

type CommonsApiResponse = {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        imageinfo?: Array<{
          thumburl?: string;
          extmetadata?: {
            LicenseShortName?: { value?: string };
            Artist?: { value?: string };
          };
        }>;
      }
    >;
  };
};

function plainMetadata(value: string | undefined, maxLength: number): string {
  return (value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isAllowedLicense(license: string): boolean {
  return /^(?:public domain\b|cc0\b|cc by(?:-sa)?\s+[1-4](?:\.\d)?\b)/i.test(license.trim());
}

export function isValidAgentAvatar(value: unknown): value is AgentAvatar {
  if (!value || typeof value !== 'object') return false;
  const avatar = value as Partial<AgentAvatar>;
  try {
    const imageUrl = new URL(String(avatar.image_url || ''));
    const sourceUrl = new URL(String(avatar.source_url || ''));
    return (
      imageUrl.protocol === 'https:' &&
      imageUrl.hostname === 'upload.wikimedia.org' &&
      !imageUrl.username &&
      !imageUrl.password &&
      sourceUrl.protocol === 'https:' &&
      sourceUrl.hostname === 'commons.wikimedia.org' &&
      sourceUrl.pathname.startsWith('/wiki/File:') &&
      !sourceUrl.username &&
      !sourceUrl.password &&
      typeof avatar.title === 'string' &&
      avatar.title.length > 0 &&
      avatar.title.length <= 160 &&
      typeof avatar.author === 'string' &&
      avatar.author.length <= 200 &&
      typeof avatar.license === 'string' &&
      isAllowedLicense(avatar.license)
    );
  } catch {
    return false;
  }
}

export async function searchLicensedAgentAvatars(
  ai: GoogleGenAI,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<AgentAvatar[]> {
  const cleanQuery = query.trim().slice(0, 120);
  if (cleanQuery.length < 2) throw new Error('Wpisz co najmniej 2 znaki do wyszukiwania avatara.');

  let groundedResponse;
  let lastSearchError: unknown;
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
    try {
      groundedResponse = await ai.models.generateContent({
        model,
        contents:
          `Search Google for avatar or portrait image file pages on Wikimedia Commons matching: "${cleanQuery}". ` +
          `Only consider public domain, CC0, CC BY, or CC BY-SA works. Return grounded Commons file pages, not image hotlinks.`,
        config: {
          tools: [{ googleSearch: {} }],
          abortSignal: AbortSignal.timeout(18000),
        },
      });
      break;
    } catch (error) {
      lastSearchError = error;
    }
  }
  if (!groundedResponse) {
    throw new Error(
      lastSearchError instanceof Error
        ? `Google Search nie zwrócił wyników avatarów: ${lastSearchError.message}`
        : 'Google Search nie zwrócił wyników avatarów.',
    );
  }

  const commonsPages = collectWebSources(groundedResponse)
    .map((source) => {
      try {
        const url = new URL(source.uri);
        return url.protocol === 'https:' && url.hostname === 'commons.wikimedia.org' &&
          !url.username && !url.password && url.pathname.startsWith('/wiki/File:')
          ? { title: source.title, url }
          : null;
      } catch {
        return null;
      }
    })
    .filter((page): page is { title: string; url: URL } => page !== null);

  const candidates: AgentAvatar[] = [];
  const seenPages = new Set<string>();
  for (const page of commonsPages) {
    if (seenPages.has(page.url.href)) continue;
    seenPages.add(page.url.href);
    let fileTitle: string;
    try {
      fileTitle = decodeURIComponent(page.url.pathname.slice('/wiki/'.length)).replace(/_/g, ' ');
    } catch {
      continue;
    }
    const apiUrl = new URL('https://commons.wikimedia.org/w/api.php');
    apiUrl.search = new URLSearchParams({
      action: 'query',
      titles: fileTitle,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
      iiurlwidth: '256',
      format: 'json',
    }).toString();
    const response = await fetcher(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'SVL_open agent-avatar search' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      throw new Error(`Wikimedia Commons zwróciło HTTP ${response.status} podczas weryfikacji licencji.`);
    }
    const payload = (await response.json()) as CommonsApiResponse;
    const image = Object.values(payload.query?.pages || {})[0]?.imageinfo?.[0];
    if (!image) continue;

    const license = plainMetadata(image.extmetadata?.LicenseShortName?.value, 80);
    if (!isAllowedLicense(license)) continue;

    let imageUrl: URL;
    try {
      imageUrl = new URL(image.thumburl || '');
    } catch {
      continue;
    }
    if (
      imageUrl.protocol !== 'https:' ||
      imageUrl.hostname !== 'upload.wikimedia.org' ||
      imageUrl.username ||
      imageUrl.password
    ) continue;

    candidates.push({
      title: plainMetadata(page.title, 160) || fileTitle.slice(5, 160),
      image_url: imageUrl.href,
      source_url: page.url.href,
      license,
      author: plainMetadata(image.extmetadata?.Artist?.value, 200),
    });
    if (candidates.length === 5) break;
  }

  return candidates;
}
