/**
 * The study page: the dashboard shared with the World panel (`view.ts`), fed by the `study` World's
 * `focus` panel. This file only adapts the page context to the shared view.
 */
import { invokePanel } from '../../base/api.ts';
import { pageIntro } from '../../base/ui/page.ts';
import type { Page, PageContext } from '../../base/page.ts';
import { S } from './strings.ts';
import { mountStudyView } from './view.ts';

export function mountStudy(ctx: PageContext): void {
  const { ui, root, signal, lifecycle } = ctx;
  const intro = pageIntro(ui, S.pageTitle, S.pageDesc);
  mountStudyView({
    ui,
    root,
    t: S,
    signal,
    intro,
    invoke: <T>(method: string, args?: unknown[]) =>
      invokePanel<T>('world:study', 'focus', method, args ?? [], { signal }),
    interval: (fn, ms) => lifecycle.interval(fn, ms),
  });
}

export const studyPage: Page = {
  route: 'study',
  label: S.navLabel,
  icon: 'monitor',
  mount: mountStudy,
};
