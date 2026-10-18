import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appLabel, classify, dayKey, FocusLedger, normalize, studyDefaults } from '../core/study-sessions.ts';

const STUDY = ['code', 'typora', 'notion'];
const DISTRACT = ['bilibili', 'youtube'];

describe('classify', () => {
  it('reads a null window as other', () => {
    expect(classify(null, STUDY, DISTRACT)).toBe('other');
  });

  it('matches a study app by process name, case-insensitively', () => {
    expect(classify({ title: 'readme.txt', pid: 1, processName: 'Code.exe' }, STUDY, DISTRACT)).toBe('study');
  });

  it('matches a study app by a word in the title', () => {
    expect(classify({ title: 'my notes — Typora', pid: 2, processName: null }, STUDY, DISTRACT)).toBe('study');
  });

  it('matches a distractor by process name', () => {
    expect(classify({ title: 'Steam', pid: 3, processName: 'bilibili.exe' }, STUDY, DISTRACT)).toBe('distract');
  });

  it('prefers study over distract when both match', () => {
    expect(classify({ title: 'notion', pid: 4, processName: 'youtube.exe' }, STUDY, DISTRACT)).toBe('study');
  });

  it('reads an unmatched window as other', () => {
    expect(classify({ title: 'explorer', pid: 5, processName: 'explorer.exe' }, STUDY, DISTRACT)).toBe('other');
  });
});

describe('normalize', () => {
  it('fills every field from the defaults when absent', () => {
    expect(normalize(undefined)).toEqual(studyDefaults());
  });

  it('keeps a partial section and raises checkMax to the minimum', () => {
    const cfg = normalize({ checkMinMin: 90, checkMaxMin: 10, enabled: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.checkMinMin).toBe(90);
    expect(cfg.checkMaxMin).toBe(90);
  });

  it('drops empty app entries and falls back when a list is empty', () => {
    const cfg = normalize({ studyApps: ['  ', ''], distractorApps: ['bilibili'] });
    expect(cfg.studyApps).toEqual(studyDefaults().studyApps);
    expect(cfg.distractorApps).toEqual(['bilibili']);
  });
});

describe('dayKey', () => {
  it('formats a timestamp in the given timezone', () => {
    expect(dayKey('UTC', 0)).toBe('1970-01-01');
  });
});

describe('appLabel', () => {
  it('falls back to a question mark with no window', () => {
    expect(appLabel(null)).toBe('?');
  });

  it('prefers the title and cuts it to 40 characters', () => {
    expect(appLabel({ title: 'x'.repeat(60), pid: 1, processName: 'p' })).toBe('x'.repeat(40));
  });

  it('uses the process name when the title is empty', () => {
    expect(appLabel({ title: '  ', pid: 1, processName: 'code.exe' })).toBe('code.exe');
  });
});

describe('FocusLedger', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'coo-study-'));
  const session = (start: number, seconds: number, kind: 'auto' | 'manual' = 'auto') => ({ start, end: start + seconds * 1000, seconds, kind });

  it('appends and reads sessions back, skipping non-positive ones', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(1000, 30));
    ledger.append(session(2000, 0));
    expect(ledger.readAll()).toEqual([session(1000, 30)]);
  });

  it("summarizes only today's sessions in the timezone", () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    const now = Date.UTC(2026, 9, 17, 12, 0, 0);
    const todayStart = Date.UTC(2026, 9, 17, 9, 0, 0);
    const yesterdayStart = Date.UTC(2026, 9, 16, 9, 0, 0);
    ledger.append(session(todayStart, 60));
    ledger.append(session(yesterdayStart, 30));
    const sum = ledger.summarize('UTC', now);
    expect(sum.todaySeconds).toBe(60);
    expect(sum.sessions).toEqual([session(todayStart, 60)]);
  });

  it('returns the most recent sessions first', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(1000, 10));
    ledger.append(session(2000, 20));
    expect(ledger.recent(10).map((s) => s.seconds)).toEqual([20, 10]);
  });

  it('skips a torn last line', () => {
    const file = join(dir(), 'focus.jsonl');
    writeFileSync(file, '{"start":1,"end":2,"seconds":10,"kind":"auto"}\n{"start":3,"end":4,"seconds":');
    expect(new FocusLedger(file).readAll()).toEqual([{ start: 1, end: 2, seconds: 10, kind: 'auto' }]);
  });

  it('reads goal stamps, falling back to the id and leaving old rows untouched', () => {
    const file = join(dir(), 'focus.jsonl');
    writeFileSync(file, [
      '{"start":1,"end":2,"seconds":10,"kind":"auto"}',
      '{"start":3,"end":4,"seconds":20,"kind":"manual","goal":"g1","goalName":"Coding"}',
      '{"start":5,"end":6,"seconds":30,"kind":"manual","goal":"g2"}',
      '{"start":7,"end":8,"seconds":40,"kind":"manual","goal":7}',
      '',
    ].join('\n'));
    expect(new FocusLedger(file).readAll()).toEqual([
      { start: 1, end: 2, seconds: 10, kind: 'auto' },
      { start: 3, end: 4, seconds: 20, kind: 'manual', goal: 'g1', goalName: 'Coding' },
      { start: 5, end: 6, seconds: 30, kind: 'manual', goal: 'g2', goalName: 'g2' },
      { start: 7, end: 8, seconds: 40, kind: 'manual' },
    ]);
  });
});

describe('FocusLedger.stats', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'coo-study-'));
  const at = (y: number, m: number, d: number, h = 12, min = 0): number => Date.UTC(y, m - 1, d, h, min);
  const session = (start: number, seconds: number, kind: 'auto' | 'manual' = 'auto') => ({ start, end: start + seconds * 1000, seconds, kind });
  // Saturday noon, so the last 7 days span one of every weekday
  const NOW = at(2026, 10, 17);

  it("buckets today's focus by hour, split by kind", () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(at(2026, 10, 17, 9, 15), 600));
    ledger.append(session(at(2026, 10, 17, 9, 45), 300, 'manual'));
    ledger.append(session(at(2026, 10, 17, 10, 20), 120));
    ledger.append(session(at(2026, 10, 16, 9, 0), 999));
    const stats = ledger.stats('day', 'UTC', 'en', NOW);
    expect(stats).toMatchObject({
      period: 'day', totalSeconds: 1020, sessionCount: 3, longestSeconds: 600, activeBuckets: 2,
    });
    expect(stats.buckets).toHaveLength(24);
    expect(stats.buckets[0]!.label).toBe('00');
    expect(stats.buckets.find((b) => b.label === '09')).toEqual({ label: '09', seconds: 900, auto: 600, manual: 300 });
    expect(stats.buckets[23]!.label).toBe('23');
  });

  it('puts a session in the local day of its timezone', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    // 23:30 on the 16th in UTC is 07:30 on the 17th in Shanghai
    ledger.append(session(Date.UTC(2026, 9, 16, 23, 30), 60));
    const utc = ledger.stats('day', 'UTC', 'en', NOW);
    expect(utc.totalSeconds).toBe(0);
    const shanghai = ledger.stats('day', 'Asia/Shanghai', 'en', NOW);
    expect(shanghai.totalSeconds).toBe(60);
    expect(shanghai.buckets.find((b) => b.label === '07')?.seconds).toBe(60);
  });

  it('covers the last 7 days with weekday labels and drops older sessions', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(at(2026, 10, 17, 9), 60));
    ledger.append(session(at(2026, 10, 11, 9), 30));
    ledger.append(session(at(2026, 10, 9, 9), 120));
    const stats = ledger.stats('week', 'UTC', 'en', NOW);
    expect(stats.totalSeconds).toBe(90);
    expect(stats.activeBuckets).toBe(2);
    expect(stats.buckets.map((b) => b.label)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('covers the last 30 days with day-of-month labels', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(at(2026, 10, 1, 9), 60));
    ledger.append(session(at(2026, 8, 31, 9), 60));
    const stats = ledger.stats('month', 'UTC', 'en', NOW);
    expect(stats.buckets).toHaveLength(30);
    expect(stats.buckets[0]!.label).toBe('18');
    expect(stats.buckets.at(-1)!.label).toBe('17');
    expect(stats.totalSeconds).toBe(60);
    expect(stats.buckets.find((b) => b.label === '1')?.seconds).toBe(60);
  });

  it('covers the last 12 months with localized month labels', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(at(2026, 3, 5, 9), 600));
    ledger.append(session(at(2025, 1, 1, 9), 600));
    const en = ledger.stats('year', 'UTC', 'en', NOW);
    expect(en.buckets).toHaveLength(12);
    expect(en.buckets[0]!.label).toBe('Nov');
    expect(en.buckets.at(-1)!.label).toBe('Oct');
    expect(en.buckets.find((b) => b.label === 'Mar')?.seconds).toBe(600);
    expect(en.totalSeconds).toBe(600);
    expect(ledger.stats('year', 'UTC', 'zh', NOW).buckets.at(-1)!.label).toBe('10月');
  });

  it('covers every year on record for all time', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(at(2024, 5, 1, 9), 60));
    ledger.append(session(at(2026, 5, 1, 9), 120, 'manual'));
    const stats = ledger.stats('all', 'UTC', 'en', NOW);
    expect(stats.buckets.map((b) => b.label)).toEqual(['2024', '2025', '2026']);
    expect(stats.buckets.map((b) => b.seconds)).toEqual([60, 0, 120]);
    expect(stats.buckets[2]).toEqual({ label: '2026', seconds: 120, auto: 0, manual: 120 });
    expect(stats.totalSeconds).toBe(180);
    expect(stats.activeBuckets).toBe(2);
  });

  it('draws the empty span when nothing is recorded', () => {
    const stats = new FocusLedger(join(dir(), 'focus.jsonl')).stats('day', 'UTC', 'en', NOW);
    expect(stats).toMatchObject({ totalSeconds: 0, sessionCount: 0, longestSeconds: 0, activeBuckets: 0 });
    expect(stats.buckets).toHaveLength(24);
    expect(stats.buckets.every((b) => b.seconds === 0)).toBe(true);
  });

  it('breaks the span down by goal, without a goals key on legacy buckets', () => {
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(session(at(2026, 10, 17, 9, 15), 600));
    ledger.append(session(at(2026, 10, 17, 9, 45), 300, 'manual'));
    const stats = ledger.stats('day', 'UTC', 'en', NOW);
    expect(stats.hasGoals).toBe(false);
    expect(stats.goalTotals).toEqual([{ goalId: '', goalName: '', seconds: 900 }]);
    expect(stats.buckets.find((b) => b.label === '09')).toEqual({ label: '09', seconds: 900, auto: 600, manual: 300 });
  });

  it('totals and colors by goal, and filters sessions by one', () => {
    const goal = (start: number, seconds: number, id: string, name: string) =>
      ({ start, end: start + seconds * 1000, seconds, kind: 'manual' as const, goal: id, goalName: name });
    const ledger = new FocusLedger(join(dir(), 'focus.jsonl'));
    ledger.append(goal(at(2026, 10, 17, 9, 15), 600, 'g1', 'Coding'));
    ledger.append(goal(at(2026, 10, 17, 9, 45), 300, 'g2', 'Reading'));
    ledger.append(goal(at(2026, 10, 17, 10, 0), 120, 'g1', 'Code'));
    ledger.append(session(at(2026, 10, 17, 10, 30), 60));

    const all = ledger.stats('day', 'UTC', 'en', NOW);
    expect(all).toMatchObject({ totalSeconds: 1080, sessionCount: 4, longestSeconds: 600, activeBuckets: 2, hasGoals: true });
    // the latest snapshot names the goal, sessions without one come last
    expect(all.goalTotals).toEqual([
      { goalId: 'g1', goalName: 'Code', seconds: 720 },
      { goalId: 'g2', goalName: 'Reading', seconds: 300 },
      { goalId: '', goalName: '', seconds: 60 },
    ]);
    expect(all.buckets.find((b) => b.label === '09')).toEqual({
      label: '09', seconds: 900, auto: 0, manual: 900, goals: { g1: 600, g2: 300 },
    });
    expect(all.buckets.find((b) => b.label === '10')).toEqual({
      label: '10', seconds: 180, auto: 60, manual: 120, goals: { g1: 120, '': 60 },
    });

    const coding = ledger.stats('day', 'UTC', 'en', NOW, 'g1');
    expect(coding).toMatchObject({ totalSeconds: 720, sessionCount: 2, activeBuckets: 2 });
    expect(coding.buckets.find((b) => b.label === '09')?.goals).toEqual({ g1: 600 });
    // the breakdown still covers the whole span, whatever the filter
    expect(coding.goalTotals).toHaveLength(3);

    const ungoaled = ledger.stats('day', 'UTC', 'en', NOW, '');
    expect(ungoaled).toMatchObject({ totalSeconds: 60, sessionCount: 1, activeBuckets: 1 });
    expect(ungoaled.buckets.find((b) => b.label === '10')?.goals).toEqual({ '': 60 });

    const missing = ledger.stats('day', 'UTC', 'en', NOW, 'g9');
    expect(missing).toMatchObject({ totalSeconds: 0, sessionCount: 0, activeBuckets: 0 });
  });
});
