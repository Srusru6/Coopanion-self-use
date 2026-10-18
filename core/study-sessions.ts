/**
 * The `study` World's reading and arithmetic: what the foreground window is, whether it counts as
 * studying, and the focus sessions recorded to disk.
 *
 * Privacy: only the foreground window's title and process name are read, matched locally against
 * the configured study/distractor app lists. Nothing leaves the machine.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Language } from 'cortico/core/language.ts';

/** The foreground window: its title, its process id, and the process's executable name. */
export interface ForegroundInfo {
  title: string;
  pid: number;
  processName: string | null;
}

/** One `worlds.study` config section; `enabled` is the framework's mount switch. */
export interface StudyConfig {
  enabled: boolean;
  /** A check happens at a random time this many minutes after the last one. */
  checkMinMin: number;
  checkMaxMin: number;
  /** App names (process name or a word in the title) that count as studying. */
  studyApps: string[];
  /** App names that count as distraction. */
  distractorApps: string[];
  /** Whether focus is counted automatically, by hand, or both. */
  focusMode: 'auto' | 'manual' | 'both';
  /** A distraction that lasts this long raises the reminder. */
  idleGraceMin: number;
}

/** How the foreground window reads: studying, distracting, or neither. */
export type FocusClass = 'study' | 'distract' | 'other';

/** A closed focus stretch. */
export interface FocusSession {
  start: number;
  end: number;
  seconds: number;
  kind: 'auto' | 'manual';
  /** The goal's id; absent on automatic and ungoaled stretches, and on records from before goals. */
  goal?: string;
  /** The goal's name when the stretch closed, so renaming or deleting it leaves history readable. */
  goalName?: string;
}

/** Today's recorded focus, with the sessions that made it up. */
export interface FocusSummary {
  todaySeconds: number;
  sessions: FocusSession[];
}

/** The spans the statistics view can show. */
export type StatsPeriod = 'day' | 'week' | 'month' | 'year' | 'all';

/** One bar of the stats chart: focus in one hour, day, month or year. */
export interface StatsBucket {
  /** The axis label, localized: an hour `09`, a weekday `Mon`, a day `18`, a month `Oct`, a year `2026`. */
  label: string;
  seconds: number;
  auto: number;
  manual: number;
  /** Seconds by goal id (`''` for no goal); only present when the span holds goal-stamped sessions. */
  goals?: Record<string, number>;
}

/** Focus in the span that belongs to one goal, or to no goal (`goalId: ''`). */
export interface GoalTotal {
  goalId: string;
  goalName: string;
  seconds: number;
}

export interface FocusStats {
  period: StatsPeriod;
  totalSeconds: number;
  sessionCount: number;
  longestSeconds: number;
  /** Buckets that hold focus; the page names the unit by the period (hours, days, months, years). */
  activeBuckets: number;
  /** Oldest first, every bucket of the span, empty ones included. */
  buckets: StatsBucket[];
  /** The whole span by goal, ignoring the goal filter; sessions without a goal last. */
  goalTotals: GoalTotal[];
  /** Whether the span holds any goal-stamped sessions, which turns the chart goal-coloured. */
  hasGoals: boolean;
}

const DAY_MS = 86_400_000;

/** The locale `Intl` names use for a language, so weekday and month labels read the person's way. */
function localeOf(language: Language): string {
  if (language === 'zh') return 'zh-CN';
  if (language === 'zh-Hant') return 'zh-TW';
  return language;
}

function partsIn(timezone: string, ms: number, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts }).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

function yearOf(timezone: string, ms: number): string {
  return partsIn(timezone, ms, { year: 'numeric' }).year ?? '';
}

function monthOf(timezone: string, ms: number): string {
  const p = partsIn(timezone, ms, { year: 'numeric', month: '2-digit' });
  return `${p.year}-${p.month}`;
}

function hourOf(timezone: string, ms: number): string {
  return partsIn(timezone, ms, { hour: '2-digit', hourCycle: 'h23' }).hour ?? '00';
}

/** The key a session falls into for a period: its hour, day, month or year. */
function bucketKey(period: StatsPeriod, timezone: string, ms: number): string {
  if (period === 'day') return `${dayKey(timezone, ms)}T${hourOf(timezone, ms)}`;
  if (period === 'year') return monthOf(timezone, ms);
  if (period === 'all') return yearOf(timezone, ms);
  return dayKey(timezone, ms);
}

/** `monthName(2)` is the short February label in `locale`. */
function monthName(locale: string, month: number): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2020, month - 1, 15)));
}

function weekdayName(locale: string, key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** The last `days` calendar dates up to today, as `YYYY-MM-DD`, oldest first. */
function calendarDays(timezone: string, now: number, days: number): string[] {
  const [y, m, d] = dayKey(timezone, now).split('-').map(Number);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const at = new Date(Date.UTC(y!, m! - 1, d! - i));
    out.push(`${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

/** The buckets of a span, oldest first; the chart shows all of them, empty ones as no bar. */
function planBuckets(period: StatsPeriod, timezone: string, language: Language, now: number, firstStart: number | null): Array<{ key: string; label: string }> {
  const locale = localeOf(language);
  if (period === 'day') {
    const today = dayKey(timezone, now);
    return Array.from({ length: 24 }, (_, h) => {
      const hour = String(h).padStart(2, '0');
      return { key: `${today}T${hour}`, label: hour };
    });
  }
  if (period === 'week' || period === 'month') {
    const days = period === 'week' ? 7 : 30;
    return calendarDays(timezone, now, days).map((key) => ({
      key,
      label: period === 'week' ? weekdayName(locale, key) : String(Number(key.slice(8, 10))),
    }));
  }
  if (period === 'year') {
    const p = partsIn(timezone, now, { year: 'numeric', month: '2-digit' });
    const current = Number(p.year) * 12 + Number(p.month) - 1;
    return Array.from({ length: 12 }, (_, i) => {
      const index = current - (11 - i);
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      return { key: `${year}-${String(month).padStart(2, '0')}`, label: monthName(locale, month) };
    });
  }
  const end = Number(yearOf(timezone, now));
  const start = firstStart === null ? end : Number(yearOf(timezone, firstStart));
  return Array.from({ length: Math.max(1, end - start + 1) }, (_, i) => {
    const year = start + i;
    return { key: String(year), label: String(year) };
  });
}

const DEFAULT_STUDY_APPS = ['code', 'typora', 'notion', 'obsidian', 'sumatrapdf', 'zed', 'vim', 'neovim', 'intellij', 'pycharm', 'visual studio'];
const DEFAULT_DISTRACTOR_APPS = ['bilibili', 'youtube', 'douyu', 'steam', 'epic', 'douyin', '抖音', 'weibo', '小红书'];

/** The defaults `studyDefinition` installs; a fresh section, so `defaults()` can hand it out as is. */
export function studyDefaults(): StudyConfig {
  return {
    enabled: true,
    checkMinMin: 15,
    checkMaxMin: 40,
    studyApps: [...DEFAULT_STUDY_APPS],
    distractorApps: [...DEFAULT_DISTRACTOR_APPS],
    focusMode: 'both',
    idleGraceMin: 5,
  };
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

function list(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  const out = v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  return out.length ? out : [...fallback];
}

/** A config section as the live object has it, with every field filled in; a partial or absent section reads the defaults. */
export function normalize(cfg: Partial<StudyConfig> | undefined): StudyConfig {
  const base = studyDefaults();
  const min = num(cfg?.checkMinMin, base.checkMinMin, 1, 24 * 60);
  const max = num(cfg?.checkMaxMin, base.checkMaxMin, 1, 24 * 60);
  return {
    enabled: cfg?.enabled !== false,
    checkMinMin: min,
    checkMaxMin: Math.max(min, max),
    studyApps: list(cfg?.studyApps, base.studyApps),
    distractorApps: list(cfg?.distractorApps, base.distractorApps),
    focusMode: cfg?.focusMode === 'auto' || cfg?.focusMode === 'manual' ? cfg.focusMode : 'both',
    idleGraceMin: num(cfg?.idleGraceMin, base.idleGraceMin, 0, 24 * 60),
  };
}

/** Case-insensitive substring match of `needle` in any of `fields`. */
function hit(needle: string, ...fields: Array<string | null | undefined>): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  return fields.some((f) => f != null && f.toLowerCase().includes(n));
}

/** What the foreground window is for the configured lists; a window with no match reads `other`. */
export function classify(fg: ForegroundInfo | null, studyApps: string[], distractorApps: string[]): FocusClass {
  if (!fg) return 'other';
  if (studyApps.some((n) => hit(n, fg.processName, fg.title))) return 'study';
  if (distractorApps.some((n) => hit(n, fg.processName, fg.title))) return 'distract';
  return 'other';
}

/** `YYYY-MM-DD` in `timezone`. */
export function dayKey(timezone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The app name to show a person, cut to a line. */
export function appLabel(fg: ForegroundInfo | null): string {
  const raw = (fg?.title.trim() || fg?.processName?.trim() || '');
  return raw ? raw.slice(0, 40) : '?';
}

/**
 * An append-only ledger of focus sessions, one JSON line each, at `dataDir/focus.jsonl`. A torn
 * last line is skipped on read, so a crash mid-append costs one session, not the file.
 */
export class FocusLedger {
  private pending: FocusSession[] = [];

  constructor(private readonly file: string, private readonly report: (message: string) => void = console.error) {}

  append(session: FocusSession): void {
    if (session.seconds <= 0) return;
    this.pending.push({ ...session });
    this.flush();
  }

  private flush(): void {
    if (!this.pending.length) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      while (this.pending.length) {
        appendFileSync(this.file, `${JSON.stringify(this.pending[0])}\n`, 'utf8');
        this.pending.shift();
      }
    } catch (error) {
      this.report(`Focus ledger ${this.file}: ${String(error)}`);
    }
  }

  readAll(): FocusSession[] {
    let lines: string[] = [];
    try {
      lines = existsSync(this.file) ? readFileSync(this.file, 'utf8').split(/\r?\n/) : [];
    } catch (error) {
      this.report(String(error));
      return [];
    }
    const out: FocusSession[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as FocusSession;
        if (typeof r.start === 'number' && typeof r.end === 'number' && typeof r.seconds === 'number' && (r.kind === 'auto' || r.kind === 'manual')) {
          const session: FocusSession = { start: r.start, end: r.end, seconds: r.seconds, kind: r.kind };
          // old records have no goal at all; do not add `undefined` keys to them
          if (typeof r.goal === 'string' && r.goal) {
            session.goal = r.goal;
            session.goalName = typeof r.goalName === 'string' && r.goalName ? r.goalName : r.goal;
          }
          out.push(session);
        }
      } catch { /* torn line */ }
    }
    return out;
  }

  /** Today's sessions in `timezone`, oldest first. */
  summarize(timezone: string, now = Date.now()): FocusSummary {
    const today = dayKey(timezone, now);
    const sessions = this.readAll().filter((s) => dayKey(timezone, s.start) === today);
    return { todaySeconds: sessions.reduce((sum, s) => sum + s.seconds, 0), sessions };
  }

  /** The most recent sessions, newest first. */
  recent(limit: number): FocusSession[] {
    return this.readAll().reverse().slice(0, limit);
  }

  /**
   * Focus in the span `period` ending now, split into buckets the chart draws: hours of today,
   * the last 7 or 30 days, the last 12 months, or every year on record. A session counts toward
   * the bucket its start falls in, by `kind` as well as in all.
   */
  stats(
    period: StatsPeriod,
    timezone: string,
    language: Language,
    now = Date.now(),
    goalFilter: string | null = null,
  ): FocusStats {
    const all = this.readAll();
    let firstStart: number | null = null;
    for (const s of all) firstStart = firstStart === null ? s.start : Math.min(firstStart, s.start);
    const plan = planBuckets(period, timezone, language, now, firstStart);
    const buckets = new Map(plan.map((p) => [p.key, { label: p.label, seconds: 0, auto: 0, manual: 0 } as StatsBucket]));

    // the per-goal breakdown covers the whole span, whatever the filter shows
    const totals = new Map<string, GoalTotal>();
    let hasGoals = false;
    for (const s of all) {
      if (!buckets.has(bucketKey(period, timezone, s.start))) continue;
      const key = s.goal ?? '';
      if (key) hasGoals = true;
      const total = totals.get(key) ?? { goalId: key, goalName: key ? (s.goalName ?? key) : '', seconds: 0 };
      // the latest snapshot is the name the goal had most recently
      if (key && s.goalName) total.goalName = s.goalName;
      total.seconds += s.seconds;
      totals.set(key, total);
    }

    let totalSeconds = 0;
    let sessionCount = 0;
    let longestSeconds = 0;
    for (const s of all) {
      const bucket = buckets.get(bucketKey(period, timezone, s.start));
      if (!bucket) continue;
      const key = s.goal ?? '';
      if (goalFilter !== null && key !== goalFilter) continue;
      totalSeconds += s.seconds;
      sessionCount += 1;
      longestSeconds = Math.max(longestSeconds, s.seconds);
      bucket.seconds += s.seconds;
      bucket[s.kind] += s.seconds;
      if (hasGoals) {
        bucket.goals ??= {};
        bucket.goals[key] = (bucket.goals[key] ?? 0) + s.seconds;
      }
    }

    const goalTotals = [...totals.values()].filter((t) => t.seconds > 0);
    const ungoaled = goalTotals.filter((t) => t.goalId === '');
    const named = goalTotals.filter((t) => t.goalId !== '').sort((a, b) => b.seconds - a.seconds);
    const ordered = plan.map((p) => buckets.get(p.key)!);
    return {
      period,
      totalSeconds,
      sessionCount,
      longestSeconds,
      activeBuckets: ordered.filter((b) => b.seconds > 0).length,
      buckets: ordered,
      goalTotals: [...named, ...ungoaled],
      hasGoals,
    };
  }
}
