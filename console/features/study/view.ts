/**
 * The study dashboard, shared by the settings window's page and the World panel: today's focus
 * time, whether a stretch is open or paused right now, the goal controls, the goals someone made,
 * the focus statistics chart (today, last 7 days, last 30 days, last 12 months, all time) and the
 * recent sessions.
 *
 * Both hosts hand in the same `WebUi` and `invoke`, so the two renderings cannot drift apart.
 */
import type { WebUi } from 'cortico/web/shared/client-panel.ts';
import { focusChart, type ChartSeries } from './chart.ts';
import type { StudyStrings } from './strings.ts';

export type StatsPeriod = 'day' | 'week' | 'month' | 'year' | 'all';
export type GoalError = 'empty' | 'duplicate' | 'tooLong' | 'full' | 'missing';

export interface StudyGoal {
  id: string;
  name: string;
  color: number;
}

export interface StudySession {
  start: number;
  end: number;
  seconds: number;
  kind: 'auto' | 'manual';
  goal?: string;
  goalName?: string;
}

export interface StudyState {
  focusing: boolean;
  paused: boolean;
  kind: 'auto' | 'manual' | null;
  seconds: number;
  goalId: string | null;
  goalName: string | null;
  todaySeconds: number;
  mode: 'auto' | 'manual' | 'both';
}

export interface StudyHistory {
  todaySeconds: number;
  sessions: StudySession[];
}

export interface StatsBucket {
  label: string;
  seconds: number;
  auto: number;
  manual: number;
  goals?: Record<string, number>;
}

export interface GoalTotal {
  goalId: string;
  goalName: string;
  seconds: number;
  color: number | null;
  deleted: boolean;
}

export interface StudyStats {
  period: StatsPeriod;
  totalSeconds: number;
  sessionCount: number;
  longestSeconds: number;
  activeBuckets: number;
  buckets: StatsBucket[];
  goalTotals: GoalTotal[];
  hasGoals: boolean;
}

export interface GoalMutation {
  goals: StudyGoal[];
  goal: StudyGoal | null;
  error: GoalError | null;
}

export interface StudyViewDeps {
  ui: WebUi;
  root: HTMLElement;
  t: StudyStrings;
  signal: AbortSignal;
  /** Calls a `focus` panel method. */
  invoke<T = unknown>(method: string, args?: unknown[]): Promise<T>;
  /** Repeats `fn` every `ms` until the host unmounts. */
  interval(fn: () => void, ms: number): unknown;
  /** The console page shows its title and description above the cards; the panel lives under one. */
  intro?: HTMLElement;
}

/** How often the dashboard refetches. */
const LIVE_MS = 2000;
/** The goal filter's value for "every goal". */
const ALL_GOALS = '*';

/** `mm:ss` of an open stretch. */
function clock(s: number): string {
  const n = Math.max(0, Math.floor(s));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** A total in seconds, `1h 03m` past the hour and `3m 04s` under it. */
function span(total: number): string {
  const n = Math.max(0, Math.floor(total));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(n % 60).padStart(2, '0')}s`;
}

/** `HH:MM` of a session's edge, in the machine's own time. */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The chart colour of a goal, or the neutral tone for sessions without one. */
function goalColor(goalId: string, color: number | null, index: number): string {
  if (goalId === '') return 'var(--ink-dim)';
  return `var(--chart-${(color ?? index) % 8 + 1})`;
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function mountStudyView(deps: StudyViewDeps): void {
  const { ui, root, t, signal } = deps;

  const cards = ui.statgrid();
  const control = ui.sheet({ title: t.pageTitle, en: 'study' });
  const controlBar = ui.actions();
  control.body.append(controlBar);

  const goalsSheet = ui.sheet({ title: t.goalsTitle, en: 'goals' });
  const addBar = ui.actions();
  const addInput = ui.input({ placeholder: t.goalNamePlaceholder, onCommit: () => { void addGoal(); } });
  const addBtn = ui.button(t.goalAdd, { size: 'sm', onClick: () => { void addGoal(); } });
  addBar.append(addInput, addBtn);
  const goalRows = ui.h('div', 'study-goals');
  goalsSheet.body.append(addBar, goalRows);

  const stats = ui.sheet({ title: t.statsTitle, en: 'stats' });
  const statsBar = ui.actions();
  const statsCards = ui.statgrid();
  const goalListTitle = ui.h('div', 'study-golist-title', t.goalListTitle);
  const statsGoals = ui.h('div', 'study-golist');
  const chartHost = ui.h('div', 'study-chart-host');
  stats.body.append(statsBar, statsCards, goalListTitle, statsGoals, chartHost);

  const sessions = ui.sheet({ title: t.sheetSessions, en: 'sessions' });
  const table = ui.table({ head: [t.headTime, t.headDuration, t.headGoal, t.headKind] });
  sessions.body.appendChild(table.el);

  const note = ui.msgline('', true);

  let latest: StudyState | null = null;
  let goals: StudyGoal[] = [];
  let goalsSignature = '';
  let renamingId: string | null = null;
  let period: StatsPeriod = 'day';
  let filter: string | null = null;
  let statsSignature = '';
  /** Ids and names of every goal seen this run, so a deleted one keeps its filter option. */
  const goalNames = new Map<string, string>();

  const goalSelect = ui.select({ options: [{ value: '', label: t.goalNone }] });
  const startBtn = ui.button(t.btnStart, { variant: 'primary', onClick: () => { void start(); } });
  const pauseBtn = ui.button(t.btnPause, { onClick: () => { void act('pause'); } });
  const resumeBtn = ui.button(t.btnResume, { onClick: () => { void act('resume'); } });
  const stopBtn = ui.button(t.btnStop, { variant: 'danger', onClick: () => { void act('stop'); } });
  controlBar.append(goalSelect, startBtn, pauseBtn, resumeBtn, stopBtn);

  const periods: readonly { value: StatsPeriod; label: string }[] = [
    { value: 'day', label: t.periodDay },
    { value: 'week', label: t.periodWeek },
    { value: 'month', label: t.periodMonth },
    { value: 'year', label: t.periodYear },
    { value: 'all', label: t.periodAll },
  ];
  const seg = ui.segmented(periods, {
    value: period,
    size: 'sm',
    onSelect: (value) => {
      period = value as StatsPeriod;
      statsSignature = '';
      void load();
    },
  });
  const filterSelect = ui.select({
    options: [{ value: ALL_GOALS, label: t.goalFilterAll }, { value: '', label: t.goalNone }],
    onChange: (value) => {
      filter = value === ALL_GOALS ? null : value;
      statsSignature = '';
      void load();
    },
  });
  filterSelect.setAttribute('aria-label', t.goalFilterLabel);
  statsBar.append(seg.el, filterSelect);

  if (deps.intro) root.append(deps.intro);
  root.append(cards, control.el, goalsSheet.el, stats.el, sessions.el, note);

  const kindLabel = (kind: StudySession['kind']) => (kind === 'manual' ? t.kindManual : t.kindAuto);
  const modeLabel = (mode: StudyState['mode']) =>
    (mode === 'auto' ? t.modeAuto : mode === 'manual' ? t.modeManual : t.modeBoth);

  function activeUnit(p: StatsPeriod): string {
    if (p === 'day') return t.unitHour;
    if (p === 'year') return t.unitMonth;
    if (p === 'all') return t.unitYear;
    return t.unitDay;
  }

  function goalError(error: GoalError): string {
    if (error === 'empty') return t.goalNameEmpty;
    if (error === 'duplicate') return t.goalDuplicate;
    if (error === 'tooLong') return t.goalTooLong;
    if (error === 'full') return t.goalFull;
    return t.goalMissing;
  }

  function renderState(d: StudyState): void {
    latest = d;
    const now = !d.focusing ? t.idle : d.paused ? `${t.paused} ${clock(d.seconds)}` : clock(d.seconds);
    cards.replaceChildren(
      ui.stat({ k: t.cardToday, v: span(d.todaySeconds) }),
      ui.stat({ k: t.cardNow, v: now, accent: d.focusing }),
      ui.stat({ k: t.cardGoal, v: d.goalName ?? t.goalNone }),
      ui.stat({ k: t.cardMode, v: modeLabel(d.mode) }),
    );
    // while a stretch runs, the goal is fixed; the controls switch to pause/resume/stop
    goalSelect.hidden = d.focusing;
    startBtn.hidden = d.focusing;
    pauseBtn.hidden = !d.focusing || d.paused;
    resumeBtn.hidden = !d.focusing || !d.paused;
    stopBtn.hidden = !d.focusing;
  }

  function renderHistory(h: StudyHistory): void {
    table.clear(h.sessions.length ? undefined : t.empty);
    for (const s of h.sessions) {
      table.addRow([
        { text: `${stamp(s.start)}–${stamp(s.end)}`, cls: 'mono' },
        { text: span(s.seconds), cls: 'mono' },
        { text: s.goalName ?? t.goalNone, cls: s.goal ? '' : 'muted' },
        { text: kindLabel(s.kind), cls: s.kind === 'manual' ? '' : 'muted' },
      ]);
    }
  }

  function renderGoalOptions(): void {
    for (const goal of goals) goalNames.set(goal.id, goal.name);
    const signature = goals.map((g) => `${g.id}:${g.name}`).join('|');
    if (signature === goalsSignature) return;
    goalsSignature = signature;
    const chosen = goalSelect.value;
    const options = [{ value: '', label: t.goalNone }, ...goals.map((g) => ({ value: g.id, label: g.name }))];
    goalSelect.replaceChildren(...options.map((o) => new Option(o.label, o.value)));
    goalSelect.value = options.some((o) => o.value === chosen) ? chosen : '';
  }

  function renderGoalRows(): void {
    // a row being renamed keeps its input while the two-second refetch runs
    if (renamingId !== null) return;
    goalRows.replaceChildren();
    if (!goals.length) {
      goalRows.appendChild(ui.placeholder(t.goalEmpty));
      return;
    }
    for (const goal of goals) goalRows.appendChild(goalRow(goal));
  }

  function goalRow(goal: StudyGoal): HTMLElement {
    const row = ui.h('div', 'study-goal-row');
    const swatch = ui.h('i', 'study-goal-swatch');
    swatch.style.background = goalColor(goal.id, goal.color, goals.indexOf(goal));
    const name = ui.h('span', 'study-goal-name', goal.name);
    const rename = ui.button(t.goalRename, { size: 'sm', onClick: () => beginRename(goal) });
    const del = ui.button(t.goalDelete, { size: 'sm', variant: 'danger', onClick: () => { void removeGoal(goal); } });
    row.append(swatch, name, rename, del);
    return row;
  }

  function beginRename(goal: StudyGoal): void {
    renamingId = goal.id;
    const row = goalRow(goal);
    row.replaceChildren();
    const input = ui.input({ value: goal.name, cls: 'study-goal-input', onCommit: () => { void commitRename(goal.id, input.value); } });
    const save = ui.button(t.goalSave, { size: 'sm', variant: 'primary', onClick: () => { void commitRename(goal.id, input.value); } });
    const cancel = ui.button(t.goalCancel, { size: 'sm', onClick: () => cancelRename() });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
    });
    row.append(input, save, cancel);
    const index = goals.findIndex((g) => g.id === goal.id);
    goalRows.replaceChild(row, goalRows.children[index]!);
    input.focus();
    input.select();
  }

  function cancelRename(): void {
    renamingId = null;
    renderGoalRows();
  }

  async function commitRename(id: string, name: string): Promise<void> {
    const done = await mutate<GoalMutation>('goalRename', [id, name]);
    if (done) { renamingId = null; renderGoalRows(); }
  }

  async function removeGoal(goal: StudyGoal): Promise<void> {
    const ok = await ui.confirm({ title: t.goalDeleteTitle, body: t.goalDeleteBody(goal.name), danger: true });
    if (!ok) return;
    await mutate<GoalMutation>('goalDelete', [goal.id]);
  }

  async function addGoal(): Promise<void> {
    const name = addInput.value;
    const done = await mutate<GoalMutation>('goalAdd', [name]);
    if (done?.goal) addInput.value = '';
  }

  /** Runs a goal mutation; false when it failed, so a rename keeps its input. */
  async function mutate<T extends GoalMutation>(method: string, args: unknown[]): Promise<T | null> {
    try {
      const result = await deps.invoke<T>(method, args);
      goals = result.goals;
      note.textContent = result.error ? goalError(result.error) : '';
      renderGoalOptions();
      renderGoalRows();
      await load();
      return result;
    } catch (err) {
      if (isAbort(err) || signal.aborted) return null;
      note.textContent = t.loadFailed(errText(err));
      return null;
    }
  }

  /** The filter's options: every goal seen, deleted ones included, and "no goal". */
  function renderFilterOptions(d: StudyStats): void {
    for (const total of d.goalTotals) if (total.goalId) goalNames.set(total.goalId, total.goalName);
    const signature = [...goalNames].map(([id, name]) => `${id}:${name}`).join('|');
    const current = filter ?? ALL_GOALS;
    if (filterSelect.dataset.signature === signature) return;
    filterSelect.dataset.signature = signature;
    const options = [
      { value: ALL_GOALS, label: t.goalFilterAll },
      { value: '', label: t.goalNone },
      ...[...goalNames].map(([id, name]) => ({ value: id, label: name })),
    ];
    filterSelect.replaceChildren(...options.map((o) => new Option(o.label, o.value)));
    filterSelect.value = options.some((o) => o.value === current) ? current : ALL_GOALS;
    if (!options.some((o) => o.value === current)) filter = null;
  }

  function chartSeries(d: StudyStats): ChartSeries[] | undefined {
    if (!d.hasGoals) return undefined;
    return d.goalTotals
      .filter((g) => g.seconds > 0 && (filter === null || g.goalId === filter))
      .map((g) => ({
        key: g.goalId,
        label: g.goalName || t.goalNone,
        // the same position the goal has in the list below the cards
        color: goalColor(g.goalId, g.color, d.goalTotals.indexOf(g)),
      }));
  }

  function renderStats(d: StudyStats): void {
    renderFilterOptions(d);
    const signature = `${d.period}|${filter ?? ALL_GOALS}|${d.totalSeconds}|${d.sessionCount}|${d.longestSeconds}|${d.activeBuckets}|`
      + d.goalTotals.map((g) => `${g.goalId},${g.goalName},${g.seconds},${g.color},${g.deleted}`).join(';')
      + '|' + d.buckets.map((b) => `${b.label},${b.seconds},${b.auto},${b.manual},${JSON.stringify(b.goals ?? null)}`).join(';');
    if (signature === statsSignature) return;
    statsSignature = signature;
    statsCards.replaceChildren(
      ui.stat({ k: t.cardTotal, v: span(d.totalSeconds), accent: d.totalSeconds > 0 }),
      ui.stat({ k: t.cardSessions, v: String(d.sessionCount) }),
      ui.stat({ k: t.cardLongest, v: span(d.longestSeconds) }),
      ui.stat({ k: t.cardActive, v: `${d.activeBuckets} ${activeUnit(d.period)}` }),
    );
    statsGoals.replaceChildren();
    for (const goal of d.goalTotals) {
      const row = ui.h('div', 'study-golist-row');
      const swatch = ui.h('i', 'study-goal-swatch');
      swatch.style.background = goalColor(goal.goalId, goal.color, d.goalTotals.indexOf(goal));
      const name = ui.h('span', 'study-golist-name', `${goal.goalName || t.goalNone}${goal.deleted ? ` ${t.goalDeleted}` : ''}`);
      const value = ui.h('span', 'study-golist-value', span(goal.seconds));
      row.append(swatch, name, value);
      statsGoals.appendChild(row);
    }
    chartHost.replaceChildren(
      focusChart(chartHost.ownerDocument, d.buckets, {
        empty: t.chartEmpty,
        auto: t.kindAuto,
        manual: t.kindManual,
      }, chartSeries(d)),
    );
  }

  let generation = 0;
  async function load(): Promise<void> {
    const mine = ++generation;
    const wanted = period;
    const wantedFilter = filter;
    try {
      const [state, history, stats, goalList] = await Promise.all([
        deps.invoke<StudyState>('state'),
        deps.invoke<StudyHistory>('history'),
        deps.invoke<StudyStats>('stats', [wanted, wantedFilter]),
        deps.invoke<StudyGoal[]>('goals'),
      ]);
      if (signal.aborted || mine !== generation) return;
      note.textContent = '';
      goals = goalList;
      renderState(state);
      renderGoalOptions();
      renderGoalRows();
      renderHistory(history);
      // the segmented control or the filter may have moved on while this batch was in flight
      if (wanted === period && wantedFilter === filter) renderStats(stats);
    } catch (err) {
      if (isAbort(err) || signal.aborted || mine !== generation) return;
      note.textContent = t.loadFailed(errText(err));
    }
  }

  async function start(): Promise<void> {
    try {
      renderState(await deps.invoke<StudyState>('start', [goalSelect.value || null]));
      await load();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      note.textContent = t.loadFailed(errText(err));
    }
  }

  async function act(method: 'pause' | 'resume' | 'stop'): Promise<void> {
    try {
      renderState(await deps.invoke<StudyState>(method));
      await load();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      note.textContent = t.loadFailed(errText(err));
    }
  }

  cards.appendChild(ui.placeholder(t.loading));
  statsCards.appendChild(ui.placeholder(t.loading));
  deps.interval(() => void load(), LIVE_MS);
  void load();
}
