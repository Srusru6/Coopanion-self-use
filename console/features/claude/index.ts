/**
 * The Claude page: the running Claude Code sessions and their live token speed, from the
 * `claude-cli` World's `sessions` panel. The panel localizes each row's status and action for the
 * request's language; this page only polls and renders the rows.
 */
import { invokePanel } from '../../base/api.ts';
import { consoleFormat } from '../../base/ui/format.ts';
import { pageIntro } from '../../base/ui/page.ts';
import type { Page, PageContext } from '../../base/page.ts';
import { S } from './strings.ts';

/** How often the dashboard refetches. */
const LIVE_MS = 2000;

/** One dashboard row, as `state` returns it; the panel has already localized status and action. */
interface ClaudeSessionRow {
  pid: number;
  name: string;
  cwd: string;
  status: 'busy' | 'idle' | 'waiting';
  statusText: string;
  action: string;
  speed: number;
  input: number;
  output: number;
  cache: number;
  model: string;
}

interface ClaudeState {
  active: boolean;
  sessions: ClaudeSessionRow[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

export function mountClaude(ctx: PageContext): void {
  const { ui, root, lifecycle } = ctx;
  const intro = pageIntro(ui, S.pageTitle, S.pageDesc);

  const cards = ui.statgrid();
  const sheet = ui.sheet({ title: S.sheetTitle, en: 'sessions' });
  const table = ui.table({
    head: [S.headName, S.headStatus, S.headAction, S.headSpeed, S.headInput, S.headOutput, S.headCache, S.headModel],
  });
  sheet.body.appendChild(table.el);

  const note = ui.msgline('', true);
  root.append(intro, cards, sheet.el, note);

  function render(d: ClaudeState): void {
    const sessions = d.sessions ?? [];
    const busy = sessions.filter((s) => s.status === 'busy');
    const speed = busy.reduce((sum, s) => sum + (s.speed || 0), 0);
    cards.replaceChildren(
      ui.stat({ k: S.cardBusy, v: String(busy.length), accent: busy.length > 0 }),
      ui.stat({ k: S.cardTotal, v: String(sessions.length) }),
      ui.stat({ k: S.cardSpeed, v: `${speed} tok/s` }),
    );
    note.textContent = '';
    table.clear(sessions.length ? undefined : S.empty);
    for (const s of sessions) {
      const name = ui.h('span', null, s.name || `#${s.pid}`);
      if (s.cwd) name.title = s.cwd;
      table.addRow([
        name,
        { text: s.statusText, cls: s.status === 'busy' || s.status === 'waiting' ? 'mono' : 'muted' },
        { text: s.action || '—', cls: 'mono' },
        { text: `${s.speed || 0} tok/s`, cls: 'mono' },
        { text: consoleFormat.count(s.input), cls: 'mono' },
        { text: consoleFormat.count(s.output), cls: 'mono' },
        { text: consoleFormat.count(s.cache), cls: 'mono' },
        { text: s.model || '—', cls: 'mono' },
      ]);
    }
  }

  let generation = 0;
  async function load(): Promise<void> {
    const mine = ++generation;
    try {
      const d = await invokePanel<ClaudeState>('world:claude-cli', 'sessions', 'state', [], { signal: ctx.signal });
      if (ctx.signal.aborted || mine !== generation) return;
      render(d);
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted || mine !== generation) return;
      note.textContent = S.loadFailed(errText(err));
    }
  }

  cards.appendChild(ui.placeholder(S.loading));
  lifecycle.interval(() => void load(), LIVE_MS);
  void load();
}

export const claudePage: Page = {
  route: 'claude',
  label: S.navLabel,
  icon: 'zap',
  mount: mountClaude,
};
