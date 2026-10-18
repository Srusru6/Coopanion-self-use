/**
 * The `study` World's browser panel: the World page in the settings window shows the shared study
 * dashboard (`view.ts`) — today's focus, the clock of the open stretch, the statistics views and a
 * button to count focus by hand. Data comes through `ctx.invoke`; `scripts/stage.ts` builds this
 * file into `build/console/study-panel.js`, and core/companion.ts registers it as the `world:study`
 * bundle.
 *
 * Without it the World page has a declared panel and no bundle, and opening it shows a panel error
 * instead of the dashboard.
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { studyStrings } from './strings.ts';
import { mountStudyView } from './view.ts';

function mount(ctx: WebUiPanelContext): void {
  mountStudyView({
    ui: ctx.ui,
    root: ctx.root,
    t: studyStrings(ctx.language),
    signal: ctx.signal,
    invoke: (method, args) => ctx.invoke(method, args),
    interval: (fn, ms) => ctx.interval(fn, ms),
  });
}

const focusPanel: WebUiPanel = { mount };

export default { panels: { focus: focusPanel } };
