import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: 'Le sessioni Claude Code in esecuzione e la loro velocità di token in tempo reale.',
  sheetTitle: 'Sessioni',
  headName: 'Sessione',
  headStatus: 'Stato',
  headAction: 'Azione',
  headSpeed: 'Velocità',
  headInput: 'Input',
  headOutput: 'Output',
  headCache: 'Cache',
  headModel: 'Modello',
  cardBusy: 'Attive',
  cardTotal: 'Sessioni',
  cardSpeed: 'Velocità',
  empty: 'Nessuna sessione Claude Code in esecuzione',
  loading: 'Caricamento…',
  loadFailed: (msg: string) => `Caricamento non riuscito: ${msg}`,
};
