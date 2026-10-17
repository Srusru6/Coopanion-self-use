/**
 * The `claude-cli` World: reads the Claude Code CLI's running sessions and tells the person how
 * their tasks are going, without changing the CLI's configuration.
 *
 * Three outputs, all from one poll loop over `~/.claude`:
 * - an ambient status on the desktop pet: every poll it composes a sentence ("Claude · editing
 *   report.md · 123 tok/s") and hands it to the pet World's `ambientStatus`, which shows a dim chip;
 * - events for Coo: `claude-cli.started` and `claude-cli.finished` flush when a session begins or
 *   ends a task, `claude-cli.progress` debounced while it works, so Coo decides when to speak;
 * - a `sessions` panel whose `state` method answers the settings window's dashboard.
 *
 * Only token counts, tool names and their targets, session names and working directories are read;
 * the conversation's text and thinking never are, and nothing leaves the machine.
 */
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldDefinition, WorldDescribe, WorldSection } from 'cortico/world.ts';
import type { AmbientStatus } from 'cortico-world-desktop-pet';
import {
  assistantUsage, computeRate, readSessions, Tail, transcriptPath,
  type ClaudeSession, type ClaudeStatus, type RateSample, type ToolVerb,
} from './claude-sessions.ts';
import { coreText } from './i18n/index.ts';
import { appLanguage, modelLanguage, type ModelLanguage } from './language.ts';

export const CLAUDE_CLI_ID = 'claude-cli';
const POLL_MS = 1000;
const RATE_WINDOW_MS = 60_000;
/** How much a fresh window rate moves the shown speed (the rest is the previous speed). */
const SPEED_EMA = 0.3;

export interface ClaudeCliAssembly {
  /** The `.claude` directory to read; the default in claude-sessions.ts. */
  claudeDir: () => string;
  /** A value of the live config by dotted path; `language` gives the app language. */
  read: (path: string) => unknown;
  /** The pet page is connected, so the ambient chip can show. */
  petConnected: () => boolean;
  /** Puts the ambient status on the pet's chip. */
  ambient: (status: AmbientStatus) => void;
  /** A burst of tokens one action just consumed, for the pet's damage numbers. */
  hit: (tokens: number) => void;
  /** A sticky card on the pet for something the person must notice; it stays until they click it. */
  alert: (id: number, kind: 'approval' | 'done', text: string) => void;
  /** Removes the sticky card for a session. */
  alertClear: (id: number) => void;
  /** Its name when Core assembles the Worlds, in the app language of that moment. */
  label: () => string;
  onCreate?: (world: ClaudeCliWorld) => void;
}

interface Counter { input: number; output: number; cache: number; }

/** One running session, with what the polls have counted about it. */
interface SessionState {
  session: ClaudeSession;
  path: string | null;
  tail: Tail | null;
  /** Counted since the poll loop first saw the session. */
  total: Counter;
  /** Counted since the session's current busy stretch began. */
  run: Counter;
  samples: RateSample[];
  speed: number;
  tool: ToolVerb | null;
  target: string;
  model: string;
  /** The sticky card this session has up on the pet; null when none. */
  alert: 'approval' | 'done' | null;
}

const zero = (): Counter => ({ input: 0, output: 0, cache: 0 });
const consumed = (c: Counter): number => c.input + c.output + c.cache;

const zh = {
  started: (name: string, cwd: string) => `[Claude Code] ${name} 开始了一段任务(目录:${cwd})。`,
  finished: (name: string, tokens: number) => `[Claude Code] ${name} 刚完成了一段任务,这一段约消耗 ${tokens} token。`,
  progress: (name: string, action: string, speed: string) => `[Claude Code] ${name} 正在${action},当前速度约 ${speed}。`,
};

const en: typeof zh = {
  started: (name, cwd) => `[Claude Code] ${name} started a task (in ${cwd}).`,
  finished: (name, tokens) => `[Claude Code] ${name} just finished a task, about ${tokens} tokens in this stretch.`,
  progress: (name, action, speed) => `[Claude Code] ${name} is ${action}, about ${speed} now.`,
};

const TEXT: Record<ModelLanguage, typeof zh> = { zh, en };

export class ClaudeCliWorld implements World {
  readonly id = CLAUDE_CLI_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly states = new Map<number, SessionState>();
  /** Conditions (`pid:kind`) whose card the person clicked away; each stays down until that condition changes. */
  private readonly dismissed = new Set<string>();

  constructor(private readonly a: ClaudeCliAssembly) {}

  /** The app language as the live config has it, for what the person reads. */
  private get appLang(): Language {
    return appLanguage(this.a.read('language'));
  }

  /** The model-text language for what Coo reads. */
  private get modelLang(): ModelLanguage {
    return modelLanguage(this.a.read('language'));
  }

  envPromptVars(): null { return null; }
  tools(): ToolDef[] { return []; }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const ct = coreText(language);
    return {
      label: ct.claude.label,
      panels: [{ id: 'sessions', title: ct.claude.label, getMethods: ['state'] }],
      invoke: (panel, method) => {
        if (panel !== 'sessions' || method !== 'state') throw new Error(`未知面板方法 ${panel}.${method}`);
        return Promise.resolve(this.state(language));
      },
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
    this.states.clear();
  }

  /** The dashboard rows, busy sessions first, localized for the request's language. */
  state(language: Language): unknown {
    const ct = coreText(language);
    const rank = (status: ClaudeStatus) => (status === 'waiting' ? 0 : status === 'busy' ? 1 : 2);
    const sessions = [...this.states.values()]
      .sort((a, b) => (a.session.status === b.session.status ? a.session.pid - b.session.pid : rank(a.session.status) - rank(b.session.status)))
      .map((s) => {
        const verb = ct.claude.verb[s.tool ?? 'other'];
        const action = s.session.status === 'busy' && s.tool ? (s.target ? `${verb} ${s.target}` : verb) : '';
        return {
          pid: s.session.pid,
          name: s.session.name,
          cwd: s.session.cwd,
          status: s.session.status,
          statusText: ct.claude.status[s.session.status],
          action,
          speed: Math.round(s.speed),
          input: s.total.input,
          output: s.total.output,
          cache: s.total.cache,
          model: s.model,
        };
      });
    return { active: sessions.some((s) => s.status !== 'idle'), sessions };
  }

  private tick(): void {
    const host = this.host;
    if (!host) return;
    let sessions: ClaudeSession[];
    try { sessions = readSessions(this.a.claudeDir()); } catch { return; }
    const present = new Set<number>();
    for (const s of sessions) {
      present.add(s.pid);
      let state = this.states.get(s.pid);
      if (!state) {
        state = this.seed(s);
        this.states.set(s.pid, state);
        this.onStatus(state, null, s, host);
      } else {
        const prev = state.session.status;
        if (prev !== s.status) this.onStatus(state, prev, s, host);
        state.session = s;
      }
      if (s.status === 'busy' && this.advance(state)) this.pushProgress(state, host);
    }
    for (const [pid, state] of this.states) {
      if (present.has(pid)) continue;
      if (state.session.status !== 'idle') this.pushFinished(state, host);
      this.states.delete(pid);
      this.dismissed.delete(`${pid}:approval`);
      this.dismissed.delete(`${pid}:done`);
    }
    this.pushAmbient();
  }

  /** A session's status changed, or it was first seen: start/stop a run and raise or clear its sticky card. */
  private onStatus(state: SessionState, prev: ClaudeStatus | null, next: ClaudeSession, host: WorldHost): void {
    const wasActive = prev !== null && prev !== 'idle';
    const isActive = next.status !== 'idle';
    if (isActive && !wasActive) {
      // a fresh task: reset the run and drop any stale done card
      this.beginRun(state);
      this.dropAlert(state, 'done');
      if (next.status === 'busy') this.pushStarted(next, host);
    }
    if (next.status === 'waiting') this.raiseAlert(state, 'approval');
    else if (prev === 'waiting') this.dropAlert(state, 'approval');
    if (wasActive && next.status === 'idle') {
      this.pushFinished(state, host);
      this.raiseAlert(state, 'done');
    }
  }

  private seed(session: ClaudeSession): SessionState {
    return {
      session, path: null, tail: null,
      total: zero(), run: zero(), samples: [], speed: 0,
      tool: null, target: '', model: session.model ?? '', alert: null,
    };
  }

  private beginRun(state: SessionState): void {
    state.run = zero();
    state.samples = [];
    state.speed = 0;
    state.tool = null;
    state.target = '';
  }

  /** Puts a sticky card on the pet for a session, once per condition; a card the person clicked away stays down until that condition changes. */
  private raiseAlert(state: SessionState, kind: 'approval' | 'done'): void {
    if (state.alert === kind || this.dismissed.has(this.alertKey(state.session.pid, kind))) return;
    state.alert = kind;
    this.a.alert(state.session.pid, kind, this.alertText(state, kind));
  }

  /** A condition ended: takes its card down and forgets its dismissal, so the next time it can raise again. */
  private dropAlert(state: SessionState, kind: 'approval' | 'done'): void {
    if (state.alert === kind) { this.a.alertClear(state.session.pid); state.alert = null; }
    this.dismissed.delete(this.alertKey(state.session.pid, kind));
  }

  /** The person clicked a card; keep it down until this session's condition changes. */
  dismissAlert(pid: number): void {
    const state = this.states.get(pid);
    if (!state || state.alert === null) return;
    this.dismissed.add(this.alertKey(pid, state.alert));
    state.alert = null;
  }

  private alertKey(pid: number, kind: 'approval' | 'done'): string {
    return `${pid}:${kind}`;
  }

  private alertText(state: SessionState, kind: 'approval' | 'done'): string {
    const ct = coreText(this.appLang);
    const name = state.session.name || `#${state.session.pid}`;
    return kind === 'approval' ? ct.claude.alert.approval(name) : ct.claude.alert.done(name);
  }

  /** Reads the transcript's new lines into the counters; true when any carried usage. */
  private advance(state: SessionState): boolean {
    if (!state.tail) {
      state.path = transcriptPath(this.a.claudeDir(), state.session);
      if (!state.path) return false;
      state.tail = new Tail(state.path);
      // a transcript that predates this watch is not replayed as fresh damage
      state.tail.skipToEnd();
    }
    let steps = 0;
    for (const line of state.tail.readNew()) {
      const step = assistantUsage(line);
      if (!step) continue;
      steps++;
      this.a.hit(step.input + step.output + step.cache);
      state.total.input += step.input;
      state.total.output += step.output;
      state.total.cache += step.cache;
      state.run.input += step.input;
      state.run.output += step.output;
      state.run.cache += step.cache;
      if (step.model) state.model = step.model;
      if (step.tool) { state.tool = step.tool; state.target = step.target; }
      const at = step.at || Date.now();
      const tokens = consumed(state.total);
      const samples = state.samples;
      if (samples.length && samples[samples.length - 1]!.t === at) samples[samples.length - 1] = { t: at, tokens };
      else samples.push({ t: at, tokens });
      const windowStart = samples[samples.length - 1]!.t - RATE_WINDOW_MS;
      while (samples.length > 2 && samples[1]!.t < windowStart) samples.shift();
    }
    if (steps) {
      const rate = computeRate(state.samples, RATE_WINDOW_MS);
      state.speed = state.speed === 0 ? rate : rate * SPEED_EMA + state.speed * (1 - SPEED_EMA);
    }
    return steps > 0;
  }

  private pushStarted(s: ClaudeSession, host: WorldHost): void {
    host.pushDeferred({
      type: 'claude-cli.started', origin: 'internal',
      render: () => TEXT[this.modelLang].started(s.name || `#${s.pid}`, s.cwd || '?'),
    }, { trigger: 'flush' });
  }

  private pushFinished(state: SessionState, host: WorldHost): void {
    const tokens = consumed(state.run);
    host.pushDeferred({
      type: 'claude-cli.finished', origin: 'internal',
      render: () => TEXT[this.modelLang].finished(state.session.name || `#${state.session.pid}`, Math.round(tokens)),
    }, { trigger: 'flush' });
  }

  private pushProgress(state: SessionState, host: WorldHost): void {
    host.pushDeferred({
      type: 'claude-cli.progress', origin: 'internal',
      render: () => {
        const ct = coreText(this.modelLang);
        const verb = ct.claude.verb[state.tool ?? 'other'];
        const action = state.target ? `${verb} ${state.target}` : verb;
        return TEXT[this.modelLang].progress(state.session.name || `#${state.session.pid}`, action, ct.claude.speed(Math.round(state.speed)));
      },
    }, { trigger: 'debounce' });
  }

  private pushAmbient(): void {
    const active = [...this.states.values()].find((s) => s.session.status !== 'idle');
    if (!active) { this.a.ambient({ active: false, text: '' }); return; }
    const ct = coreText(this.appLang);
    if (active.session.status === 'waiting') {
      const name = active.session.name || `#${active.session.pid}`;
      this.a.ambient({ active: true, text: ct.claude.waitingShort, detail: ct.claude.alert.approval(name) });
      return;
    }
    const verb = ct.claude.verb[active.tool ?? 'other'];
    const action = active.target ? `${verb} ${active.target}` : verb;
    this.a.ambient({ active: true, text: ct.claude.working, detail: ct.claude.busy(action, ct.claude.speed(Math.round(active.speed))) });
  }
}

const DESCRIBE: WorldDescribe = {
  tools: [],
  events: [
    {
      type: 'claude-cli.started', trigger: 'flush',
      description: { zh: '使用者机器上正在运行的 Claude Code 开始了一段任务;挑值得说的,用自己的话转述。', en: "A Claude Code session on the person's machine just started a task; pick what is worth telling and say it in your own words." },
    },
    {
      type: 'claude-cli.finished', trigger: 'flush',
      description: { zh: '使用者机器上的 Claude Code 刚完成了一段任务,附这一段约消耗的 token 数;挑值得说的转述。', en: "A Claude Code session on the person's machine just finished a task, with the tokens this stretch used; pick what is worth telling." },
    },
    {
      type: 'claude-cli.progress', trigger: 'debounce',
      description: { zh: 'Claude Code 正在做事的动作与当前 token 速度;通常不用说,到值得留意的节点再开口。', en: 'What a Claude Code session is doing and its current token speed; usually stay quiet, and speak at moments worth noting.' },
    },
  ],
};

export function claudeCliDefinition(assembly: ClaudeCliAssembly): WorldDefinition<WorldSection> {
  return {
    id: CLAUDE_CLI_ID,
    get label() { return assembly.label(); },
    defaults: () => ({ enabled: true }),
    create: (ctx) => {
      const world = new ClaudeCliWorld(assembly);
      assembly.onCreate?.(world);
      return world;
    },
    describe: DESCRIBE,
  };
}
