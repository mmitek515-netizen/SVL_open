import React, { useEffect, useState } from 'react';
import { ImagePlus, RefreshCw, RotateCcw, UploadCloud, X } from 'lucide-react';
import agataAvatarImg from '../assets/images/avatar_agata_mitek_1794741772325.jpg';
import irisAvatarImg from '../assets/images/avatar_iris_ai_1794741773355.jpg';
import operatorAvatarImg from '../assets/images/avatar_operator_mitek_1794750564484.jpg';
import {
  AvatarProfileKey,
  SvlAvatarMap,
  resolveAvatarProfileKey,
  safeFetchJson,
  validateAvatarUrlOrDataUri,
} from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

export const DEFAULT_AGENT_AVATARS: Partial<Record<AvatarProfileKey, string>> = {
  Agata: agataAvatarImg,
  Iris: irisAvatarImg,
  Operator: operatorAvatarImg,
};

const PROFILE_META: Record<
  AvatarProfileKey,
  { label: string; short: string; ringClass: string; bgClass: string; textClass: string }
> = {
  Agata: {
    label: 'Agata Mitek',
    short: 'AG',
    ringClass: 'border-purple-500/50',
    bgClass: 'bg-purple-950/60',
    textClass: 'text-purple-300',
  },
  Iris: {
    label: 'Iris AI',
    short: 'IR',
    ringClass: 'border-cyan-400/60',
    bgClass: 'bg-cyan-950/60',
    textClass: 'text-cyan-200',
  },
  Operator: {
    label: 'Mateusz Mitek (Operator)',
    short: 'MM',
    ringClass: 'border-violet-400/60',
    bgClass: 'bg-violet-950/70',
    textClass: 'text-violet-200',
  },
};

const PROFILE_LIST: Array<{ key: AvatarProfileKey; label: string }> = [
  { key: 'Agata', label: 'Agata Mitek' },
  { key: 'Iris', label: 'Iris AI' },
  { key: 'Operator', label: 'Mateusz Mitek (Operator)' },
];

export const SvlAvatar: React.FC<{
  sender?: string | null;
  agentId?: string | null;
  profileKey?: AvatarProfileKey | null;
  avatars?: SvlAvatarMap;
  size?: number;
  className?: string;
}> = ({ sender, agentId, profileKey, avatars, size = 32, className = '' }) => {
  const syncCtx = useSvlSync();
  const effectiveAvatars = avatars || syncCtx.avatars || {};
  const resolvedKey = profileKey ?? resolveAvatarProfileKey(sender, agentId);
  const meta = resolvedKey
    ? PROFILE_META[resolvedKey]
    : {
        label: String(sender || 'System SVL'),
        short: String(sender || 'SV').slice(0, 2).toUpperCase(),
        ringClass: 'border-slate-700',
        bgClass: 'bg-slate-800/80',
        textClass: 'text-slate-300',
      };

  const primarySrc = resolvedKey
    ? effectiveAvatars[resolvedKey] || DEFAULT_AGENT_AVATARS[resolvedKey] || ''
    : '';

  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [primarySrc]);

  const fontSize = Math.max(9, Math.round(size * 0.36));

  return (
    <span
      style={{ width: size, height: size, fontSize }}
      title={meta.label}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border ${meta.ringClass} ${meta.bgClass} ${meta.textClass} font-semibold select-none ${className}`}
    >
      {primarySrc && !imgFailed ? (
        <img
          src={primarySrc}
          alt={`Awatar: ${meta.label}`}
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span>{meta.short}</span>
      )}
    </span>
  );
};

export const AvatarSettingsModal: React.FC<{
  initialAgent?: AvatarProfileKey;
  onClose: () => void;
}> = ({ initialAgent = 'Agata', onClose }) => {
  const { avatars, saveAgentAvatar, resetAgentAvatar, refreshDomainModules } = useSvlSync();
  const [selectedProfile, setSelectedProfile] = useState<AvatarProfileKey>(initialAgent);
  const [sourceMode, setSourceMode] = useState<'file' | 'url' | 'prompt'>('file');
  const [urlInput, setUrlInput] = useState('');
  const [promptInput, setPromptInput] = useState('');
  const [previewSrc, setPreviewSrc] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (file?: File) => {
    setError(null);
    setNotice(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2_500_000) {
      setError('Wybierz obraz PNG, JPG lub WEBP o rozmiarze maksymalnie 2.5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPreviewSrc(String(reader.result || ''));
      setNotice(`Wczytano plik ${file.name}. Kliknij „Zapisz awatar”, aby utrwalić w SQLite.`);
    };
    reader.onerror = () => setError('Nie udało się odczytać wybranego pliku.');
    reader.readAsDataURL(file);
  };

  const handleGeneratePrompt = async () => {
    const cleanPrompt = promptInput.trim();
    if (!cleanPrompt) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await safeFetchJson<any>('/api/py/images/generate', {
        method: 'POST',
        timeoutMs: 120000,
        body: JSON.stringify({
          prompt: `Square editorial studio portrait avatar, crisp lighting, dark slate backdrop, no text: ${cleanPrompt}`,
        }),
      });
      if (!res.ok || !res.data?.ok || !res.data?.image) {
        throw new Error(res.error || res.data?.error || 'Lokalny generator obrazów jest obecnie niedostępny.');
      }
      setPreviewSrc(String(res.data.image));
      setNotice('Wygenerowano nowy portret przez Qwen Image. Kliknij „Zapisz awatar”.');
    } catch (err: any) {
      setError(err?.message || 'Nie udało się wygenerować awatara.');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    setNotice(null);
    const candidate = sourceMode === 'url' ? urlInput.trim() : previewSrc;
    const valid = validateAvatarUrlOrDataUri(candidate);
    if (!valid.ok) {
      setError('error' in valid ? valid.error : 'Nieprawidłowy obraz awatara.');
      return;
    }
    setBusy(true);
    try {
      const res = await saveAgentAvatar(selectedProfile, valid.value);
      if (!res.ok) {
        setError(res.error || 'Błąd zapisu awatara.');
        return;
      }
      setNotice(`Zapisano awatar dla ${PROFILE_META[selectedProfile].label} w bazie SQLite.`);
      setPreviewSrc('');
      setUrlInput('');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await resetAgentAvatar(selectedProfile);
      if (!res.ok) {
        setError(res.error || 'Nie udało się przywrócić awatara.');
        return;
      }
      setPreviewSrc('');
      setNotice(`Przywrócono domyślny portret SVL dla ${PROFILE_META[selectedProfile].label}.`);
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setError(null);
    setBusy(true);
    try {
      await refreshDomainModules(['avatars']);
      setNotice('Odświeżono konfigurację awatarów z SQLite.');
    } finally {
      setBusy(false);
    }
  };

  const hasCustomOverride = Boolean(avatars[selectedProfile]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Awatary agentów i operatora SVL"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-700/80 bg-[#111520] p-5 text-slate-100 shadow-2xl space-y-4">
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Awatary Rodziny Mitek, Iris i Operatora</h2>
            <p className="text-xs text-slate-400">
              Zmiany zapisywane są w SQLite i odświeżane natychmiast na czacie oraz w panelu agentów.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij edytor awatarów"
            className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* All profile thumbnails */}
        <div className="grid grid-cols-3 gap-2">
          {PROFILE_LIST.map((p) => {
            const active = selectedProfile === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setSelectedProfile(p.key);
                  setPreviewSrc('');
                  setError(null);
                  setNotice(null);
                }}
                className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-[11px] transition-colors ${
                  active
                    ? 'border-violet-500 bg-violet-600/20 text-white'
                    : 'border-slate-800 bg-[#0B0D13] text-slate-300 hover:border-slate-700'
                }`}
              >
                <SvlAvatar profileKey={p.key} size={36} />
                <span className="truncate w-full text-center font-medium">{p.key}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-[#0B0D13] p-3">
          <SvlAvatar profileKey={selectedProfile} size={52} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-semibold text-slate-100">{PROFILE_META[selectedProfile].label}</p>
            <p className="text-xs text-slate-400">
              {hasCustomOverride
                ? 'Używa własnego awatara zapisanego w SQLite.'
                : DEFAULT_AGENT_AVATARS[selectedProfile]
                  ? 'Używa domyślnego portretu SVL Python OS.'
                  : 'Monogram domyślny (możesz wgrać zdjęcie lub podać adres HTTPS).'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-slate-300">
            <span>Profil</span>
            <select
              value={selectedProfile}
              onChange={(e) => {
                setSelectedProfile(e.target.value as AvatarProfileKey);
                setPreviewSrc('');
              }}
              className="w-full rounded-lg border border-slate-700 bg-[#0B0D13] px-2.5 py-2 text-xs text-slate-100"
            >
              {PROFILE_LIST.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            <span>Źródło obrazu</span>
            <select
              value={sourceMode}
              onChange={(e) => {
                setSourceMode(e.target.value as 'file' | 'url' | 'prompt');
                setError(null);
              }}
              className="w-full rounded-lg border border-slate-700 bg-[#0B0D13] px-2.5 py-2 text-xs text-slate-100"
            >
              <option value="file">Plik PNG / JPG / WEBP</option>
              <option value="url">Adres HTTPS</option>
              <option value="prompt">Generuj przez ComfyUI / Qwen</option>
            </select>
          </label>
        </div>

        {sourceMode === 'file' && (
          <label className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-700 bg-[#0B0D13] px-3 py-4 text-xs text-slate-300 cursor-pointer hover:border-violet-500/60">
            <UploadCloud className="w-4 h-4 text-violet-400" />
            <span>Wybierz plik z urządzenia (PNG/JPG/WEBP, maks. 2.5 MB)</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => handleFileChange(e.target.files?.[0])}
              className="sr-only"
            />
          </label>
        )}

        {sourceMode === 'url' && (
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/avatar.png"
            aria-label="Adres HTTPS awatara"
            className="w-full rounded-lg border border-slate-700 bg-[#0B0D13] px-3 py-2 text-xs text-slate-100"
          />
        )}

        {sourceMode === 'prompt' && (
          <div className="space-y-2">
            <textarea
              rows={2}
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              placeholder="Opisz portret awatara..."
              className="w-full rounded-lg border border-slate-700 bg-[#0B0D13] px-3 py-2 text-xs text-slate-100"
            />
            <button
              type="button"
              disabled={busy || !promptInput.trim()}
              onClick={() => void handleGeneratePrompt()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600/30 hover:bg-violet-600/45 border border-violet-500/40 px-3 py-1.5 text-xs font-medium text-violet-100 disabled:opacity-40"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              Wygeneruj portret
            </button>
          </div>
        )}

        {previewSrc && (
          <div className="flex items-center gap-3">
            <img
              src={previewSrc}
              alt="Podgląd nowego awatara"
              referrerPolicy="no-referrer"
              className="h-16 w-16 rounded-full border border-violet-400/50 object-cover"
            />
            <span className="text-xs text-slate-400">Podgląd gotowy do zapisania.</span>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">
            {notice}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || (sourceMode === 'url' ? !urlInput.trim() : !previewSrc)}
              onClick={() => void handleSave()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-40"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              Zapisz awatar
            </button>
            <button
              type="button"
              disabled={busy || !hasCustomOverride}
              onClick={() => void handleReset()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Przywróć domyślny
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRefresh()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0B0D13] hover:bg-slate-800 px-3 py-2 text-xs text-slate-300 disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Odśwież
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-800"
          >
            Zamknij
          </button>
        </div>
      </div>
    </div>
  );
};
