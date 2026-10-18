import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyWorld } from '../core/study.ts';
import { studyDefaults, type ForegroundInfo, type StudyConfig } from '../core/study-sessions.ts';

interface Seen {
  events: { type: string; text: string }[];
  ambient: { active: boolean; text: string }[];
  alerts: { id: number; kind: string; text: string }[];
  cleared: number[];
}

/** A world over a scripted foreground, counting what it asks the pet and Coo to do. */
function makeWorld(script: (ForegroundInfo | null)[], cfg: Partial<StudyConfig> = {}) {
  const seen: Seen = { events: [], ambient: [], alerts: [], cleared: [] };
  let i = 0;
  const world = new StudyWorld({
    read: (path) => (path === 'language' ? 'zh' : undefined),
    foreground: () => Promise.resolve(script[Math.min(i++, script.length - 1)] ?? null),
    ambient: (status) => { seen.ambient.push({ active: status.active, text: status.text }); },
    alert: (id, kind, text) => { seen.alerts.push({ id, kind, text }); },
    alertClear: (id) => { seen.cleared.push(id); },
    label: () => '学习监督',
  }, { ...studyDefaults(), checkMinMin: 15, checkMaxMin: 40, idleGraceMin: 0, ...cfg }, 'UTC', join(mkdtempSync(join(tmpdir(), 'coo-study-world-')), 'focus.jsonl'));
  const host = { pushDeferred: (e: { type: string; render: () => string }) => { seen.events.push({ type: e.type, text: e.render() }); } } as unknown as Parameters<StudyWorld['start']>[0];
  const tick = (): Promise<void> => {
    (world as unknown as { nextCheck: number }).nextCheck = 0;
    return (world as unknown as { tick(): Promise<void> }).tick();
  };
  return { world, seen, host, tick };
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
