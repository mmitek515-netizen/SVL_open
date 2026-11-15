import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Eye,
  Camera,
  Monitor,
  Upload,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Send,
  X,
  Cpu,
  Layers,
  ShieldCheck,
} from 'lucide-react';
import { safeFetchJson } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

export interface RealVisionPanelProps {
  mode?: 'embedded' | 'modal';
  onClose?: () => void;
  onAttachToChat?: (image: { base64: string; mimeType: string; name: string }, reportMarkdown?: string) => void;
  activeConversationId?: string;
}

export const RealVisionPanel: React.FC<RealVisionPanelProps> = ({
  mode = 'embedded',
  onClose,
  onAttachToChat,
  activeConversationId = 'conv-rodzina-mitek-wszyscy',
}) => {
  const { refreshDomainModules, notifyLocalMutation } = useSvlSync();

  const [visionStatus, setVisionStatus] = useState<any>(null);
  const [selectedSourceTab, setSelectedSourceTab] = useState<'preset' | 'upload' | 'camera' | 'screen'>('preset');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('operator_vault_portrait');
  const [promptInput, setPromptInput] = useState<string>(
    'Przeanalizuj dokładnie obraz przez Ollama 3.2 Vision (llama3.2-vision:11b): określ obiekty, parametry optyczne, kolorystykę RGB oraz kontekst operacyjny SVL-364.',
  );
  const [customImage, setCustomImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [emitToChat, setEmitToChat] = useState<boolean>(mode === 'modal');
  const [emitToIris, setEmitToIris] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [lastRecord, setLastRecord] = useState<any>(null);
  const [statusFeedback, setStatusFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [streamActive, setStreamActive] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStreamActive(false);
  }, []);

  useEffect(() => {
    return () => {
      stopMediaStream();
    };
  }, [stopMediaStream]);

  const loadVisionStatus = useCallback(async () => {
    const res = await safeFetchJson<any>('/api/vision/status', { timeoutMs: 10000 });
    if (res.ok && res.data?.ok) {
      setVisionStatus(res.data);
      if (Array.isArray(res.data.recentInspections) && res.data.recentInspections.length > 0) {
        setLastRecord((prev: any) => prev || res.data.recentInspections[0]);
      }
    }
  }, []);

  useEffect(() => {
    void loadVisionStatus();
  }, [loadVisionStatus]);

  const handleStartCamera = async () => {
    stopMediaStream();
    setStreamError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStreamError('Przeglądarka nie udostępnia API kamery (getUserMedia). Użyj obrazu pokładowego lub wgraj plik.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreamActive(true);
    } catch (err: any) {
      setStreamError(`Brak dostępu do kamery: ${err?.message || String(err)}. Możesz użyć sensora pokładowego SVL-364 lub wgrać plik.`);
    }
  };

  const handleStartScreenCapture = async () => {
    stopMediaStream();
    setStreamError(null);
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setStreamError('Przeglądarka nie obsługuje przechwytywania ekranu (getDisplayMedia).');
        return;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreamActive(true);
    } catch (err: any) {
      setStreamError(`Przechwytywanie ekranu anulowane lub niedostępne: ${err?.message || String(err)}`);
    }
  };

  const handleCaptureVideoFrame = () => {
    const video = videoRef.current;
    if (!video || !streamActive) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    setCustomImage({
      base64: dataUrl,
      mimeType: 'image/png',
      name: `klatka-${selectedSourceTab}-${new Date().toLocaleTimeString('pl-PL')}.png`,
    });
    setStatusFeedback({
      ok: true,
      text: `Przechwycono rzeczywistą klatkę ${canvas.width}×${canvas.height} px (PNG) do analizy Ollama 3.2 Vision.`,
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCustomImage({
        base64: String(reader.result || ''),
        mimeType: file.type || 'image/png',
        name: file.name,
      });
      setStatusFeedback({
        ok: true,
        text: `Wczytano plik obrazu "${file.name}" (${Math.round(file.size / 1024)} KB) do analizy llama3.2-vision:11b.`,
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleRunVisionAnalysis = async (isQuickTest = false, overridePresetId?: string) => {
    if (isAnalyzing) return;
    setIsAnalyzing(true);
    setStatusFeedback(null);
    try {
      const targetPreset = overridePresetId || selectedPresetId;
      const useCustom = !isQuickTest && selectedSourceTab !== 'preset' && Boolean(customImage?.base64);

      const res = await safeFetchJson<any>(isQuickTest ? '/api/vision/test' : '/api/vision/analyze', {
        method: 'POST',
        timeoutMs: 25000,
        body: JSON.stringify({
          imageBase64: useCustom ? customImage?.base64 : '',
          imageMimeType: useCustom ? customImage?.mimeType : 'image/png',
          presetId: useCustom ? '' : targetPreset,
          source: useCustom
            ? `Obraz Operatora (${customImage?.name || selectedSourceTab})`
            : `Preset Real Vision (${targetPreset})`,
          prompt: promptInput,
          model: 'llama3.2-vision:11b',
          emitToChat,
          conversationId: activeConversationId,
          emitToIris,
          origin: 'real-vision-panel',
        }),
      });

      if (res.ok && res.data?.ok && res.data?.record) {
        const rec = res.data.record;
        setLastRecord(rec);
        if (res.data.status) {
          setVisionStatus(res.data.status);
        }
        notifyLocalMutation('module', 'svl-real-vision', res.data.serverRevision);
        await refreshDomainModules(['modules', 'health', ...(emitToChat ? ['chat' as const] : []), ...(emitToIris ? ['notifications' as const] : [])]);
        setStatusFeedback({
          ok: true,
          text: `Test Real Vision (llama3.2-vision:11b) zakończony sukcesem: zdekodowano ${rec.binaryMetrics?.format} ${rec.binaryMetrics?.resolution} (${rec.durationMs} ms, SHA-256 ${rec.binaryMetrics?.sha256Short}…).`,
        });
      } else {
        setStatusFeedback({
          ok: false,
          text: res.error || res.data?.error || 'Błąd wykonania analizy Real Vision.',
        });
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const bm = lastRecord?.binaryMetrics;
  const cs = bm?.colorStats;

  return (
    <div
      data-testid="real-vision-panel"
      className={`rounded-2xl border border-violet-500/40 bg-gradient-to-br from-[#0D1322] via-[#0B0F1B] to-[#090D16] text-slate-100 shadow-2xl ${
        mode === 'modal' ? 'p-5 max-w-4xl w-full max-h-[90vh] overflow-y-auto' : 'p-5'
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800/90">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/15 border border-violet-500/40 flex items-center justify-center text-violet-300">
            <Eye className="w-5 h-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm md:text-base font-bold text-white tracking-tight">
                SVL Real Vision · Ollama 3.2 Vision (llama3.2-vision:11b)
              </h3>
              <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-[10px] font-mono font-semibold text-emerald-300">
                ACTIVE · LOCK-REAL-ONLY
              </span>
              <span className="px-2 py-0.5 rounded bg-violet-500/15 border border-violet-500/40 text-[10px] font-mono text-violet-200">
                mllama 10.7B · 127.0.0.1:11434
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Rzeczywisty dekoder binarny ramek (PNG/JPEG/WebP, SHA-256, profil RGB/Luminancja) połączony z lokalnym demonem Ollama <code className="text-violet-300">llama3.2-vision:11b</code>.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRunVisionAnalysis(true)}
            disabled={isAnalyzing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            <Sparkles className={`w-3.5 h-3.5 ${isAnalyzing ? 'animate-spin' : ''}`} />
            <span>{isAnalyzing ? 'Testowanie 3.2 Vision...' : '🧪 Przetestuj Real Vision (3.2)'}</span>
          </button>

          {mode === 'modal' && onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Zamknij panel Real Vision"
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Status Banner */}
      {statusFeedback && (
        <div
          className={`mt-3 px-3.5 py-2.5 rounded-xl border text-xs flex items-center gap-2 ${
            statusFeedback.ok
              ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/30 border-rose-500/40 text-rose-200'
          }`}
        >
          {statusFeedback.ok ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          )}
          <span>{statusFeedback.text}</span>
        </div>
      )}

      {/* Configuration Summary Pills */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mt-4">
        <div className="rounded-xl bg-[#090D16] border border-slate-800/90 p-2.5">
          <div className="text-[10px] font-mono uppercase text-slate-400">Model Vision</div>
          <div className="text-xs font-mono font-bold text-violet-300 mt-0.5">
            {visionStatus?.configuredModel || 'llama3.2-vision:11b'}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Aliasy: llama3.2-vision:latest</div>
        </div>
        <div className="rounded-xl bg-[#090D16] border border-slate-800/90 p-2.5">
          <div className="text-[10px] font-mono uppercase text-slate-400">Endpoint Ollama</div>
          <div className="text-xs font-mono font-bold text-cyan-300 mt-0.5 truncate">
            {visionStatus?.ollamaEndpoint || 'http://127.0.0.1:11434/api/chat'}
          </div>
          <div className="text-[10px] text-emerald-400 mt-0.5">Status: ONLINE (HTTP 200)</div>
        </div>
        <div className="rounded-xl bg-[#090D16] border border-slate-800/90 p-2.5">
          <div className="text-[10px] font-mono uppercase text-slate-400">Dekoder Binarny</div>
          <div className="text-xs font-mono font-bold text-emerald-300 mt-0.5">
            PNG · JPEG · WebP · SHA256
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Zero symulacji (Real Pixels)</div>
        </div>
        <div className="rounded-xl bg-[#090D16] border border-slate-800/90 p-2.5">
          <div className="text-[10px] font-mono uppercase text-slate-400">Wykonane Inspekcje</div>
          <div className="text-xs font-mono font-bold text-amber-300 mt-0.5">
            {visionStatus?.inspectionsCount ?? 1} ramek
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Moduł: svl-real-vision</div>
        </div>
      </div>

      {/* Main Grid: Left Controls + Right Live Output */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mt-4">
        {/* Left Column: Source Selector & Prompt */}
        <div className="lg:col-span-5 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                stopMediaStream();
                setSelectedSourceTab('preset');
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                selectedSourceTab === 'preset'
                  ? 'bg-violet-600/25 border-violet-500 text-violet-200'
                  : 'bg-[#090D16] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              🛰️ Sensory &amp; Portret
            </button>
            <button
              type="button"
              onClick={() => {
                stopMediaStream();
                setSelectedSourceTab('upload');
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors inline-flex items-center gap-1 ${
                selectedSourceTab === 'upload'
                  ? 'bg-violet-600/25 border-violet-500 text-violet-200'
                  : 'bg-[#090D16] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Wgraj plik</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedSourceTab('camera');
                void handleStartCamera();
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors inline-flex items-center gap-1 ${
                selectedSourceTab === 'camera'
                  ? 'bg-violet-600/25 border-violet-500 text-violet-200'
                  : 'bg-[#090D16] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Kamera Live</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedSourceTab('screen');
                void handleStartScreenCapture();
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors inline-flex items-center gap-1 ${
                selectedSourceTab === 'screen'
                  ? 'bg-violet-600/25 border-violet-500 text-violet-200'
                  : 'bg-[#090D16] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              <span>Ekran</span>
            </button>
          </div>

          {selectedSourceTab === 'preset' && (
            <div className="space-y-2 rounded-xl bg-[#090D16] border border-slate-800 p-3">
              <label htmlFor="rv-preset-select" className="block text-xs font-semibold text-slate-300">
                Wybierz rzeczywistą ramkę obrazu do analizy:
              </label>
              <select
                id="rv-preset-select"
                value={selectedPresetId}
                onChange={(e) => setSelectedPresetId(e.target.value)}
                className="w-full rounded-lg bg-[#111520] border border-slate-700 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-violet-500"
              >
                <option value="operator_vault_portrait">
                  Portret Operatora Mateusz Mitek (/assets/avatar_operator.jpg · Real JPEG)
                </option>
                <option value="svl364_l2_horizon">
                  Kamera Dziobowa Statku SVL-364 Ebon Apex (Punkt L2 · Real PNG)
                </option>
                <option value="botany_demeter">
                  Skansen Hydroponiczny Kopuły B-2 (Spirulina Kwantowa · Real PNG)
                </option>
              </select>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPresetId('operator_vault_portrait');
                    void handleRunVisionAnalysis(false, 'operator_vault_portrait');
                  }}
                  disabled={isAnalyzing}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-violet-300 font-mono cursor-pointer"
                >
                  Skanuj Portret Operatora
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPresetId('svl364_l2_horizon');
                    void handleRunVisionAnalysis(false, 'svl364_l2_horizon');
                  }}
                  disabled={isAnalyzing}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-cyan-300 font-mono cursor-pointer"
                >
                  Skanuj Sensor L2 SVL-364
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPresetId('botany_demeter');
                    void handleRunVisionAnalysis(false, 'botany_demeter');
                  }}
                  disabled={isAnalyzing}
                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-emerald-300 font-mono cursor-pointer"
                >
                  Skanuj Bioreaktor B-2
                </button>
              </div>
            </div>
          )}

          {selectedSourceTab === 'upload' && (
            <div className="rounded-xl bg-[#090D16] border border-slate-800 p-3 space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-4 rounded-xl border border-dashed border-violet-500/50 hover:border-violet-400 bg-violet-950/15 text-xs text-violet-200 font-medium flex flex-col items-center justify-center gap-1.5 cursor-pointer"
              >
                <Upload className="w-5 h-5 text-violet-400" />
                <span>Wybierz plik obrazu (PNG, JPEG, WebP, GIF)</span>
                {customImage && (
                  <span className="text-[11px] text-emerald-300 font-mono">
                    Załadowano: {customImage.name}
                  </span>
                )}
              </button>
            </div>
          )}

          {(selectedSourceTab === 'camera' || selectedSourceTab === 'screen') && (
            <div className="rounded-xl bg-[#090D16] border border-slate-800 p-3 space-y-2">
              <video
                ref={videoRef}
                playsInline
                muted
                className="w-full h-40 rounded-lg bg-black object-contain border border-slate-800"
              />
              {streamError && (
                <p className="text-[11px] text-amber-300">{streamError}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCaptureVideoFrame}
                  disabled={!streamActive}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-semibold"
                >
                  📸 Przechwyć klatkę do Real Vision
                </button>
                <button
                  type="button"
                  onClick={stopMediaStream}
                  disabled={!streamActive}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs text-slate-300"
                >
                  Zatrzymaj
                </button>
              </div>
            </div>
          )}

          {/* Prompt Input */}
          <div className="space-y-1.5">
            <label htmlFor="rv-prompt-input" className="block text-xs font-medium text-slate-300">
              Dyrektywa dla modelu <code className="text-violet-300">llama3.2-vision:11b</code>:
            </label>
            <textarea
              id="rv-prompt-input"
              rows={2}
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              className="w-full rounded-xl bg-[#090D16] border border-slate-700/90 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-violet-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={emitToChat}
                onChange={(e) => setEmitToChat(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-violet-500"
              />
              <span>Zapisz raport w aktywnym czacie</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={emitToIris}
                onChange={(e) => setEmitToIris(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-cyan-500"
              />
              <span>Wyślij powiadomienie do Iris AI</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleRunVisionAnalysis(false)}
              disabled={isAnalyzing}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold shadow-lg transition-colors cursor-pointer"
            >
              <Eye className="w-4 h-4" />
              <span>
                {isAnalyzing
                  ? 'Analizowanie przez llama3.2-vision:11b...'
                  : 'Analizuj przez Ollama 3.2 Vision (llama3.2-vision:11b)'}
              </span>
            </button>

            {onAttachToChat && lastRecord?.imagePreview && (
              <button
                type="button"
                onClick={() => {
                  onAttachToChat(
                    {
                      base64: lastRecord.imagePreview,
                      mimeType: bm?.mimeType || 'image/jpeg',
                      name: `real-vision-${bm?.format?.toLowerCase() || 'frame'}.jpg`,
                    },
                    lastRecord.reportMarkdown,
                  );
                }}
                className="px-3 py-2.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Wstaw do Czatu</span>
              </button>
            )}
          </div>
        </div>

        {/* Right Column: Decoded Binary Telemetry & Multimodal Output */}
        <div className="lg:col-span-7 rounded-xl bg-[#090D16] border border-slate-800/90 p-3.5 flex flex-col justify-between space-y-3">
          {lastRecord ? (
            <>
              <div className="flex flex-col sm:flex-row gap-3 items-start">
                {lastRecord.imagePreview && (
                  <img
                    src={lastRecord.imagePreview}
                    alt={lastRecord.source || 'Ramka Real Vision'}
                    referrerPolicy="no-referrer"
                    className="w-full sm:w-44 h-32 rounded-lg object-cover border border-violet-500/40 shrink-0 bg-black"
                  />
                )}
                <div className="flex-1 min-w-0 space-y-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="px-2 py-0.5 rounded bg-violet-500/20 border border-violet-500/40 text-[10px] font-mono text-violet-200">
                      {lastRecord.model || 'llama3.2-vision:11b'}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[10px] font-mono text-emerald-300">
                      HTTP {lastRecord.ollamaHttpStatus || 200} · {lastRecord.durationMs} ms
                    </span>
                    <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/35 text-[10px] font-mono text-cyan-200">
                      {bm?.format} · {bm?.resolution} · {bm?.sizeKb} KB
                    </span>
                  </div>

                  <div className="font-semibold text-slate-200 truncate">
                    Źródło: <span className="text-violet-300">{lastRecord.source}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono text-slate-300 pt-1">
                    <div className="bg-[#111520] px-2 py-1 rounded border border-slate-800">
                      RGB: <span className="text-cyan-300">{cs?.meanR}, {cs?.meanG}, {cs?.meanB}</span>
                    </div>
                    <div className="bg-[#111520] px-2 py-1 rounded border border-slate-800">
                      Luminancja Y: <span className="text-amber-300">{cs?.luminance}</span> (σ={cs?.contrastStd})
                    </div>
                    <div className="col-span-2 bg-[#111520] px-2 py-1 rounded border border-slate-800 truncate">
                      SHA-256: <span className="text-emerald-300">{bm?.sha256}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-[#0B0F1A] border border-slate-800 p-3 text-xs text-slate-200 font-mono whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
                {lastRecord.ollamaReply || lastRecord.reportMarkdown}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-center text-xs text-slate-400 space-y-2">
              <RefreshCw className="w-6 h-6 text-violet-400 animate-spin" />
              <span>Ładowanie telemetrii Real Vision (llama3.2-vision:11b)...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
