import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: 'Les sessions Claude Code en cours et leur débit de tokens en temps réel.',
  sheetTitle: 'Sessions',
  headName: 'Session',
  headStatus: 'État',
  headAction: 'Action',
  headSpeed: 'Débit',
  headInput: 'Entrée',
  headOutput: 'Sortie',
  headCache: 'Cache',
  headModel: 'Modèle',
  cardBusy: 'Actives',
  cardTotal: 'Sessions',
  cardSpeed: 'Débit',
  empty: 'Aucune session Claude Code en cours',
  loading: 'Chargement…',
  loadFailed: (msg: string) => `Échec du chargement : ${msg}`,
};
