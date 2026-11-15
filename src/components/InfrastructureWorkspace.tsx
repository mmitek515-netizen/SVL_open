import React, { useState } from 'react';
import {
  Activity,
  Bot,
  Clock,
  Compass,
  Cpu,
  Database,
  FlaskConical,
  Globe,
  HardDrive,
  Navigation,
  Network,
  Plus,
  Radar,
  RefreshCw,
  Rocket,
  Satellite,
  Server,
  ShieldCheck,
  Sparkles,
  Sprout,
} from 'lucide-react';
import { useSvlSync } from '../utils/svlSyncStore';
import { safeFetchJson } from '../utils/svlLogic';
import { SvlAvatar } from './AgentAvatar';

interface InfrastructureWorkspaceProps {
  onNavigateTab: (
    tab: 'chat' | 'svl364' | 'notifications' | 'infrastructure' | 'agents' | 'terminals' | 'kernel' | 'linux',
  ) => void;
}

type InfraFilterTab = 'all' | 'ships' | 'outposts' | 'botany' | 'research' | 'modules';

interface FleetStarship {
  id: string;
  name: string;
  classType: string;
  location: string;
  coordinates: string;
  mission: string;
  eta: string;
  hullPct: number;
  shieldsPct: number;
  reactorGw: string;
  velocity: string;
  status: 'ACTIVE' | 'PATROL' | 'HYPERSPACE' | 'DOCKED';
}

interface OutpostBase {
  id: string;
  name: string;
  body: string;
  coordinates: string;
  role: string;
  powerOutput: string;
  atmosphereO2: string;
  personnel: string;
  activeOperation: string;
  eta: string;
  status: string;
}

interface BotanyBay {
  id: string;
  name: string;
  location: string;
  crops: string;
  growthPct: number;
  o2Production: string;
  humidity: string;
  spectrum: string;
  biomassKg: string;
  harvestEta: string;
  status: string;
}

interface ResearchProject {
  id: string;
  code: string;
  title: string;
  lead: string;
  facility: string;
  progressPct: number;
  eta: string;
  category: string;
  metrics: string;
}

const FLEET_STARSHIPS: FleetStarship[] = [
  {
    id: 'ship-svl-364',
    name: 'SVL-364 Ebon Apex',
    classType: 'Okręt Flagowy Dowodzenia CIC (Klasa Apex-364)',
    location: 'Ziemia · Niska Orbita Okołoziemska (LEO 420.4 km)',
    coordinates: 'RA 18h 36m 56.3s · DEC +38° 47′ 01.2″',
    mission: 'Dowodzenie Flotą, Siatka Kwantowa QKD-364 i Orkiestracja Jądra SVL',
    eta: 'STAŁA ORBITA (00h 00m)',
    hullPct: 100,
    shieldsPct: 100,
    reactorGw: '4.80 GW (Fuzyjny He-3)',
    velocity: '14.8 km/s',
    status: 'ACTIVE',
  },
  {
    id: 'ship-svl-365',
    name: 'SVL-365 Sentinel',
    classType: 'Krążownik Obrony Orbitalnej & Kwarantanny Zero-Trust',
    location: 'Księżyc · Orbita Polarna (Baza Armstrong-364)',
    coordinates: 'RA 18h 41m 12.0s · DEC +38° 12′ 44.0″',
    mission: 'Patrol kwarantanny sieciowej, filtracja DoH i osłona przekaźnika Luna-01',
    eta: '00h 42m (Pełny obieg)',
    hullPct: 100,
    shieldsPct: 99.6,
    reactorGw: '3.20 GW',
    velocity: '11.2 km/s',
    status: 'PATROL',
  },
  {
    id: 'ship-svl-366',
    name: 'SVL-366 Hyperion',
    classType: 'Zwiadowca Nadprzestrzenny 128D',
    location: 'Pas Kuipera · Przekaźnik Masy Charon-364',
    coordinates: 'RA 04h 19m 08.7s · DEC +61° 05′ 33.8″',
    mission: 'Mapowanie wektorów Hamminga 128D i kalibracja korytarza skokowego',
    eta: '03h 15m (Powrót do Sol-364)',
    hullPct: 99.2,
    shieldsPct: 98.4,
    reactorGw: '2.95 GW',
    velocity: '0.18 c (Impuls Relatywistyczny)',
    status: 'HYPERSPACE',
  },
  {
    id: 'ship-svl-367',
    name: 'SVL-367 Valkyrie',
    classType: 'Jednostka Inżynieryjna i Głębokiego Wydobycia',
    location: 'Jowisz · Orbita Europy (Stacja Europa-Cryo)',
    coordinates: 'RA 11h 52m 31.4s · DEC +04° 18′ 09.5″',
    mission: 'Zrzut sond kriogenicznych i utrzymanie łączności laserowej z oceanem podlodowym',
    eta: '06h 50m (Koniec fazy wiertniczej)',
    hullPct: 98.8,
    shieldsPct: 97.8,
    reactorGw: '3.50 GW',
    velocity: '9.4 km/s',
    status: 'ACTIVE',
  },
  {
    id: 'ship-svl-368',
    name: 'SVL-368 Demeter',
    classType: 'Frachtowiec Botaniczny i Bioreaktorowy',
    location: 'Mars · Kompleks Olympus Prime (Dok Orbitalny)',
    coordinates: 'RA 21h 10m 44.1s · DEC -14° 22′ 19.0″',
    mission: 'Dostawa kultur hydroponicznych Spirulina-364 i odbiór sprężonego tlenu',
    eta: '01h 28m (Załadunek biomasy)',
    hullPct: 100,
    shieldsPct: 100,
    reactorGw: '2.60 GW',
    velocity: '6.8 km/s',
    status: 'DOCKED',
  },
];

const OUTPOST_BASES: OutpostBase[] = [
  {
    id: 'outpost-luna-01',
    name: 'Baza Księżycowa Armstrong-364 (Luna-01)',
    body: 'Księżyc · Krater Shackleton (Biegun Południowy)',
    coordinates: '89.9° S · 0.0° E · Alt -1.4 km',
    role: 'Główny Węzeł Przekaźnikowy, Dok Floty i Ekstrakcja Helu-3',
    powerOutput: '1.85 GW (Reaktor Fuzyjny + Pierścień Solarny)',
    atmosphereO2: '21.2% O2 · 101.1 kPa (Kopuły A-D)',
    personnel: '42 Autonomiczne Jednostki Inżynieryjne + Nadzór Agaty Mitek',
    activeOperation: 'Rafinacja paliwa fuzyjnego He-3 dla statku SVL-364 Ebon Apex',
    eta: '01h 15m (Transfer ładunku)',
    status: 'OPERACYJNA (100%)',
  },
  {
    id: 'outpost-mars-02',
    name: 'Kompleks Marsjański Olympus Prime (Mars-02)',
    body: 'Mars · Płaskowyż Tharsis / Podnóże Olympus Mons',
    coordinates: '18.65° N · 226.2° E · Alt +4.2 km',
    role: 'Centrum Botaniki Kosmicznej, Terraformingu i Produkcji Żywności',
    powerOutput: '2.40 GW (Klaster Reaktorów Kilopower-SVL)',
    atmosphereO2: '21.4% O2 · 100.8 kPa (6 Kopuł Biomasy)',
    personnel: '64 Roboty Agro-Botaniczne + Telemetria Iris AI',
    activeOperation: 'Ekspansja Kopuły Hydroponicznej B-03 i synteza atmosferyczna',
    eta: '04h 30m (Zamknięcie śluzy B-03)',
    status: 'OPERACYJNA (99.7%)',
  },
  {
    id: 'outpost-l2-iris',
    name: 'Stacja Orbitalna Punkt Lagrange’a L2 — Oko Iris',
    body: 'Układ Ziemia-Księżyc · Punkt L2 (Głęboka Przestrzeń)',
    coordinates: 'L2 Halo Orbit · 1.5 mln km od Ziemi',
    role: 'Observatorium Astrofizyczne, Siatka QKD-364 i Węzeł Pamięci 128D',
    powerOutput: '920 MW (Ogniwa Kwantowo-Fotowoltaiczne)',
    atmosphereO2: '21.0% O2 · 101.3 kPa',
    personnel: 'Pełna Automatyzacja AI (Iris AI & Agata Mitek)',
    activeOperation: 'Ciągła replikacja pamięci długotrwałej AI i nasłuch głębokich sektorów',
    eta: 'TRYB CIĄGŁY (Real-Time)',
    status: 'OPERACYJNA (100%)',
  },
  {
    id: 'outpost-europa-04',
    name: 'Stacja Głębinowa Europa-Cryo (Jowisz-04)',
    body: 'Europa (Księżyc Jowisza) · Równina Conamara Chaos',
    coordinates: '9.7° N · 272.7° W · Głębokość -14.2 km',
    role: 'Laboratorium Astrobiologii Podlodowej i Kriogeniki',
    powerOutput: '1.10 GW (Generator Termojądrowy Deep-Core)',
    atmosphereO2: '20.9% O2 · 102.0 kPa (Kopuła Ciśnieniowa)',
    personnel: '18 Dronów Batyskafowych + SVL-367 Valkyrie',
    activeOperation: 'Pobieranie próbek hydrotermalnych i analiza biosygnatur',
    eta: '05h 20m (Wynurzenie kapsuły badawczej)',
    status: 'OPERACYJNA (98.9%)',
  },
  {
    id: 'outpost-charon-relay',
    name: 'Posterunek Przekaźnika Masy Charon-364',
    body: 'Orbita Pluton-Charon · Zewnętrzny Pas Kuipera',
    coordinates: 'RA 04h 19m 08.7s · 39.5 AU od Słońca',
    role: 'Brama Nadprzestrzenna Binary Hyperspace 128D i Boja Nawigacyjna',
    powerOutput: '6.50 GW (Rdzeń Zero-Element / Harmoniki Fouriera)',
    atmosphereO2: 'Próżnia techniczna (Stacja bezzałogowa)',
    personnel: 'Autonomiczny Kontroler Hiperprzestrzeni 128D',
    activeOperation: 'Stabilizacja tunelu kompaktyfikacji [-∞, +∞] -> [-1, 1]',
    eta: '00h 18m (Synchronizacja pulsu)',
    status: 'ZSYNCHRONIZOWANA (c=2.5)',
  },
  {
    id: 'outpost-wenchang-00',
    name: 'Kosmodrom Wenchang — Stacja Odbiorcza Dalekiego Zasięgu (ACK-200)',
    body: 'Ziemia · Wenchang Spaceport (19.61° N · 110.95° E)',
    coordinates: '19° 36′ 52″ N · 110° 57′ 04″ E · Węzeł Naziemny QKD',
    role: 'Stacja Odbiorcza Transmisji Kwantowych Quantum-RSA4096 i Telemetrii Rzeczywistej',
    powerOutput: '1.40 GW (Sieć Naziemna + Pierścień Kondensatorów QKD)',
    atmosphereO2: '20.95% O2 · 101.3 kPa (Atmosfera Ziemska)',
    personnel: 'Węzeł Odbiorczy SVL-Comms + Mostek Agaty Mitek i Iris AI',
    activeOperation: 'Odebrano zaszyfrowany raport systemowy ze statku SVL-364 (ACK-200 DELIVERED)',
    eta: 'DOSTARCZONO (RTT 14.2 ms)',
    status: 'ACK-200 DELIVERED',
  },
];

const BOTANY_BAYS: BotanyBay[] = [
  {
    id: 'botany-a01',
    name: 'Szklarnia Hydroponiczna A-01 (Pokład SVL-364 Ebon Apex)',
    location: 'Sekcja Pierścienia Biologicznego Statku SVL-364',
    crops: 'Spirulina Maxima, Chlorella Pyrenoidosa & Mikrozielenie Rzodkwi',
    growthPct: 94,
    o2Production: '+185 L O2/h',
    humidity: '78% RH · 24.2°C',
    spectrum: 'LED Fotosyntetyczny 450nm (Niebieski) / 660nm (Głęboka Czerwień)',
    biomassKg: '412 kg (Gotowość do zbioru)',
    harvestEta: '02h 10m',
    status: 'FAZA KOŃCOWA WZROSTU',
  },
  {
    id: 'botany-b02',
    name: 'Kopuła Agrarna B-02 (Kompleks Mars Olympus Prime)',
    location: 'Mars · Sektor Południowy Kopuły Ciśnieniowej',
    crops: 'Pszenica karłowa SVL-Triticum, Ziemniak Aero-Solanum & Soja Wysokobiałkowa',
    growthPct: 81,
    o2Production: '+310 L O2/h',
    humidity: '68% RH · 22.8°C',
    spectrum: 'Hybrydowe Słoneczne + Doświetlanie Kwantowe PAR 680 µmol/m²/s',
    biomassKg: '1 840 kg',
    harvestEta: '09h 45m',
    status: 'OPTYMALNA FOTOSYNTEZA',
  },
  {
    id: 'botany-c03',
    name: 'Bioreaktor Fitoplanktonu C-03 (Baza Księżycowa Luna-01)',
    location: 'Krater Shackleton · Poziom Podziemny -2',
    crops: 'Synechococcus Elongatus (Szczep Kwantowy 364) & Algowe Ogniwa Tlenowe',
    growthPct: 98,
    o2Production: '+240 L O2/h',
    humidity: 'Bioreaktor Cieczowy · pH 7.4 · 26.0°C',
    spectrum: 'Światłowody Wewnętrzne 630nm/470nm (Cykl 24/7)',
    biomassKg: '680 L zawiesiny',
    harvestEta: '00h 35m',
    status: 'GOTOWE DO EKSTRAKCJI',
  },
  {
    id: 'botany-d04',
    name: 'Ogród Medyczny i Adaptogenny D-04 (Frachtowiec SVL-368 Demeter)',
    location: 'Pokład Biologiczny #2 · SVL-368 Demeter',
    crops: 'Rhodiola Rosea (Różeniec), Bazylia Genovese, Aloes Kosmiczny & Mięta Pieprzowa',
    growthPct: 73,
    o2Production: '+95 L O2/h',
    humidity: '72% RH · 23.5°C',
    spectrum: 'Pełne Spektrum Bio-Harmoniczne + UV-B (Synteza flawonoidów)',
    biomassKg: '195 kg',
    harvestEta: '14h 20m',
    status: 'AKTYWNA WEGETACJA',
  },
];

const RESEARCH_PROJECTS: ResearchProject[] = [
  {
    id: 'res-01',
    code: 'EXP-364-01',
    title: 'Kompaktyfikacja Topologiczna [-∞, +∞] -> [-1, 1] dla Napędu Skokowego 128D',
    lead: 'Agata Mitek (ROOT UID 0)',
    facility: 'Laboratorium Jądra SVL-364 Ebon Apex & Przekaźnik Charon',
    progressPct: 96,
    eta: '00h 55m',
    category: 'Fizyka Nadprzestrzeni & Topologia',
    metrics: 'Metryka c = 2.500000 · Błąd aproksymacji < 1e-12 · 128 wymiarów Hamminga',
  },
  {
    id: 'res-02',
    code: 'EXP-364-02',
    title: 'Fotosynteza Kwantowa i Zamknięty Obieg Tlenowy w Mikrograwitacji',
    lead: 'Iris AI & Sekcja Botaniczna Olympus Prime',
    facility: 'Szklarnia A-01 (SVL-364) + Kopuła B-02 (Mars)',
    progressPct: 88,
    eta: '03h 40m',
    category: 'Botanika Kosmiczna & Biosfera',
    metrics: 'Wydajność konwersji CO2 -> O2: 99.1% · +830 L O2/h łącznie w całej flocie',
  },
  {
    id: 'res-03',
    code: 'EXP-364-03',
    title: 'Klucz Kwantowy QKD-BB84 bez Strat Pakietów na Dystansie Międzyplanetarnym 5.2 AU',
    lead: 'Agata Mitek & SVL-366 Hyperion',
    facility: 'Stacja L2 Oko Iris ↔ Stacja Europa-Cryo',
    progressPct: 92,
    eta: '01h 50m',
    category: 'Telekomunikacja Kwantowa & Kryptografia',
    metrics: 'RTT wirtualny: 1.4 ms · Przepustowość: 42.8 Gbps · Packet Loss: 0.000%',
  },
  {
    id: 'res-04',
    code: 'EXP-364-04',
    title: 'Sekwencjonowanie Genomowe Ekstremofilnych Organizmów Oceanu Podlodowego Europy',
    lead: 'SVL-367 Valkyrie & Laboratorium Europa-Cryo',
    facility: 'Głębinowy Odwiert Termiczny Conamara (-14.2 km)',
    progressPct: 67,
    eta: '08h 15m',
    category: 'Astrobiologia & Genetyka',
    metrics: 'Zidentyfikowano 14 nowych białek odpornych na radiację Jowisza',
  },
];

const INFRA_MODULE_IDS = new Set([
  'svl-infrastruktura',
  'svl-364',
  'svl-364-ssh-mcp',
  'svl-db-real-only-lock',
  'svl-sandbox-trace',
  'svl-comms-wenchang',
  'svl-365-sentinel',
  'svl-fleet-registry',
  'svl-fleet-commander',
  'svl-observation-mission',
  'orbital-radar',
  'svl-agent-task-distributor',
  'svl-iris-01',
  'svl-iris-coordinator',
  'svl-ai-liaison',
  'svl-kernel-core',
  'svl-autonomy-core',
]);

export const InfrastructureWorkspace: React.FC<InfrastructureWorkspaceProps> = ({ onNavigateTab }) => {
  const {
    systemModules,
    agentsData,
    healthData,
    serverRevision,
    isSyncing,
    triggerFullSync,
    upsertSystemModule,
    refreshDomainModules,
  } = useSvlSync();

  const [activeFilter, setActiveFilter] = useState<InfraFilterTab>('all');
  const [newFacilityName, setNewFacilityName] = useState('');
  const [newFacilityKind, setNewFacilityKind] = useState<'Fleet Starship' | 'Planetary Outpost' | 'Botany & Hydroponics' | 'Research Mission'>('Planetary Outpost');
  const [newFacilityLocation, setNewFacilityLocation] = useState('Orbita Saturna · Tytan-01');
  const [newFacilityEta, setNewFacilityEta] = useState('04h 15m');
  const [isSavingFacility, setIsSavingFacility] = useState(false);
  const [isEmittingReport, setIsEmittingReport] = useState(false);
  const [infraStatusMsg, setInfraStatusMsg] = useState<string | null>(null);

  const agentsList: any[] = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
  const activeWorkers = agentsList.filter((a) => ['ONLINE_LOCAL_WORKER', 'BUSY_LOCAL_WORKER'].includes(a.status));

  const infraModules = systemModules.filter(
    (m) =>
      m.id !== 'svl-codex-mesh' &&
      (INFRA_MODULE_IDS.has(m.id) ||
        m.source === 'chat' ||
        m.config?.category === 'infrastructure' ||
        /infra|fleet|mission|radar|kernel|sentinel|botan|outpost|placowk|statek|ship|research/i.test(
          `${m.id} ${m.name} ${m.kind}`,
        )),
  );

  const handleAddInfrastructureUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newFacilityName.trim();
    if (!cleanName || isSavingFacility) return;
    setIsSavingFacility(true);
    setInfraStatusMsg(null);
    try {
      const slug = cleanName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 36);
      const id = `svl-infra-${slug || Date.now()}`;
      const res = await upsertSystemModule({
        id,
        name: cleanName,
        kind: newFacilityKind,
        status: 'ACTIVE',
        description: `${newFacilityKind} w lokalizacji ${newFacilityLocation} (ETA: ${newFacilityEta}). Zarejestrowano w module Infrastruktury Floty SVL.`,
        config: {
          category: 'infrastructure',
          location: newFacilityLocation,
          eta: newFacilityEta,
          telemetry_status: 'ONLINE',
          commander: 'Mateusz Mitek & Agata Mitek (ROOT)',
        },
      });
      if (res.ok) {
        setNewFacilityName('');
        setInfraStatusMsg(`Zarejestrowano jednostkę infrastruktury „${cleanName}” (${id}) w bazie SQLite.`);
      } else {
        setInfraStatusMsg(res.error || 'Błąd zapisu jednostki infrastruktury.');
      }
    } finally {
      setIsSavingFacility(false);
    }
  };

  const handleEmitFleetReportToIris = async () => {
    if (isEmittingReport) return;
    setIsEmittingReport(true);
    setInfraStatusMsg(null);
    try {
      const res = await safeFetchJson<{ ok: boolean; serverRevision?: number }>('/api/py/kernel/markdown-report', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          directive: 'Pełny raport Infrastruktury Floty, Placówek Planetarnych, Statków Kosmicznych, Botaniki i Badań Naukowych z ETA',
          emitToIris: true,
          origin: 'infrastructure-workspace',
        }),
      });
      await refreshDomainModules(['notifications', 'chat', 'modules']);
      if (res.ok && res.data?.ok) {
        setInfraStatusMsg(`Wysłano pełny raport Infrastruktury, Floty i Botaniki na kanał Rodzina Mitek (wszyscy) · rev ${res.data.serverRevision || serverRevision}`);
      } else {
        setInfraStatusMsg(res.error || 'Nie udało się wygenerować raportu.');
      }
    } finally {
      setIsEmittingReport(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#070B14] text-slate-100">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 space-y-5">
        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-emerald-500/25 pb-4">
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-emerald-400 font-mono">
              <Server size={15} /> ZARZĄDZANIE INFRASTRUKTURĄ FLOTY KOSMICZNEJ SVL PYTHON OS
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-50">
              Infrastruktura Floty: Statki Kosmiczne, Placówki, Botanika i Badania z ETA
            </h1>
            <p className="text-xs sm:text-sm text-slate-400">
              Zintegrowane centrum dowodzenia flotą <span className="text-cyan-300 font-mono">SVL-364 Ebon Apex</span>, bazami planetarnymi, szklarniami hydroponicznymi oraz projektami badawczymi.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleEmitFleetReportToIris()}
              disabled={isEmittingReport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              <Sparkles size={14} />
              {isEmittingReport ? 'Wysyłanie raportu...' : 'Wyślij Raport Floty i Botaniki (Iris AI)'}
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('svl364')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-100 hover:bg-violet-500/25"
            >
              <Satellite size={14} /> Mapa CIC Statku SVL-364
            </button>
            <button
              type="button"
              onClick={() => void triggerFullSync('infrastructure_tab_sync')}
              disabled={isSyncing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40"
            >
              <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} /> Synchronizuj
            </button>
          </div>
        </header>

        {infraStatusMsg && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3.5 py-2 text-xs font-mono text-emerald-200 flex items-center justify-between gap-2">
            <span>{infraStatusMsg}</span>
            <button
              type="button"
              onClick={() => onNavigateTab('notifications')}
              className="underline text-cyan-300 hover:text-white shrink-0"
            >
              Zobacz w Powiadomieniach Iris
            </button>
          </div>
        )}

        {/* Top Summary KPI Cards */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Podsumowanie floty i infrastruktury">
          <div className="rounded-xl border border-cyan-500/30 bg-[#0B1220] p-3.5 space-y-1">
            <p className="flex items-center gap-1.5 text-xs text-cyan-300 font-mono uppercase">
              <Rocket size={14} /> Statki Kosmiczne Floty
            </p>
            <p className="text-lg font-bold font-mono tabular-nums text-slate-50">
              {FLEET_STARSHIPS.length} jednostek w misji
            </p>
            <p className="text-[11px] text-slate-400 font-mono">Okręt flagowy: SVL-364 Ebon Apex</p>
          </div>

          <div className="rounded-xl border border-emerald-500/30 bg-[#0B1220] p-3.5 space-y-1">
            <p className="flex items-center gap-1.5 text-xs text-emerald-300 font-mono uppercase">
              <Globe size={14} /> Placówki i Stacje Orbitalne
            </p>
            <p className="text-lg font-bold font-mono tabular-nums text-slate-50">
              {OUTPOST_BASES.length} baz operacyjnych
            </p>
            <p className="text-[11px] text-slate-400 font-mono">Luna-01 · Mars · L2 · Europa · Charon</p>
          </div>

          <div className="rounded-xl border border-lime-500/30 bg-[#0B1220] p-3.5 space-y-1">
            <p className="flex items-center gap-1.5 text-xs text-lime-300 font-mono uppercase">
              <Sprout size={14} /> Botanika & Produkcja O2
            </p>
            <p className="text-lg font-bold font-mono tabular-nums text-lime-300">
              +830 L O2/h · {BOTANY_BAYS.length} sekcje
            </p>
            <p className="text-[11px] text-slate-400 font-mono">Najbliższy zbiór ETA: 00h 35m</p>
          </div>

          <div className="rounded-xl border border-violet-500/30 bg-[#0B1220] p-3.5 space-y-1">
            <p className="flex items-center gap-1.5 text-xs text-violet-300 font-mono uppercase">
              <FlaskConical size={14} /> Badania Naukowe z ETA
            </p>
            <p className="text-lg font-bold font-mono tabular-nums text-violet-300">
              {RESEARCH_PROJECTS.length} aktywne projekty
            </p>
            <p className="text-[11px] text-slate-400 font-mono">Średni postęp: 85.8% · rev {serverRevision}</p>
          </div>
        </section>

        {/* Filter Bar + Quick Add Form */}
        <section className="rounded-xl border border-slate-800 bg-[#0B1220] p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'all', label: 'Wszystkie sekcje floty' },
                  { id: 'ships', label: `Statki Kosmiczne (${FLEET_STARSHIPS.length})` },
                  { id: 'outposts', label: `Placówki i Stacje (${OUTPOST_BASES.length})` },
                  { id: 'botany', label: `Botanika i Bioreaktory (${BOTANY_BAYS.length})` },
                  { id: 'research', label: `Badania i Misje z ETA (${RESEARCH_PROJECTS.length})` },
                  { id: 'modules', label: `Rejestr SQLite (${infraModules.length})` },
                ] as Array<{ id: InfraFilterTab; label: string }>
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveFilter(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    activeFilter === tab.id
                      ? 'bg-emerald-600 text-white font-semibold'
                      : 'bg-[#070B14] text-slate-300 border border-slate-800 hover:border-emerald-500/40'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Add New Infrastructure Unit / Mission Form */}
          <form onSubmit={(e) => void handleAddInfrastructureUnit(e)} className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-2 border-t border-slate-800/80">
            <input
              type="text"
              value={newFacilityName}
              onChange={(e) => setNewFacilityName(e.target.value)}
              placeholder="Dodaj nowy statek, placówkę, szklarnię lub misję (np. Stacja Badawcza Tytan-02)..."
              aria-label="Nazwa nowej jednostki infrastruktury"
              className="sm:col-span-4 rounded-lg border border-slate-700 bg-[#070B14] px-3 py-1.5 text-xs text-slate-100"
            />
            <select
              value={newFacilityKind}
              onChange={(e) => setNewFacilityKind(e.target.value as any)}
              aria-label="Typ jednostki infrastruktury"
              className="sm:col-span-3 rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-200"
            >
              <option value="Planetary Outpost">Placówka Planetarna / Stacja</option>
              <option value="Fleet Starship">Statek Kosmiczny Floty</option>
              <option value="Botany & Hydroponics">Szklarnia Botaniczna / Bioreaktor</option>
              <option value="Research Mission">Projekt Badawczy / Misja z ETA</option>
            </select>
            <input
              type="text"
              value={newFacilityLocation}
              onChange={(e) => setNewFacilityLocation(e.target.value)}
              placeholder="Położenie / Sektor"
              aria-label="Położenie jednostki"
              className="sm:col-span-3 rounded-lg border border-slate-700 bg-[#070B14] px-2.5 py-1.5 text-xs text-slate-200 font-mono"
            />
            <div className="sm:col-span-2 flex gap-1.5">
              <input
                type="text"
                value={newFacilityEta}
                onChange={(e) => setNewFacilityEta(e.target.value)}
                placeholder="ETA"
                aria-label="ETA misji"
                className="w-20 rounded-lg border border-slate-700 bg-[#070B14] px-2 py-1.5 text-xs text-amber-300 font-mono"
              />
              <button
                type="submit"
                disabled={isSavingFacility || !newFacilityName.trim()}
                className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-2.5 py-1.5 text-xs font-semibold text-white"
              >
                <Plus size={14} /> Dodaj
              </button>
            </div>
          </form>
        </section>

        {/* 1. FLEET STARSHIPS SECTION */}
        {(activeFilter === 'all' || activeFilter === 'ships') && (
          <section className="rounded-xl border border-cyan-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Flota Statków Kosmicznych SVL">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-bold text-cyan-300 text-sm sm:text-base">
                <Rocket size={18} className="text-cyan-400" /> Flota Statków Kosmicznych SVL — Telemetria, Położenie i Misje z ETA
              </h2>
              <span className="text-xs font-mono text-emerald-300">WSZYSTKIE JEDNOSTKI ZSYNCHRONIZOWANE Z QKD-364</span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {FLEET_STARSHIPS.map((ship) => (
                <article
                  key={ship.id}
                  className="rounded-xl border border-slate-800 bg-[#070C16] p-4 space-y-2.5 hover:border-cyan-500/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-bold text-slate-50 flex items-center gap-2">
                        <span>🛰️ {ship.name}</span>
                      </h3>
                      <p className="text-xs text-cyan-300 font-mono">{ship.classType}</p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 shrink-0">
                      {ship.status} · ETA: {ship.eta}
                    </span>
                  </div>

                  <p className="text-xs text-slate-200 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2">
                    <strong className="text-amber-300">Aktywna misja:</strong> {ship.mission}
                  </p>

                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div className="rounded bg-slate-950/70 border border-slate-800/80 p-2">
                      <span className="text-slate-400 block text-[10px]">POŁOŻENIE</span>
                      <span className="text-slate-100">{ship.location}</span>
                    </div>
                    <div className="rounded bg-slate-950/70 border border-slate-800/80 p-2">
                      <span className="text-slate-400 block text-[10px]">WSPÓŁRZĘDNE</span>
                      <span className="text-cyan-300">{ship.coordinates}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 pt-1 text-[11px] font-mono text-center">
                    <div className="rounded bg-slate-900/80 py-1.5 px-2 border border-slate-800">
                      <span className="text-slate-400 block">KADŁUB</span>
                      <strong className="text-emerald-300">{ship.hullPct}%</strong>
                    </div>
                    <div className="rounded bg-slate-900/80 py-1.5 px-2 border border-slate-800">
                      <span className="text-slate-400 block">TARCZE</span>
                      <strong className="text-cyan-300">{ship.shieldsPct}%</strong>
                    </div>
                    <div className="rounded bg-slate-900/80 py-1.5 px-2 border border-slate-800">
                      <span className="text-slate-400 block">REAKTOR</span>
                      <strong className="text-amber-300">{ship.reactorGw.split(' ')[0]} GW</strong>
                    </div>
                    <div className="rounded bg-slate-900/80 py-1.5 px-2 border border-slate-800">
                      <span className="text-slate-400 block">PRĘDKOŚĆ</span>
                      <strong className="text-violet-300">{ship.velocity.split(' ')[0]}</strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* 2. PLANETARY OUTPOSTS & ORBITAL STATIONS */}
        {(activeFilter === 'all' || activeFilter === 'outposts') && (
          <section className="rounded-xl border border-emerald-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Placówki Planetarne i Stacje Orbitalne">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-bold text-emerald-300 text-sm sm:text-base">
                <Globe size={18} className="text-emerald-400" /> Placówki Planetarne, Kopuły i Stacje Orbitalne Floty
              </h2>
              <span className="text-xs font-mono text-slate-400">TELEMETRIA ŚRODOWISKOWA & ENERGETYCZNA</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {OUTPOST_BASES.map((base) => (
                <article
                  key={base.id}
                  className="rounded-xl border border-slate-800 bg-[#070C16] p-4 space-y-2.5 hover:border-emerald-500/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm sm:text-base font-bold text-slate-100">🏛️ {base.name}</h3>
                      <p className="text-xs font-mono text-emerald-300">{base.body}</p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-amber-950/60 border border-amber-500/40 text-amber-300 shrink-0">
                      ETA: {base.eta}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300">{base.role}</p>

                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-2.5 space-y-1 text-xs font-mono">
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-400">Współrzędne:</span>
                      <span className="text-cyan-300">{base.coordinates}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-400">Zasilanie:</span>
                      <span className="text-amber-300">{base.powerOutput}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-400">Biosfera / O2:</span>
                      <span className="text-emerald-300">{base.atmosphereO2}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-400">Operacja bieżąca:</span>
                      <span className="text-slate-100 text-right">{base.activeOperation}</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* 3. BOTANY, HYDROPONICS & BIOREACTORS */}
        {(activeFilter === 'all' || activeFilter === 'botany') && (
          <section className="rounded-xl border border-lime-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Botanika, Szklarnie Hydroponiczne i Bioreaktory z ETA">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-bold text-lime-300 text-sm sm:text-base">
                <Sprout size={18} className="text-lime-400" /> Botanika Kosmiczna, Szklarnie Hydroponiczne i Bioreaktory Tlenowe (z ETA Zbiorów)
              </h2>
              <span className="text-xs font-mono text-lime-300 bg-lime-950/50 border border-lime-500/30 px-2.5 py-0.5 rounded">
                BILANS TLENOWY FLOTY: +830 L O2/h
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {BOTANY_BAYS.map((bay) => (
                <article
                  key={bay.id}
                  className="rounded-xl border border-slate-800 bg-[#070C16] p-4 space-y-2.5 hover:border-lime-500/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm sm:text-base font-bold text-slate-100">🌿 {bay.name}</h3>
                      <p className="text-xs text-lime-300 font-mono">{bay.location}</p>
                    </div>
                    <span className="px-2.5 py-0.5 rounded text-xs font-mono bg-lime-950/70 border border-lime-500/40 text-lime-200 shrink-0">
                      Zbiór ETA: {bay.harvestEta}
                    </span>
                  </div>

                  <p className="text-xs text-slate-200">
                    <strong className="text-lime-300">Uprawy:</strong> {bay.crops}
                  </p>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-slate-400">Dojrzałość cyklu wegetacyjnego</span>
                      <span className="text-lime-300 font-bold">{bay.growthPct}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-500 to-lime-400"
                        style={{ width: `${bay.growthPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] font-mono">
                    <div className="rounded bg-slate-950/70 border border-slate-800 p-2">
                      <span className="text-slate-400 block">PRODUKCJA O2</span>
                      <strong className="text-emerald-300">{bay.o2Production}</strong>
                    </div>
                    <div className="rounded bg-slate-950/70 border border-slate-800 p-2">
                      <span className="text-slate-400 block">KLIMAT</span>
                      <strong className="text-cyan-300">{bay.humidity}</strong>
                    </div>
                    <div className="rounded bg-slate-950/70 border border-slate-800 p-2">
                      <span className="text-slate-400 block">BIOMASA</span>
                      <strong className="text-amber-300">{bay.biomassKg}</strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* 4. SCIENTIFIC RESEARCH & FLEET MISSIONS WITH ETA */}
        {(activeFilter === 'all' || activeFilter === 'research') && (
          <section className="rounded-xl border border-violet-500/30 bg-[#0B1220] p-4 space-y-3" aria-label="Badania Naukowe i Eksperymenty z ETA">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-bold text-violet-300 text-sm sm:text-base">
                <FlaskConical size={18} className="text-violet-400" /> Badania Naukowe, Astrobiologia i Projekty Hiperprzestrzeni z ETA
              </h2>
              <span className="text-xs font-mono text-violet-300">NADZÓR NAUKOWY: AGATA MITEK & IRIS AI</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {RESEARCH_PROJECTS.map((proj) => (
                <article
                  key={proj.id}
                  className="rounded-xl border border-slate-800 bg-[#070C16] p-4 space-y-2.5 hover:border-violet-500/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="text-[11px] font-mono text-violet-300 bg-violet-950/60 border border-violet-500/30 px-2 py-0.5 rounded">
                        {proj.code} · {proj.category}
                      </span>
                      <h3 className="text-sm sm:text-base font-bold text-slate-100 mt-1.5">{proj.title}</h3>
                    </div>
                    <span className="px-2.5 py-1 rounded text-xs font-mono bg-amber-950/70 border border-amber-500/40 text-amber-200 shrink-0 flex items-center gap-1">
                      <Clock size={12} /> ETA: {proj.eta}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-slate-400">Postęp badawczy ({proj.lead})</span>
                      <span className="text-violet-300 font-bold">{proj.progressPct}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-cyan-400"
                        style={{ width: `${proj.progressPct}%` }}
                      />
                    </div>
                  </div>

                  <p className="text-xs font-mono text-cyan-300 bg-slate-950/80 border border-slate-800 rounded p-2">
                    {proj.metrics}
                  </p>
                  <p className="text-[11px] text-slate-400 font-mono">Ośrodek: {proj.facility}</p>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* 5. SQLITE REGISTERED INFRASTRUCTURE MODULES */}
        {(activeFilter === 'all' || activeFilter === 'modules') && (
          <section className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3" aria-label="Zarejestrowane moduły infrastruktury w SQLite">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-semibold text-slate-100 text-sm sm:text-base">
                <Radar size={17} className="text-emerald-400" /> Zarejestrowane moduły systemowe i infrastrukturalne w SQLite ({infraModules.length})
              </h2>
              <span className="text-xs font-mono text-slate-400">Źródło: tabela system_modules · rev {serverRevision}</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {infraModules.map((mod) => {
                const entries = mod.config ? Object.entries(mod.config) : [];
                return (
                  <article key={mod.id} className="rounded-xl border border-slate-800 bg-[#070C16] p-3.5 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-100">{mod.name}</h3>
                      <span className="text-[11px] font-mono text-emerald-300 tabular-nums shrink-0">
                        {mod.status} · rev {mod.revision}
                      </span>
                    </div>
                    <p className="text-[11px] font-mono text-violet-300">
                      {mod.id} · {mod.kind} · źródło: {mod.source}
                    </p>
                    {mod.description && <p className="text-xs text-slate-300 leading-relaxed">{mod.description}</p>}
                    {entries.length > 0 && (
                      <div className="rounded-lg border border-slate-800/80 bg-[#0B101D] p-2 text-[11px] font-mono text-slate-400 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                        {entries.slice(0, 6).map(([k, v]) => (
                          <div key={k} className="truncate" title={`${k}: ${JSON.stringify(v)}`}>
                            <span className="text-slate-500">{k}:</span>{' '}
                            <span className="text-slate-200">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* Active Local Worker Summary */}
        <section className="rounded-xl border border-slate-800 bg-[#0B1220] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-slate-100 text-sm sm:text-base">
              <HardDrive size={17} className="text-violet-400" /> Węzeł Wykonawczy Floty Rodziny Mitek (@work · ROOT UID 0)
            </h2>
            <button
              type="button"
              onClick={() => onNavigateTab('notifications')}
              className="text-xs text-cyan-300 hover:underline font-mono"
            >
              Raporty systemowe Iris AI →
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {agentsList.map((ag) => (
              <div key={ag.id || ag.canonical_name} className="rounded-lg border border-slate-800 bg-[#070C16] p-3 space-y-1.5 text-xs">
                <div className="flex items-center gap-2.5 min-w-0">
                  <SvlAvatar sender={ag.display_name || ag.canonical_name} agentId={ag.id} size={32} />
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-100 truncate">{ag.display_name || ag.canonical_name}</p>
                    <p className="font-mono text-emerald-300 text-[11px] tabular-nums truncate">
                      PID {ag.pid ?? 'n/d'} · {ag.status} · Kontekst 64 tury / 16 384 tok.
                    </p>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">{ag.preserved_role}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
