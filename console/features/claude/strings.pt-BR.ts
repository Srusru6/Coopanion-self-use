import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: 'As sessões do Claude Code em execução e a velocidade de tokens em tempo real.',
  sheetTitle: 'Sessões',
  headName: 'Sessão',
  headStatus: 'Status',
  headAction: 'Ação',
  headSpeed: 'Velocidade',
  headInput: 'Entrada',
  headOutput: 'Saída',
  headCache: 'Cache',
  headModel: 'Modelo',
  cardBusy: 'Ativas',
  cardTotal: 'Sessões',
  cardSpeed: 'Velocidade',
  empty: 'Nenhuma sessão do Claude Code em execução',
  loading: 'Carregando…',
  loadFailed: (msg: string) => `Falha ao carregar: ${msg}`,
};
