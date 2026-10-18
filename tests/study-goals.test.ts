import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FocusGoals, MAX_GOALS, MAX_GOAL_NAME } from '../core/study-goals.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'coo-goals-'));
const quiet = (): ((message: string) => void) => () => {};

describe('FocusGoals', () => {
  it('adds goals with the next id and the lowest free colour, and keeps them across a reload', () => {
    const file = join(dir(), 'focus-goals.json');
    const goals = new FocusGoals(file, quiet());
    const coding = goals.add('  Coding  ');
    expect(coding).toEqual({
      goals: [{ id: 'g1', name: 'Coding', color: 0 }],
      goal: { id: 'g1', name: 'Coding', color: 0 },
      error: null,
    });
    expect(goals.add('Reading').goal).toMatchObject({ id: 'g2', color: 1 });
    expect(new FocusGoals(file, quiet()).list()).toEqual(goals.list());
  });

  it('rejects an empty, duplicate or over-long name, and refuses past the cap', () => {
    const goals = new FocusGoals(join(dir(), 'focus-goals.json'), quiet());
    expect(goals.add('   ').error).toBe('empty');
    goals.add('Coding');
    expect(goals.add('  coding ').error).toBe('duplicate');
    expect(goals.add('x'.repeat(MAX_GOAL_NAME + 1)).error).toBe('tooLong');
    for (let i = 2; i <= MAX_GOALS; i += 1) expect(goals.add(`Goal ${i}`).error).toBeNull();
    expect(goals.list()).toHaveLength(MAX_GOALS);
    expect(goals.add('One more').error).toBe('full');
  });

  it('renames in place, collapsing spaces and refusing another goal\'s name', () => {
    const file = join(dir(), 'focus-goals.json');
    const goals = new FocusGoals(file, quiet());
    const coding = goals.add('Coding').goal!;
    const renamed = goals.rename(coding.id, '  Deep   work ');
    expect(renamed).toMatchObject({ goal: { id: 'g1', name: 'Deep work', color: 0 }, error: null });
    expect(new FocusGoals(file, quiet()).get(coding.id)?.name).toBe('Deep work');

    goals.add('Reading');
    expect(goals.rename(coding.id, 'reading').error).toBe('duplicate');
    expect(goals.rename(coding.id, '  ').error).toBe('empty');
    expect(goals.rename(coding.id, 'x'.repeat(MAX_GOAL_NAME + 1)).error).toBe('tooLong');
    expect(goals.rename('g99', 'Anything').error).toBe('missing');
  });

  it('removes a goal and frees its colour', () => {
    const goals = new FocusGoals(join(dir(), 'focus-goals.json'), quiet());
    const first = goals.add('A').goal!;
    expect(goals.add('B').goal!.color).toBe(1);
    expect(goals.add('C').goal!.color).toBe(2);
    expect(goals.remove(first.id)).toMatchObject({ goal: null, error: null });
    expect(goals.get(first.id)).toBeNull();
    expect(goals.remove(first.id).error).toBe('missing');
    expect(goals.add('D').goal!.color).toBe(0);
  });

  it('repeats colours once the palette is full', () => {
    const goals = new FocusGoals(join(dir(), 'focus-goals.json'), quiet());
    for (let i = 0; i < 8; i += 1) goals.add(`Goal ${i}`);
    expect(goals.list().map((g) => g.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(goals.add('Ninth').goal!.color).toBe(0);
  });

  it('starts empty over corrupt JSON and writes a clean file on the next edit', () => {
    const file = join(dir(), 'focus-goals.json');
    writeFileSync(file, '{"next": 3, "goals": [');
    const report = vi.fn();
    const goals = new FocusGoals(file, report);
    expect(goals.list()).toEqual([]);
    expect(report).toHaveBeenCalled();
    expect(goals.add('Coding').goal).toMatchObject({ id: 'g1', name: 'Coding', color: 0 });
    expect(JSON.parse(readFileSync(file, 'utf8')).goals).toHaveLength(1);
  });

  it('drops invalid saved goals and derives the next id from the ones kept', () => {
    const file = join(dir(), 'focus-goals.json');
    writeFileSync(file, JSON.stringify({
      next: 3,
      goals: [
        { id: 'g1', name: '  Coding  ', color: 12 },
        { id: 'g1', name: 'Other', color: 0 },
        { id: 'g2', name: 'coding', color: 1 },
        { id: 'x', name: '   ', color: 2 },
        { id: 'g7', name: 'Reading', color: 'red' },
      ],
    }));
    const goals = new FocusGoals(file, quiet());
    expect(goals.list()).toEqual([
      { id: 'g1', name: 'Coding', color: 4 },
      { id: 'g7', name: 'Reading', color: 1 },
    ]);
    expect(goals.add('Next').goal!.id).toBe('g8');
  });

  it('finds a goal by name and creates only what is missing', () => {
    const goals = new FocusGoals(join(dir(), 'focus-goals.json'), quiet());
    const created = goals.ensure(' Coding ');
    expect(created).toMatchObject({ id: 'g1', name: 'Coding' });
    expect(goals.ensure('coding')).toEqual(created);
    expect(goals.list()).toHaveLength(1);
    expect(goals.ensure('Reading')).toMatchObject({ id: 'g2', name: 'Reading' });
    expect(goals.ensure('  ')).toBeNull();
    expect(goals.ensure('x'.repeat(MAX_GOAL_NAME + 1))).toBeNull();
  });
});
