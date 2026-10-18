/**
 * The focus goals people make for themselves: a name and one of the eight chart colours, kept in
 * `focus-goals.json` in the data directory so they outlive a restart. Sessions record the goal's id
 * and a snapshot of its name, so deleting or renaming one does not rewrite history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FocusGoal {
  id: string;
  name: string;
  /** Index into the fixed chart palette, 0..7. */
  color: number;
}

export type GoalError = 'empty' | 'duplicate' | 'tooLong' | 'full' | 'missing';

export interface GoalEditResult {
  goals: FocusGoal[];
  goal: FocusGoal | null;
  error: GoalError | null;
}

interface Saved {
  next: number;
  goals: FocusGoal[];
}

/** The longest name the settings window and the pet menu can show in one line. */
export const MAX_GOAL_NAME = 40;
/** Enough for a person's categories without turning the pet menu into a wall. */
export const MAX_GOALS = 12;
/** The chart palette's size; goals past it repeat a colour. */
const COLORS = 8;

/** Spaces collapsed and the edges trimmed; a name is typed by hand. */
function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

export class FocusGoals {
  private saved: Saved;

  constructor(private readonly file: string, private readonly report: (message: string) => void = console.error) {
    this.saved = this.load();
  }

  private load(): Saved {
    if (!existsSync(this.file)) return { next: 1, goals: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      this.report(`Focus goals ${this.file}: ${String(error)}`);
      return { next: 1, goals: [] };
    }
    const data = raw as Partial<Saved> | null;
    const goals: FocusGoal[] = [];
    const ids = new Set<string>();
    if (Array.isArray(data?.goals)) {
      for (const item of data.goals) {
        const goal = item as Partial<FocusGoal> | null;
        if (typeof goal?.id !== 'string' || !goal.id || typeof goal.name !== 'string') continue;
        const name = normalizeName(goal.name);
        if (!name || name.length > MAX_GOAL_NAME) continue;
        if (ids.has(goal.id) || goals.some((g) => sameName(g.name, name))) continue;
        const color = typeof goal.color === 'number' && Number.isInteger(goal.color) ? ((goal.color % COLORS) + COLORS) % COLORS : goals.length % COLORS;
        ids.add(goal.id);
        goals.push({ id: goal.id, name, color });
        if (goals.length === MAX_GOALS) break;
      }
    }
    let next = typeof data?.next === 'number' && Number.isInteger(data.next) && data.next > 0 ? data.next : 1;
    for (const goal of goals) {
      const n = Number(/^g(\d+)$/.exec(goal.id)?.[1] ?? 0);
      if (n >= next) next = n + 1;
    }
    return { next, goals };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.saved, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch (error) {
      this.report(`Focus goals ${this.file}: ${String(error)}`);
    }
  }

  private result(goal: FocusGoal | null, error: GoalError | null = null): GoalEditResult {
    return { goals: this.list(), goal, error };
  }

  /** Every goal in creation order. */
  list(): FocusGoal[] {
    return this.saved.goals.map((g) => ({ ...g }));
  }

  get(id: string | null | undefined): FocusGoal | null {
    if (typeof id !== 'string' || !id) return null;
    const goal = this.saved.goals.find((g) => g.id === id);
    return goal ? { ...goal } : null;
  }

  /** The goal called `name`, ignoring case and extra spaces. */
  find(name: string): FocusGoal | null {
    const wanted = normalizeName(name);
    if (!wanted) return null;
    const goal = this.saved.goals.find((g) => sameName(g.name, wanted));
    return goal ? { ...goal } : null;
  }

  /** The goal called `name`, made when there is none; null when the name cannot be a goal. */
  ensure(name: string): FocusGoal | null {
    const wanted = normalizeName(name);
    if (!wanted || wanted.length > MAX_GOAL_NAME) return null;
    const found = this.find(wanted);
    if (found) return found;
    return this.add(wanted).goal;
  }

  private freeColor(): number {
    for (let color = 0; color < COLORS; color += 1) {
      if (!this.saved.goals.some((g) => g.color === color)) return color;
    }
    return this.saved.goals.length % COLORS;
  }

  add(name: unknown): GoalEditResult {
    const wanted = normalizeName(name);
    if (!wanted) return this.result(null, 'empty');
    if (wanted.length > MAX_GOAL_NAME) return this.result(null, 'tooLong');
    if (this.saved.goals.some((g) => sameName(g.name, wanted))) return this.result(null, 'duplicate');
    if (this.saved.goals.length >= MAX_GOALS) return this.result(null, 'full');
    const goal: FocusGoal = { id: `g${this.saved.next}`, name: wanted, color: this.freeColor() };
    this.saved.next += 1;
    this.saved.goals.push(goal);
    this.save();
    return this.result(goal);
  }

  rename(id: unknown, name: unknown): GoalEditResult {
    const found = typeof id === 'string' ? this.saved.goals.find((g) => g.id === id) : undefined;
    if (!found) return this.result(null, 'missing');
    const wanted = normalizeName(name);
    if (!wanted) return this.result(null, 'empty');
    if (wanted.length > MAX_GOAL_NAME) return this.result(null, 'tooLong');
    if (this.saved.goals.some((g) => g.id !== found.id && sameName(g.name, wanted))) return this.result(null, 'duplicate');
    found.name = wanted;
    this.save();
    return this.result({ ...found });
  }

  remove(id: unknown): GoalEditResult {
    const goal = this.get(typeof id === 'string' ? id : null);
    if (!goal) return this.result(null, 'missing');
    this.saved.goals = this.saved.goals.filter((g) => g.id !== goal.id);
    this.save();
    return this.result(null);
  }
}
