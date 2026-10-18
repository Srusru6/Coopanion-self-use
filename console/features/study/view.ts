/**
 * The study dashboard, shared by the settings window's page and the World panel: today's focus
 * time, whether a stretch is open right now, a button to count focus by hand, the focus statistics
 * chart (today, last 7 days, last 30 days, last 12 months, all time) and the recent sessions.
 *
 * Both hosts hand in the same `WebUi` and `invoke`, so the two renderings cannot drift apart.
 */
import type { WebUi } from 'cortico/web/shared/client-panel.ts';
import { focusChart } from './chart.ts';
import type { StudyStrings } from './strings.ts';

export type StatsPeriod = 'day' | 'week' | 'month' | 'year' | 'all';

export interface StudySession {
  start: number;
  end: number;
  seconds: number;
  kind: 'auto' | 'manual';
}

export interface StudyState {
  focusing: boolean;
  kind: 'auto' | 'manual' | null;
  seconds: number;
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
}

export interface StudyStats {
  period: StatsPeriod;
  totalSeconds: number;
  sessionCount: number;
  longestSeconds: number;
  activeBuckets: number;
  buckets: StatsBucket[];
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
  const bar = ui.actions();
  control.body.append(bar);

  const stats = ui.sheet({ title: t.statsTitle, en: 'stats' });
  const statsBar = ui.actions();
  const statsCards = ui.statgrid();
  const chartHost = ui.h('div', 'study-chart-host');
  stats.body.append(statsBar, statsCards, chartHost);

  const sessions = ui.sheet({ title: t.sheetSessions, en: 'sessions' });
  const table = ui.table({ head: [t.headTime, t.headDuration, t.headKind] });
  sessions.body.appendChild(table.el);

  const note = ui.msgline('', true);

  let latest: StudyState | null = null;
  let period: StatsPeriod = 'day';
  let statsSignature = '';

  const btn = ui.button(t.btnStart, { variant: 'primary', onClick: () => { void toggle(); } });
  bar.append(btn);

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
  statsBar.append(seg.el);

  if (deps.intro) root.append(deps.intro);
  root.append(cards, stats.el, control.el, sessions.el, note);

  const kindLabel = (kind: StudySession['kind']) => (kind === 'manual' ? t.kindManual : t.kindAuto);
  const modeLabel = (mode: StudyState['mode']) =>
    (mode === 'auto' ? t.modeAuto : mode === 'manual' ? t.modeManual : t.modeBoth);

  function activeUnit(p: StatsPeriod): string {
    if (p === 'day') return t.unitHour;
    if (p === 'year') return t.unitMonth;
    if (p === 'all') return t.unitYear;
    return t.unitDay;
  }

  function renderState(d: StudyState): void {
    latest = d;
    cards.replaceChildren(
      ui.stat({ k: t.cardToday, v: span(d.todaySeconds) }),
      ui.stat({ k: t.cardNow, v: d.focusing ? clock(d.seconds) : t.idle, accent: d.focusing }),
      ui.stat({ k: t.cardMode, v: modeLabel(d.mode) }),
    );
    btn.textContent = d.focusing ? t.btnStop : t.btnStart;
  }

  function renderHistory(h: StudyHistory): void {
    table.clear(h.sessions.length ? undefined : t.empty);
    for (const s of h.sessions) {
      table.addRow([
        { text: `${stamp(s.start)}–${stamp(s.end)}`, cls: 'mono' },
        { text: span(s.seconds), cls: 'mono' },
        { text: kindLabel(s.kind), cls: s.kind === 'manual' ? '' : 'muted' },
      ]);
    }
  }

  function renderStats(d: StudyStats): void {
    const signature = `${d.period}|${d.totalSeconds}|${d.sessionCount}|${d.longestSeconds}|${d.activeBuckets}|`
      + d.buckets.map((b) => `${b.label},${b.seconds},${b.auto},${b.manual}`).join(';');
    if (signature === statsSignature) return;
    statsSignature = signature;
    statsCards.replaceChildren(
      ui.stat({ k: t.cardTotal, v: span(d.totalSeconds), accent: d.totalSeconds > 0 }),
      ui.stat({ k: t.cardSessions, v: String(d.sessionCount) }),
      ui.stat({ k: t.cardLongest, v: span(d.longestSeconds) }),
      ui.stat({ k: t.cardActive, v: `${d.activeBuckets} ${activeUnit(d.period)}` }),
    );
    chartHost.replaceChildren(
      focusChart(chartHost.ownerDocument, d.buckets, {
        empty: t.chartEmpty,
        auto: t.kindAuto,
        manual: t.kindManual,
      }),
    );
  }

  let generation = 0;
  async function load(): Promise<void> {
    const mine = ++generation;
    const wanted = period;
    try {
      const [state, history, stats] = await Promise.all([
        deps.invoke<StudyState>('state'),
        deps.invoke<StudyHistory>('history'),
        deps.invoke<StudyStats>('stats', [wanted]),
      ]);
      if (signal.aborted || mine !== generation) return;
      note.textContent = '';
      renderState(state);
      renderHistory(history);
      // the segmented control may have moved on while this batch was in flight
      if (wanted === period) renderStats(stats);
    } catch (err) {
      if (isAbort(err) || signal.aborted || mine !== generation) return;
      note.textContent = t.loadFailed(errText(err));
    }
  }

  async function toggle(): Promise<void> {
    const method = latest?.focusing ? 'stop' : 'start';
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
