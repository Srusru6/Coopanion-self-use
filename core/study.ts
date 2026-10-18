/**
 * The `study` World: at irregular intervals it reads the foreground window and decides whether the
 * person is studying or slacking off, urges them back when they drift, and counts focus time — both
 * automatically (the foreground hits the study-app list) and by hand (start/stop in the settings
 * window).
 *
 * Four outputs:
 * - a `study.started` / `study.ended` / `study.distracted` event for Coo, so it decides when to speak;
 * - an ambient chip on the pet showing the live focus clock;
 * - a sticky `study` card on the pet when the person stays on a distractor app;
 * - a `focus` panel whose `state`, `history`, `start` and `stop` methods drive the settings window.
 *
 * Only the foreground window's title and process name are read, matched locally; nothing leaves the
 * machine, and no screenshot or window list is taken.
 */
import { join } from 'node:path';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import type { AmbientStatus } from 'cortico-world-desktop-pet';
import {
  FocusLedger, appLabel, classify, normalize, studyDefaults,
  type FocusSession, type FocusStats, type ForegroundInfo, type StatsPeriod, type StudyConfig,
} from './study-sessions.ts';
import { coreText } from './i18n/index.ts';
import { appLanguage, modelLanguage, type ModelLanguage } from './language.ts';

export const STUDY_ID = 'study';
const TICK_MS = 1000;

export interface StudyAssembly {
  /** A value of the live config by dotted path; `language` gives the app language. */
  read: (path: string) => unknown;
  /** The foreground window, read by the pet's own engine; no screenshot, no input. */
  foreground: () => Promise<ForegroundInfo | null>;
  /** Puts the focus clock on the pet's chip. */
  ambient: (status: AmbientStatus) => void;
  /** A sticky card on the pet for a distraction the person must notice. */
  alert: (id: number, kind: 'study', text: string) => void;
  /** Removes the sticky card. */
  alertClear: (id: number) => void;
  /** Its name when Core assembles the Worlds, in the app language of that moment. */
  label: () => string;
  onCreate?: (world: StudyWorld) => void;
}

/** A focus stretch that is still open. */
interface ActiveFocus { start: number; kind: 'auto' | 'manual' }

/** Coo starts a manual stretch when the person says they are studying. */
export const STUDY_TOOL_START: Omit<ToolDef, 'handler'> = {
  name: 'study_start',
  tags: ['write'],
  description: 'Start a focus stretch by hand: focus time is counted from now until study_stop, whichever app is in front. Use it when the person says they are starting to study or asks to be supervised.',
  parameters: { type: 'object', properties: {} },
};

/** Coo ends the stretch in progress, an automatic one included: the person saying it is over is the correction. */
export const STUDY_TOOL_STOP: Omit<ToolDef, 'handler'> = {
  name: 'study_stop',
  tags: ['write'],
  description: "End the focus stretch in progress, automatic or started by hand. Use it when the person says they stopped studying or that the counted time was not study time.",
  parameters: { type: 'object', properties: {} },
};

const zh = {
  started: '[学习监督] 你开始学习了,我来帮你记专注时间。',
  ended: (minutes: number) => `[学习监督] 你这段专注结束了,约 ${minutes} 分钟。`,
  distracted: (app: string) => `[学习监督] 你在用 ${app} 摸鱼,回来学习吧。`,
  toolStarted: '手动专注已开始,我把这段时间记下来。',
  toolStopped: (minutes: number) => `专注结束,这段约 ${minutes} 分钟。`,
  toolIdle: '现在没有正在进行的专注。',
};

const en: typeof zh = {
  started: "[study] You're studying now — I'll count your focus time.",
  ended: (minutes) => `[study] This focus stretch ended, about ${minutes} minutes.`,
  distracted: (app) => `[study] You're on ${app} — time to get back to studying.`,
  toolStarted: 'A manual focus stretch has started; I will count this time.',
  toolStopped: (minutes) => `Focus stretch ended, about ${minutes} minutes.`,
  toolIdle: 'No focus stretch is running.',
};

const TEXT: Record<ModelLanguage, typeof zh> = { zh, en };

/** Minutes between checks, picked at random so the look is not on a fixed beat. */
function randomDelay(minMin: number, maxMin: number): number {
  const lo = Math.min(minMin, maxMin);
  const hi = Math.max(minMin, maxMin);
  return Math.round((lo + Math.random() * (hi - lo)) * 60_000);
}

/** `mm:ss` of an open focus stretch. */
function clock(start: number, now: number): string {
  const s = Math.max(0, Math.floor((now - start) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class StudyWorld implements World {
  readonly id = STUDY_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly raw: StudyConfig;
  private readonly ledger: FocusLedger;
  private manual: ActiveFocus | null = null;
  private auto: ActiveFocus | null = null;
  private nextCheck = 0;
  private distractSince = 0;
  private distractApp: string | null = null;
  private distractAlerted = false;
  /** The reminder card's id; 0 = none, and negative so it never collides with a Claude session pid. */
  private alertId = 0;
  /** The last chip sent, so an idle tick does not resend it every second. */
  private ambientKey = '';

  constructor(private readonly a: StudyAssembly, raw: StudyConfig, private readonly timezone: string, ledgerFile: string) {
    this.raw = raw;
    this.ledger = new FocusLedger(ledgerFile);
  }

  /** The settings as the live config has them, so a change in the console applies without a restart. */
  private get cfg(): StudyConfig {
    return normalize(this.raw);
  }

  /** The app language as the live config has it, for what the person reads. */
  private get appLang(): Language {
    return appLanguage(this.a.read('language'));
  }

  /** The model-text language for what Coo reads. */
  private get modelLang(): ModelLanguage {
    return modelLanguage(this.a.read('language'));
  }

  envPromptVars(): null { return null; }

  /** Coo can start and end focus by hand when the person asks in conversation. */
  tools(): ToolDef[] {
    const t = () => TEXT[this.modelLang];
    return [
      {
        ...STUDY_TOOL_START,
        handler: async () => {
          this.manualStart();
          return t().toolStarted;
        },
      },
      {
        ...STUDY_TOOL_STOP,
        handler: async () => {
          const active = this.manual ?? this.auto;
          this.stopFocus();
          return active ? t().toolStopped(Math.max(1, Math.round((Date.now() - active.start) / 60_000))) : t().toolIdle;
        },
      },
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const ct = coreText(language);
    return {
      label: ct.study.label,
      panels: [{ id: 'focus', title: ct.study.label, getMethods: ['state', 'history', 'stats'] }],
      invoke: (panel, method, args) => {
        if (panel !== 'focus') throw new Error(`未知面板 ${panel}`);
        if (method === 'state') return Promise.resolve(this.state(language));
        if (method === 'history') return Promise.resolve(this.history());
        if (method === 'stats') return Promise.resolve(this.stats(args[0], language));
        if (method === 'start') { this.manualStart(); return Promise.resolve(this.state(language)); }
        if (method === 'stop') { this.stopFocus(); return Promise.resolve(this.state(language)); }
        throw new Error(`未知方法 ${panel}.${method}`);
      },
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.nextCheck = Date.now() + randomDelay(this.cfg.checkMinMin, this.cfg.checkMaxMin);
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const now = Date.now();
    // an open stretch is written as far as it went; no event, the run is ending
    if (this.auto) { this.closeSession(this.auto, now, null); this.auto = null; }
    if (this.manual) { this.closeSession(this.manual, now, null); this.manual = null; }
    this.clearDistraction();
    this.setAmbient({ active: false, text: '' });
    this.host = null;
  }

  /** The dashboard rows for the settings window. */
  state(language: Language): unknown {
    const active = this.manual ?? this.auto;
    const now = Date.now();
    return {
      focusing: active !== null,
      kind: active?.kind ?? null,
      seconds: active ? Math.max(0, Math.floor((now - active.start) / 1000)) : 0,
      todaySeconds: this.ledger.summarize(this.timezone, now).todaySeconds,
      mode: this.cfg.focusMode,
    };
  }

  /** The recent focus sessions, newest first, for the settings window's table. */
  history(): { todaySeconds: number; sessions: FocusSession[] } {
    return { todaySeconds: this.ledger.summarize(this.timezone).todaySeconds, sessions: this.ledger.recent(100) };
  }

  /** Today, this week, this month, this year or all time, bucketed for the stats chart. */
  stats(period: unknown, language: Language = this.appLang): FocusStats {
    const span: StatsPeriod = period === 'week' || period === 'month' || period === 'year' || period === 'all' ? period : 'day';
    return this.ledger.stats(span, this.timezone, language);
  }

  /** The person clicked a reminder card; keep it down until they come back to studying. */
  dismissAlert(id: number): void {
    if (id !== this.alertId) return;
    this.a.alertClear(id);
    this.alertId = 0;
  }

  /** The person chose to count focus by hand, overriding whatever the automatic reading saw. */
  manualStart(): void {
    const host = this.host;
    const now = Date.now();
    if (this.manual) return;
    if (this.auto) { this.closeSession(this.auto, now, host); this.auto = null; }
    this.manual = { start: now, kind: 'manual' };
    if (host) this.pushStarted(host);
    this.clearDistraction();
    this.pushAmbient();
  }

  manualStop(): void {
    const host = this.host;
    const now = Date.now();
    if (!this.manual) return;
    this.closeSession(this.manual, now, host);
    this.manual = null;
    this.pushAmbient();
  }

  /** Ends whichever stretch is open, automatic too: the person saying "this was not study time" is the correction. */
  stopFocus(): void {
    if (this.manual) { this.manualStop(); return; }
    const auto = this.auto;
    if (!auto) return;
    this.closeSession(auto, Date.now(), this.host);
    this.auto = null;
    this.pushAmbient();
  }

  private async tick(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const now = Date.now();
    if (now < this.nextCheck) { this.pushAmbient(); return; }
    this.nextCheck = now + randomDelay(this.cfg.checkMinMin, this.cfg.checkMaxMin);
    let fg: ForegroundInfo | null = null;
    try { fg = await this.a.foreground(); } catch { /* a read that fails counts as no window */ }
    this.check(fg, now, host);
    this.pushAmbient();
  }

  private check(fg: ForegroundInfo | null, now: number, host: WorldHost): void {
    const cls = classify(fg, this.cfg.studyApps, this.cfg.distractorApps);
    if (this.cfg.focusMode !== 'manual' && this.manual === null) {
      if (cls === 'study') {
        if (this.auto === null) { this.auto = { start: now, kind: 'auto' }; this.pushStarted(host); }
      } else if (this.auto !== null) {
        this.closeSession(this.auto, now, host);
        this.auto = null;
      }
    }
    if (cls === 'distract') {
      if (this.distractSince === 0) {
        this.distractSince = now;
        this.distractApp = appLabel(fg);
      } else if (!this.distractAlerted && now - this.distractSince >= this.cfg.idleGraceMin * 60_000) {
        this.distractAlerted = true;
        this.raiseAlert(host);
      }
    } else {
      this.clearDistraction();
    }
  }

  private closeSession(session: ActiveFocus, end: number, host: WorldHost | null): void {
    const seconds = Math.max(0, Math.floor((end - session.start) / 1000));
    if (seconds > 0) this.ledger.append({ start: session.start, end, seconds, kind: session.kind });
    if (host) this.pushEnded(seconds, host);
  }

  private raiseAlert(host: WorldHost): void {
    this.alertId -= 1;
    const id = this.alertId;
    this.a.alert(id, 'study', coreText(this.appLang).study.distracted(this.distractApp ?? '?'));
    this.pushDistracted(host);
  }

  private clearDistraction(): void {
    this.distractSince = 0;
    this.distractApp = null;
    this.distractAlerted = false;
    if (this.alertId !== 0) { this.a.alertClear(this.alertId); this.alertId = 0; }
  }

  private pushAmbient(): void {
    const active = this.manual ?? this.auto;
    if (!active) { this.setAmbient({ active: false, text: '' }); return; }
    this.setAmbient({ active: true, text: coreText(this.appLang).study.focus(clock(active.start, Date.now())) });
  }

  /** Sends the chip only when it changed: the clock moves every second, an idle chip does not. */
  private setAmbient(status: AmbientStatus): void {
    const key = `${status.active ? 1 : 0}\u0000${status.text}`;
    if (key === this.ambientKey) return;
    this.ambientKey = key;
    this.a.ambient(status);
  }

  private pushStarted(host: WorldHost): void {
    host.pushDeferred({ type: 'study.started', origin: 'internal', render: () => TEXT[this.modelLang].started }, { trigger: 'flush' });
  }

  private pushEnded(seconds: number, host: WorldHost): void {
    host.pushDeferred({ type: 'study.ended', origin: 'internal', render: () => TEXT[this.modelLang].ended(Math.round(seconds / 60)) }, { trigger: 'flush' });
  }

  private pushDistracted(host: WorldHost): void {
    const app = this.distractApp ?? '?';
    host.pushDeferred({ type: 'study.distracted', origin: 'internal', render: () => TEXT[this.modelLang].distracted(app) }, { trigger: 'flush' });
  }
}

const DESCRIBE: WorldDescribe = {
  tools: describeTools([STUDY_TOOL_START, STUDY_TOOL_STOP], {
    study_start: { zh: '使用者让你帮忙记时;手动开始一段专注。', en: 'The person asked to be timed: start a focus stretch by hand.' },
    study_stop: { zh: '手头这段专注结束(自动识别出来的也算)。', en: 'The current focus stretch ends, an automatic one included.' },
  }),
  events: [
    {
      type: 'study.started', trigger: 'flush',
      description: { zh: '使用者开始了一段专注,提醒一句即可。', en: "The person started a focus stretch; a brief word is enough." },
    },
    {
      type: 'study.ended', trigger: 'flush',
      description: { zh: '使用者的一段专注结束了,附约多少分钟。', en: "The person's focus stretch ended, with roughly how many minutes it lasted." },
    },
    {
      type: 'study.distracted', trigger: 'flush',
      description: { zh: '使用者正在用分心应用,该提醒回到学习。', en: 'The person is on a distracting app; remind them to get back to studying.' },
    },
  ],
};

export function studyDefinition(assembly: StudyAssembly): WorldDefinition<StudyConfig> {
  return {
    id: STUDY_ID,
    get label() { return assembly.label(); },
    defaults: () => studyDefaults(),
    create: (ctx) => {
      const world = new StudyWorld(assembly, ctx.cfg, ctx.timezone, join(ctx.dataDir, 'focus.jsonl'));
      assembly.onCreate?.(world);
      return world;
    },
    describe: DESCRIBE,
  };
}
