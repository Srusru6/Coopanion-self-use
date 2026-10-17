import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: 'Las sesiones de Claude Code en curso y su velocidad de tokens en tiempo real.',
  sheetTitle: 'Sesiones',
  headName: 'Sesión',
  headStatus: 'Estado',
  headAction: 'Acción',
  headSpeed: 'Velocidad',
  headInput: 'Entrada',
  headOutput: 'Salida',
  headCache: 'Caché',
  headModel: 'Modelo',
  cardBusy: 'Activas',
  cardTotal: 'Sesiones',
  cardSpeed: 'Velocidad',
  empty: 'No hay sesiones de Claude Code en curso',
  loading: 'Cargando…',
  loadFailed: (msg: string) => `No se pudo cargar: ${msg}`,
};
