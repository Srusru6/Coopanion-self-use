import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: 'Laufende Claude-Code-Sitzungen und ihre Token-Rate in Echtzeit.',
  sheetTitle: 'Sitzungen',
  headName: 'Sitzung',
  headStatus: 'Status',
  headAction: 'Aktion',
  headSpeed: 'Rate',
  headInput: 'Eingabe',
  headOutput: 'Ausgabe',
  headCache: 'Cache',
  headModel: 'Modell',
  cardBusy: 'Aktiv',
  cardTotal: 'Sitzungen',
  cardSpeed: 'Rate',
  empty: 'Keine laufenden Claude-Code-Sitzungen',
  loading: 'Lädt…',
  loadFailed: (msg: string) => `Laden fehlgeschlagen: ${msg}`,
};
