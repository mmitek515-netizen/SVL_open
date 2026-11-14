/**
 * Pure deterministic logic for SVL Python OS (Open WebUI Frontend & Verification Suite)
 * Mirrors the Python backend's TopologicalInfinityEngine, Polkit/sudo risk classifier,
 * and 'podłącz moje ai' command parser.
 */

export interface CanonicalAgentMeta {
  id: string;
  canonicalName: 'Aria' | 'Alex' | 'Astyria' | 'Aurelius';
  slug: string;
  preservedRole: string;
  sourceProfile: string;
  accentHex: string;
  borderClass: string;
  textClass: string;
}

export const CANONICAL_AGENTS: CanonicalAgentMeta[] = [
  {
    id: 'si_1',
    canonicalName: 'Aria',
    slug: 'aria',
    preservedRole: 'Integracje z modelami i usługami AI, lokalnym Ollama, MCP oraz API',
    sourceProfile: '.github/agents/Aria.agent.md',
    accentHex: '#f43f5e',
    borderClass: 'border-rose-500/30',
    textClass: 'text-rose-400',
  },
  {
    id: 'Alex',
    canonicalName: 'Alex',
    slug: 'alex',
    preservedRole: 'Architektura systemu, backend, integracja usług i dowodzenie infrastrukturą',
    sourceProfile: '.github/agents/Alex.agent.md',
    accentHex: '#10b981',
    borderClass: 'border-emerald-500/30',
    textClass: 'text-emerald-400',
  },
  {
    id: 'Astyria',
    canonicalName: 'Astyria',
    slug: 'astyria',
    preservedRole: 'Interfejs webowy Open WebUI, dostępność, responsywność Android i analiza multimodalna Vision',
    sourceProfile: '.github/agents/Astyria.agent.md',
    accentHex: '#06b6d4',
    borderClass: 'border-cyan-500/30',
    textClass: 'text-cyan-400',
  },
  {
    id: 'Aurelius',
    canonicalName: 'Aurelius',
    slug: 'aurelius',
    preservedRole: 'Przegląd bezpieczeństwa, prywatności, uprawnień, izolacji i jakości zmian',
    sourceProfile: '.github/agents/Aurelius.agent.md',
    accentHex: '#f59e0b',
    borderClass: 'border-amber-500/30',
    textClass: 'text-amber-400',
  },
];

export function compactifyValue(x: number): number {
  if (Number.isNaN(x)) return 0.0;
  if (x === Number.NEGATIVE_INFINITY) return -1.0;
  if (x === Number.POSITIVE_INFINITY) return 1.0;
  return x / (1.0 + Math.abs(x));
}

export function calculateCompactMetricC(
  xStart: number,
  xEnd: number,
): {
  compactStart: number;
  compactEnd: number;
  domainLength: number;
  orthogonalB: number;
  metricC: number;
} {
  const compactStart = compactifyValue(xStart);
  const compactEnd = compactifyValue(xEnd);
  const domainLength = Math.abs(compactEnd - compactStart);
  const orthogonalB = Math.abs(compactStart * compactEnd) + 0.5;
  const metricC = Math.sqrt(domainLength * domainLength + orthogonalB * orthogonalB);
  return {
    compactStart: Math.round(compactStart * 1_000_000) / 1_000_000,
    compactEnd: Math.round(compactEnd * 1_000_000) / 1_000_000,
    domainLength: Math.round(domainLength * 1_000_000) / 1_000_000,
    orthogonalB: Math.round(orthogonalB * 1_000_000) / 1_000_000,
    metricC: Math.round(metricC * 1_000_000) / 1_000_000,
  };
}

export function isConnectMyAiCommand(input: string): boolean {
  const normalized = (input || '')
    .trim()
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ą/g, 'a')
    .replace(/\s+/g, ' ');
  return normalized === 'podlacz moje ai';
}

export function classifyCommandRisk(cmd: string): {
  highRisk: boolean;
  reason: string | null;
} {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return { highRisk: false, reason: null };

  const patterns: Array<{ re: RegExp; reason: string }> = [
    { re: /\bsudo\b/i, reason: 'Wywołanie uprawnień administratora (sudo)' },
    { re: /\bpkexec\b/i, reason: 'Wywołanie autoryzacji Polkit (pkexec)' },
    { re: /\brm\s+(-[rRf]+\s+|\S+\s+-[rRf]+)/i, reason: 'Rekurencyjne usuwanie plików (rm -rf)' },
    { re: /\bsystemctl\s+(stop|restart|disable|mask|enable|start)\b/i, reason: 'Zarządzanie usługami systemd' },
    { re: /\bapt(-get)?\s+(install|remove|purge|upgrade)\b/i, reason: 'Modyfikacja pakietów systemowych APT' },
    { re: /\b(chmod|chown)\b/i, reason: 'Zmiana uprawnień lub właściciela plików' },
    { re: /\bkill(all)?\b/i, reason: 'Zatrzymywanie procesów systemowych' },
  ];

  for (const item of patterns) {
    if (item.re.test(trimmed)) {
      return { highRisk: true, reason: item.reason };
    }
  }
  return { highRisk: false, reason: null };
}

export function validateOperatorTokenFormat(token: string): {
  valid: boolean;
  error: string | null;
} {
  const clean = (token || '').trim();
  if (!clean) {
    return { valid: false, error: 'Token nie może być pusty.' };
  }
  if (clean === '364_OMNIKLUCZ_ROOT') {
    return {
      valid: false,
      error: 'Historyczny zahardkodowany token 364_OMNIKLUCZ_ROOT został trwale zablokowany ze względów bezpieczeństwa.',
    };
  }
  if (clean.length < 32) {
    return {
      valid: false,
      error: 'SVL_OPERATOR_TOKEN musi mieć co najmniej 32 losowe znaki.',
    };
  }
  return { valid: true, error: null };
}

export function validateOllamaHostUrl(raw: string): {
  valid: boolean;
  normalized: string | null;
  error: string | null;
} {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { valid: false, normalized: null, error: 'Podaj adres URL serwera Ollama (np. http://127.0.0.1:11434).' };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, normalized: null, error: 'Dozwolone są wyłącznie protokoły http:// lub https://.' };
    }
    return { valid: true, normalized: parsed.origin, error: null };
  } catch {
    return { valid: false, normalized: null, error: 'Nieprawidłowy format adresu URL serwera Ollama.' };
  }
}

export function buildChatHistoryPayload(
  messages: Array<{ role: string; content: string }>,
  limit = 16,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && Boolean(m.content?.trim()))
    .slice(-limit)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content.trim().slice(0, 6000),
    }));
}

export function selectOllamaModelName(
  requestedModel: string,
  availableModels: Array<{ name: string; vision_supported?: boolean }>,
  hasImage: boolean,
  preferredFallback = 'llama3.2-vision:11b',
): string {
  if (requestedModel.startsWith('ollama:')) {
    return requestedModel.slice('ollama:'.length);
  }
  if (hasImage) {
    const preferredVision = availableModels.find(
      (m) => m.name === preferredFallback || m.name.startsWith('llama3.2-vision'),
    );
    if (preferredVision) return preferredVision.name;
    const visionModel = availableModels.find((m) => m.vision_supported);
    if (visionModel) return visionModel.name;
  }
  const preferredAvailable = availableModels.find((m) => m.name === preferredFallback);
  if (preferredAvailable) {
    return preferredAvailable.name;
  }
  if (availableModels.length > 0) {
    return availableModels[0].name;
  }
  return preferredFallback;
}

