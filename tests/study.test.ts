import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyWorld } from '../core/study.ts';
import { studyDefaults, type ForegroundInfo, type StudyConfig } from '../core/study-sessions.ts';
import { FocusGoals } from '../core/study-goals.ts';

interface Seen {
  events: { type: string; text: string }[];
  ambient: { active: boolean; text: string }[];
  alerts: { id: number; kind: string; text: string }[];
  cleared: number[];
}

/** A world over a scripted foreground, counting what it asks the pet and Coo to do. */
function makeWorld(script: (ForegroundInfo | null)[], cfg: Partial<StudyConfig> = {}) {
  const seen: Seen = { events: [], ambient: [], alerts: [], cleared: [] };
  const dir = mkdtempSync(join(tmpdir(), 'coo-study-world-'));
  let i = 0;
  const goals = new FocusGoals(join(dir, 'focus-goals.json'), () => {});
  const world = new StudyWorld({
    read: (path) => (path === 'language' ? 'zh' : undefined),
    foreground: () => Promise.resolve(script[Math.min(i++, script.length - 1)] ?? null),
    ambient: (status) => { seen.ambient.push({ active: status.active, text: status.text }); },
    alert: (id, kind, text) => { seen.alerts.push({ id, kind, text }); },
    alertClear: (id) => { seen.cleared.push(id); },
    label: () => '学习监督',
  }, { ...studyDefaults(), checkMinMin: 15, checkMaxMin: 40, idleGraceMin: 0, ...cfg }, 'UTC', join(dir, 'focus.jsonl'), goals);
  const host = { pushDeferred: (e: { type: string; render: () => string }) => { seen.events.push({ type: e.type, text: e.render() }); } } as unknown as Parameters<StudyWorld['start']>[0];
  const tick = (): Promise<void> => {
    (world as unknown as { nextCheck: number }).nextCheck = 0;
    return (world as unknown as { tick(): Promise<void> }).tick();
  };
  return { world, seen, host, tick, goals, reads: () => i };
}

const code = (title = 'main.ts'): ForegroundInfo => ({ title, pid: 1, processName: 'Code.exe' });
const bilibili = (): ForegroundInfo => ({ title: '哔哩哔哩', pid: 2, processName: 'bilibili.exe' });

describe('StudyWorld', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T02:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('counts a study window as a focus stretch and records it when it ends', async () => {
    const { world, seen, host, tick } = makeWorld([code(), code(), null]);
    await world.start(host);

    later(60_000);
    await tick();
    expect(seen.events.map((e) => e.type)).toEqual(['study.started']);
    expect(seen.ambient.at(-1)).toMatchObject({ active: true });
    expect(seen.ambient.at(-1)?.text).toMatch(/^专注中 \d\d:\d\d$/);

    later(60_000);
    await tick();
    later(60_000);
    await tick();
    await world.stop();

    expect(seen.events.map((e) => e.type)).toEqual(['study.started', 'study.ended']);
    expect(world.history().sessions.length).toBe(1);
    expect(world.history().sessions[0]!.seconds).toBe(120);
    expect(seen.ambient.at(-1)).toEqual({ active: false, text: '' });
  });

  it('raises a study card and a distracted event on a distractor app, then clears both on study', async () => {
    const { world, seen, host, tick } = makeWorld([bilibili(), bilibili(), code()], { checkMinMin: 1, checkMaxMin: 1 });
    await world.start(host);

    later(60_000);
    await tick(); // the first sighting starts the grace window
    expect(seen.alerts).toEqual([]);
    later(60_000);
    await tick(); // grace 0: the card goes up
    expect(seen.alerts).toHaveLength(1);
    expect(seen.alerts[0]).toMatchObject({ kind: 'study' });
    expect(seen.alerts[0]!.text).toContain('哔哩哔哩');
    expect(seen.events.some((e) => e.type === 'study.distracted')).toBe(true);

    later(60_000);
    await tick(); // back to studying
    expect(seen.cleared).toEqual([seen.alerts[0]!.id]);
    await world.stop();
  });

  it('lets a manual stretch override the automatic reading and end by hand', async () => {
    const { world, seen, host, tick } = makeWorld([code()], { focusMode: 'manual' });
    await world.start(host);

    later(60_000);
    await tick();
    expect(seen.events).toEqual([]); // the automatic reading is off in manual mode

    world.manualStart();
    expect(seen.events.map((e) => e.type)).toEqual(['study.started']);
    expect(world.state('zh')).toMatchObject({ focusing: true, kind: 'manual' });

    later(60_000);
    world.manualStop();
    expect(seen.events.map((e) => e.type)).toEqual(['study.started', 'study.ended']);
    expect(world.state('zh')).toMatchObject({ focusing: false, kind: null });
    expect(world.history().sessions.map((s) => s.kind)).toEqual(['manual']);
    await world.stop();
  });

  it('ends an automatic stretch by hand as a correction', async () => {
    const { world, seen, host, tick } = makeWorld([code()]);
    await world.start(host);

    later(60_000);
    await tick();
    expect(world.state('zh')).toMatchObject({ focusing: true, kind: 'auto' });

    later(60_000);
    world.stopFocus();
    expect(world.state('zh')).toMatchObject({ focusing: false, kind: null });
    expect(world.history().sessions).toEqual([expect.objectContaining({ kind: 'auto', seconds: 60 })]);
    expect(seen.events.map((e) => e.type)).toEqual(['study.started', 'study.ended']);
    await world.stop();
  });

  it('starts and ends a focus stretch through the Coo tools', async () => {
    const { world, seen, host } = makeWorld([code()]);
    await world.start(host);
    const call = async (name: string) => String(await world.tools().find((t) => t.name === name)!.handler({}, {} as never));

    expect(await call('study_start')).toContain('手动专注');
    expect(world.state('zh')).toMatchObject({ focusing: true, kind: 'manual' });
    expect(seen.events.map((e) => e.type)).toEqual(['study.started']);

    later(90_000);
    expect(await call('study_stop')).toContain('2 分钟');
    expect(world.state('zh')).toMatchObject({ focusing: false, kind: null });
    expect(world.history().sessions).toEqual([expect.objectContaining({ kind: 'manual', seconds: 90 })]);
    expect(await call('study_stop')).toBe('现在没有正在进行的专注。');
    await world.stop();
  });

  it('records a hand-started stretch toward its goal and leaves the pause out of its time', async () => {
    const { world, seen, host, goals } = makeWorld([code()], { focusMode: 'manual' });
    await world.start(host);
    const goal = goals.add('Coding').goal!;
    world.startFocus(goal.id);

    expect(world.state('zh')).toMatchObject({ focusing: true, paused: false, kind: 'manual', goalId: goal.id, goalName: 'Coding' });
    expect(world.petFocusState()).toEqual({ focusing: true, paused: false, goalId: goal.id, goalName: 'Coding' });
    expect(seen.events.map((e) => e.type)).toEqual(['study.started']);

    later(60_000);
    world.pauseFocus();
    expect(world.state('zh')).toMatchObject({ paused: true, seconds: 60 });
    later(300_000);
    expect(world.state('zh')).toMatchObject({ paused: true, seconds: 60 });
    expect(seen.ambient.at(-1)?.text).toBe('已暂停 01:00');

    world.resumeFocus();
    later(60_000);
    world.stopFocus();
    expect(world.history().sessions).toEqual([
      expect.objectContaining({ kind: 'manual', seconds: 120, goal: goal.id, goalName: 'Coding' }),
    ]);
    expect(world.petFocusState()).toEqual({ focusing: false, paused: false, goalId: null, goalName: null });
    await world.stop();
  });

  it('never stamps an automatic stretch with a goal', async () => {
    const { world, seen, host, tick } = makeWorld([code(), code()]);
    await world.start(host);
    later(60_000);
    await tick();
    later(60_000);
    world.stopFocus();

    const session = world.history().sessions[0]!;
    expect(session).toMatchObject({ kind: 'auto', seconds: 60 });
    expect(session.goal).toBeUndefined();
    expect(session.goalName).toBeUndefined();
    expect(seen.events.map((e) => e.type)).toEqual(['study.started', 'study.ended']);
    await world.stop();
  });

  it('closes the automatic stretch when a manual one starts toward a goal', async () => {
    const { world, host, tick, goals } = makeWorld([code(), code()]);
    await world.start(host);
    later(60_000);
    await tick();
    later(60_000);
    world.startFocus(goals.add('Reading').goal!.id);

    expect(world.history().sessions).toEqual([expect.objectContaining({ kind: 'auto', seconds: 60 })]);
    expect(world.state('zh')).toMatchObject({ kind: 'manual', goalName: 'Reading', seconds: 0 });
    await world.stop();
  });

  it('stops reading the foreground and raising reminders while paused', async () => {
    const { world, seen, host, tick, reads } = makeWorld([bilibili(), bilibili()]);
    await world.start(host);
    world.startFocus(null);
    later(60_000);
    await tick(); // the first sighting opens the distractor grace window
    const before = reads();

    world.pauseFocus();
    later(600_000);
    await tick();
    await tick();
    expect(reads()).toBe(before);
    expect(seen.alerts).toEqual([]);
    expect(world.state('zh')).toMatchObject({ paused: true, seconds: 60 });

    // resuming looks at the foreground at once, without waiting for the next check
    world.resumeFocus();
    await (world as unknown as { tick(): Promise<void> }).tick();
    expect(reads()).toBe(before + 1);
    await world.stop();
  });

  it('pauses and resumes an automatic stretch, the pause taken off its time', async () => {
    const { world, host, tick } = makeWorld([code(), code(), code()]);
    await world.start(host);
    later(60_000);
    await tick();
    later(60_000);
    await tick();
    world.pauseFocus();
    expect(world.state('zh')).toMatchObject({ kind: 'auto', paused: true, seconds: 60 });

    later(600_000);
    world.resumeFocus();
    later(60_000);
    world.stopFocus();
    expect(world.history().sessions).toEqual([expect.objectContaining({ kind: 'auto', seconds: 120 })]);
    await world.stop();
  });

  it('settles a stretch stopped while paused at the pause, world shutdown included', async () => {
    const { world, host } = makeWorld([code()]);
    await world.start(host);
    world.startFocus(null);
    later(60_000);
    world.pauseFocus();
    const pausedAt = Date.now();
    later(600_000);
    world.stopFocus();
    expect(world.history().sessions[0]).toMatchObject({ seconds: 60, end: pausedAt });

    world.startFocus(null);
    later(30_000);
    world.pauseFocus();
    const secondPause = Date.now();
    later(600_000);
    await world.stop();
    expect(world.history().sessions[0]).toMatchObject({ seconds: 30, end: secondPause });
  });

  it('starts toward a named goal, creates it when missing, and pauses and resumes through the tools', async () => {
    const { world, host, goals } = makeWorld([code()], { focusMode: 'manual' });
    await world.start(host);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      String(await world.tools().find((t) => t.name === name)!.handler(args, {} as never));

    expect(await call('study_start', { goal: '  Reading  ' })).toContain('「Reading」');
    const reading = goals.find('reading')!;
    expect(reading).toBeDefined();
    expect(world.state('zh')).toMatchObject({ goalId: reading.id, goalName: 'Reading' });

    later(60_000);
    expect(await call('study_pause')).toContain('已暂停');
    expect(world.state('zh')).toMatchObject({ paused: true, seconds: 60 });
    expect(await call('study_pause')).toContain('本来就暂停着');
    later(60_000);
    expect(await call('study_resume')).toContain('继续');
    later(30_000);
    expect(await call('study_stop')).toContain('2 分钟');
    expect(world.history().sessions[0]).toMatchObject({ seconds: 90, goal: reading.id });

    // a name too long for a goal falls back to a stretch without one
    expect(await call('study_start', { goal: 'x'.repeat(41) })).toContain('不能作为目标名');
    expect(world.state('zh')).toMatchObject({ focusing: true, goalId: null, goalName: null });

    // asking to start while paused resumes the same stretch instead of opening another
    world.pauseFocus();
    later(10_000);
    expect(await call('study_start')).toContain('继续');
    expect(world.state('zh')).toMatchObject({ paused: false });
    await world.stop();
  });

  it('keeps a clicked-away card down until the person leaves the distractor', async () => {
    const { world, seen, host, tick } = makeWorld([bilibili(), bilibili(), bilibili()]);
    await world.start(host);

    later(60_000);
    await tick();
    later(60_000);
    await tick();
    const id = seen.alerts[0]!.id;
    world.dismissAlert(id);
    expect(seen.cleared).toEqual([id]);

    later(60_000);
    await tick();
    expect(seen.alerts).toHaveLength(1);
    await world.stop();
  });
});
