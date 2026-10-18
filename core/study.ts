/**
 * The `study` World: at irregular intervals it reads the foreground window and decides whether the
 * person is studying or slacking off, urges them back when they drift, and counts focus time — both
 * automatically (the foreground hits the study-app list) and by hand (start/pause/resume/stop in
 * the settings window or the pet's menu), the hand-started kind toward one of the person's goals.
 *
 * Four outputs:
 * - a `study.started` / `study.ended` / `study.distracted` event for Coo, so it decides when to speak;
 * - an ambient chip on the pet showing the live focus clock;
 * - a sticky `study` card on the pet when the person stays on a distractor app;
 * - a `focus` panel whose `state`, `history`, `stats`, `goals`, `start`, `pause`, `resume`, `stop`
 *   and goal-edit methods drive the settings window and the World panel.
 *
 * Only the foreground window's title and process name are read, matched locally; nothing leaves the
 * machine, and no screenshot or window list is taken.
 */
import { dirname, join } from 'node:path';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import type { AmbientStatus } from 'cortico-world-desktop-pet';
import {
  FocusLedger, appLabel, classify, normalize, studyDefaults,
  type FocusSession, type FocusStats, type ForegroundInfo, type GoalTotal, type StatsPeriod, type StudyConfig,
} from './study-sessions.ts';
import { FocusGoals, type FocusGoal, type GoalEditResult } from './study-goals.ts';
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
interface ActiveFocus {
  start: number;
  kind: 'auto' | 'manual';
  /** Only a hand-started stretch has one; the automatic reading never counts toward a goal. */
  goalId: string | null;
  goalName: string | null;
  /** When the pause began, or null while the stretch runs. */
  pausedAt: number | null;
  /** Pauses already closed, taken off the elapsed time. */
  pausedMs: number;
}

/** Coo starts a manual stretch when the person says they are studying. */
export const STUDY_TOOL_START: Omit<ToolDef, 'handler'> = {
  name: 'study_start',
  tags: ['write'],
  description: 'Start a focus stretch by hand: focus time is counted from now until study_stop, whichever app is in front. Pass goal to count the stretch toward one of the person\'s focus goals (it is created when missing). Use it when the person says they are starting to study or asks to be supervised.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The focus goal\'s name, such as "reading" or "coding"; omit when the person did not name one.' },
    },
  },
};

/** Coo pauses the stretch in progress; the clock and supervision both stop. */
export const STUDY_TOOL_PAUSE: Omit<ToolDef, 'handler'> = {
  name: 'study_pause',
  tags: ['write'],
  description: 'Pause the focus stretch in progress: the timer freezes and supervision stops. Use it when the person says they are taking a break.',
  parameters: { type: 'object', properties: {} },
};

/** Coo resumes the paused stretch, the same one, with the pause excluded from its time. */
export const STUDY_TOOL_RESUME: Omit<ToolDef, 'handler'> = {
  name: 'study_resume',
  tags: ['write'],
  description: 'Resume the paused focus stretch; the same stretch continues and the pause is not counted. Use it when the person comes back.',
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
  toolStartedGoal: (goal: string) => `手动专注已开始,目标是「${goal}」,我把这段时间记下来。`,
  toolGoalInvalid: (name: string) => `「${name}」不能作为目标名,这次先按无目标记。`,
  toolRunning: '现在已经在专注了。',
  toolPaused: '专注已暂停,计时和监督都停下来了。',
  toolAlreadyPaused: '专注本来就暂停着。',
  toolResumed: '专注继续,接着计时。',
  toolStopped: (minutes: number) => `专注结束,这段约 ${minutes} 分钟。`,
  toolIdle: '现在没有正在进行的专注。',
};

const en: typeof zh = {
  started: "[study] You're studying now — I'll count your focus time.",
  ended: (minutes) => `[study] This focus stretch ended, about ${minutes} minutes.`,
  distracted: (app) => `[study] You're on ${app} — time to get back to studying.`,
  toolStarted: 'A manual focus stretch has started; I will count this time.',
  toolStartedGoal: (goal) => `A manual focus stretch has started toward "${goal}"; I will count this time.`,
  toolGoalInvalid: (name) => `"${name}" cannot be a goal name, so this stretch is counted without one.`,
  toolRunning: 'A focus stretch is already running.',
  toolPaused: 'Focus is paused; the clock and supervision have stopped.',
  toolAlreadyPaused: 'Focus was already paused.',
  toolResumed: 'Focus continues; the clock is running again.',
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

/** `mm:ss` of a focus stretch's elapsed seconds. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** A goal total with what the chart and the settings page need to draw it. */
export interface GoalStat extends GoalTotal {
  /** The goal's chart colour, or null for a goal deleted from the store. */
  color: number | null;
  deleted: boolean;
}

export class StudyWorld implements World {
  readonly id = STUDY_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly raw: StudyConfig;
  private readonly ledger: FocusLedger;
  private readonly goals: FocusGoals;
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

  constructor(
    private readonly a: StudyAssembly,
    raw: StudyConfig,
    private readonly timezone: string,
    ledgerFile: string,
    goals: FocusGoals = new FocusGoals(join(dirname(ledgerFile), 'focus-goals.json')),
  ) {
    this.raw = raw;
    this.ledger = new FocusLedger(ledgerFile);
    this.goals = goals;
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

  /** Coo can start, pause, resume and end focus by hand when the person asks in conversation. */
  tools(): ToolDef[] {
    const t = () => TEXT[this.modelLang];
    return [
      {
        ...STUDY_TOOL_START,
        handler: async (args) => {
          const active = this.activeFocus();
          if (active) {
            if (active.pausedAt !== null) { this.resumeFocus(); return t().toolResumed; }
            return t().toolRunning;
          }
          const wanted = typeof (args as { goal?: unknown } | undefined)?.goal === 'string'
            ? String((args as { goal: string }).goal).trim()
            : '';
          const goal = wanted ? this.goals.ensure(wanted) : null;
          this.startFocus(goal?.id ?? null);
          if (wanted && !goal) return t().toolGoalInvalid(wanted);
          return goal ? t().toolStartedGoal(goal.name) : t().toolStarted;
        },
      },
      {
        ...STUDY_TOOL_PAUSE,
        handler: async () => {
          const active = this.activeFocus();
          if (!active) return t().toolIdle;
          if (active.pausedAt !== null) return t().toolAlreadyPaused;
          this.pauseFocus();
          return t().toolPaused;
        },
      },
      {
        ...STUDY_TOOL_RESUME,
        handler: async () => {
          const active = this.activeFocus();
          if (!active) return t().toolIdle;
          if (active.pausedAt === null) return t().toolRunning;
          this.resumeFocus();
          return t().toolResumed;
        },
      },
      {
        ...STUDY_TOOL_STOP,
        handler: async () => {
          const active = this.activeFocus();
          if (!active) { this.stopFocus(); return t().toolIdle; }
          const minutes = Math.max(1, Math.round(this.elapsedMs(active, Date.now()) / 60_000));
          this.stopFocus();
          return t().toolStopped(minutes);
        },
      },
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const ct = coreText(language);
    return {
      label: ct.study.label,
      panels: [{ id: 'focus', title: ct.study.label, getMethods: ['state', 'history', 'stats', 'goals'] }],
      invoke: (panel, method, args) => {
        if (panel !== 'focus') throw new Error(`未知面板 ${panel}`);
        if (method === 'state') return Promise.resolve(this.state(language));
        if (method === 'history') return Promise.resolve(this.history());
        if (method === 'stats') return Promise.resolve(this.stats(args[0], args[1], language));
        if (method === 'goals') return Promise.resolve(this.goals.list());
        if (method === 'start') { this.startFocus(typeof args[0] === 'string' ? args[0] : null); return Promise.resolve(this.state(language)); }
        if (method === 'pause') { this.pauseFocus(); return Promise.resolve(this.state(language)); }
        if (method === 'resume') { this.resumeFocus(); return Promise.resolve(this.state(language)); }
        if (method === 'stop') { this.stopFocus(); return Promise.resolve(this.state(language)); }
        if (method === 'goalAdd') return Promise.resolve(this.goalAdd(args[0]));
        if (method === 'goalRename') return Promise.resolve(this.goalRename(args[0], args[1]));
        if (method === 'goalDelete') return Promise.resolve(this.goalDelete(args[0]));
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
    const active = this.activeFocus();
    const now = Date.now();
    return {
      focusing: active !== null,
      paused: active?.pausedAt != null,
      kind: active?.kind ?? null,
      seconds: active ? Math.floor(this.elapsedMs(active, now) / 1000) : 0,
      goalId: active?.goalId ?? null,
      goalName: active?.goalName ?? null,
      todaySeconds: this.ledger.summarize(this.timezone, now).todaySeconds,
      mode: this.cfg.focusMode,
    };
  }

  /** The recent focus sessions, newest first, for the settings window's table. */
  history(): { todaySeconds: number; sessions: FocusSession[] } {
    return { todaySeconds: this.ledger.summarize(this.timezone).todaySeconds, sessions: this.ledger.recent(100) };
  }

  /** Today, this week, this month, this year or all time, bucketed for the stats chart and filtered by goal. */
  stats(period: unknown, goalFilter: unknown = null, language: Language = this.appLang): FocusStats {
    const span: StatsPeriod = period === 'week' || period === 'month' || period === 'year' || period === 'all' ? period : 'day';
    const filter = typeof goalFilter === 'string' ? goalFilter : null;
    const d = this.ledger.stats(span, this.timezone, language, Date.now(), filter);
    const live = this.goals.list();
    const known = new Map(live.map((g) => [g.id, g]));
    const totals: GoalStat[] = d.goalTotals.map((t) => {
      const goal = known.get(t.goalId);
      return {
        goalId: t.goalId,
        goalName: goal?.name ?? t.goalName,
        seconds: t.seconds,
        color: goal?.color ?? null,
        deleted: t.goalId !== '' && goal === undefined,
      };
    });
    // every current goal appears, even one with no time in this span
    for (const goal of live) {
      if (!totals.some((t) => t.goalId === goal.id)) {
        totals.push({ goalId: goal.id, goalName: goal.name, seconds: 0, color: goal.color, deleted: false });
      }
    }
    return { ...d, goalTotals: totals };
  }

  /** What the pet's menu draws: no clock, so prefs do not change every second. */
  petFocusState(): { focusing: boolean; paused: boolean; goalId: string | null; goalName: string | null } {
    const active = this.activeFocus();
    return {
      focusing: active !== null,
      paused: active?.pausedAt != null,
      goalId: active?.goalId ?? null,
      goalName: active?.goalName ?? null,
    };
  }

  petGoals(): FocusGoal[] {
    return this.goals.list();
  }

  goalAdd(name: unknown): GoalEditResult {
    return this.goals.add(name);
  }

  goalRename(id: unknown, name: unknown): GoalEditResult {
    return this.goals.rename(id, name);
  }

  goalDelete(id: unknown): GoalEditResult {
    return this.goals.remove(id);
  }

  /** The person clicked a reminder card; keep it down until they come back to studying. */
  dismissAlert(id: number): void {
    if (id !== this.alertId) return;
    this.a.alertClear(id);
    this.alertId = 0;
  }

  /** The stretch the chip, the timer and the controls speak of; a manual one replaces the automatic. */
  private activeFocus(): ActiveFocus | null {
    return this.manual ?? this.auto;
  }

  /** Time actually spent focusing: pauses are taken off, and a paused stretch stops at the pause. */
  private elapsedMs(focus: ActiveFocus, now: number): number {
    return Math.max(0, (focus.pausedAt ?? now) - focus.start - focus.pausedMs);
  }

  /** The person chose to count focus by hand, overriding whatever the automatic reading saw. */
  manualStart(): void {
    this.startFocus(null);
  }

  /** A manual stretch toward `goalId` (null for none), unless one is already open or paused. */
  startFocus(goalId: string | null): void {
    const host = this.host;
    if (this.manual) {
      if (this.manual.pausedAt !== null) this.resumeFocus();
      return;
    }
    const now = Date.now();
    if (this.auto) { this.closeSession(this.auto, now, host); this.auto = null; }
    const goal = this.goals.get(goalId);
    this.manual = {
      start: now,
      kind: 'manual',
      goalId: goal?.id ?? null,
      goalName: goal?.name ?? null,
      pausedAt: null,
      pausedMs: 0,
    };
    if (host) this.pushStarted(host);
    this.clearDistraction();
    this.pushAmbient();
  }

  /** Freezes the clock and stops supervision: no foreground reads, no reminders until resumed. */
  pauseFocus(): void {
    const active = this.activeFocus();
    if (!active || active.pausedAt !== null) { this.pushAmbient(); return; }
    active.pausedAt = Date.now();
    this.clearDistraction();
    this.pushAmbient();
  }

  /** Resumes the same stretch; the pause is taken off its time and supervision may look at once. */
  resumeFocus(): void {
    const active = this.activeFocus();
    if (!active || active.pausedAt === null) return;
    const now = Date.now();
    active.pausedMs += Math.max(0, now - active.pausedAt);
    active.pausedAt = null;
    this.nextCheck = 0;
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
    // a pause stops both the clock and supervision; no foreground read happens
    if (this.activeFocus()?.pausedAt != null) { this.pushAmbient(); return; }
    if (now < this.nextCheck) { this.pushAmbient(); return; }
    this.nextCheck = now + randomDelay(this.cfg.checkMinMin, this.cfg.checkMaxMin);
    let fg: ForegroundInfo | null = null;
    try { fg = await this.a.foreground(); } catch { /* a read that fails counts as no window */ }
    this.check(fg, now, host);
    this.pushAmbient();
  }

  private check(fg: ForegroundInfo | null, now: number, host: WorldHost): void {
    if (this.activeFocus()?.pausedAt != null) return;
    const cls = classify(fg, this.cfg.studyApps, this.cfg.distractorApps);
    if (this.cfg.focusMode !== 'manual' && this.manual === null) {
      if (cls === 'study') {
        if (this.auto === null) {
          this.auto = { start: now, kind: 'auto', goalId: null, goalName: null, pausedAt: null, pausedMs: 0 };
          this.pushStarted(host);
        }
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
    const seconds = Math.max(0, Math.floor(this.elapsedMs(session, end) / 1000));
    if (seconds > 0) {
      const row: FocusSession = {
        start: session.start,
        end: session.pausedAt ?? end,
        seconds,
        kind: session.kind,
      };
      if (session.goalId) {
        row.goal = session.goalId;
        row.goalName = session.goalName ?? session.goalId;
      }
      this.ledger.append(row);
    }
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
    const active = this.activeFocus();
    if (!active) { this.setAmbient({ active: false, text: '' }); return; }
    const text = coreText(this.appLang).study;
    const elapsed = Math.floor(this.elapsedMs(active, Date.now()) / 1000);
    this.setAmbient({
      active: true,
      text: active.pausedAt !== null ? text.paused(clock(elapsed)) : text.focus(clock(elapsed)),
    });
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
  tools: describeTools([STUDY_TOOL_START, STUDY_TOOL_PAUSE, STUDY_TOOL_RESUME, STUDY_TOOL_STOP], {
    study_start: { zh: '使用者让你帮忙记时;手动开始一段专注,可指定目标。', en: 'The person asked to be timed: start a focus stretch by hand, optionally toward a goal.' },
    study_pause: { zh: '使用者要休息一下;暂停当前专注。', en: 'The person is taking a break: pause the current focus stretch.' },
    study_resume: { zh: '使用者回来了;继续暂停中的专注。', en: 'The person is back: resume the paused focus stretch.' },
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
      const world = new StudyWorld(
        assembly,
        ctx.cfg,
        ctx.timezone,
        join(ctx.dataDir, 'focus.jsonl'),
        new FocusGoals(join(ctx.dataDir, 'focus-goals.json')),
      );
      assembly.onCreate?.(world);
      return world;
    },
    describe: DESCRIBE,
  };
}
