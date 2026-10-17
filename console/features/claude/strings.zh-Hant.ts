import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: '正在執行的 Claude Code 會話，以及它們的即時 token 消耗速度。',
  sheetTitle: '會話',
  headName: '會話',
  headStatus: '狀態',
  headAction: '動作',
  headSpeed: '速度',
  headInput: '輸入',
  headOutput: '輸出',
  headCache: '快取',
  headModel: '模型',
  cardBusy: '忙碌會話',
  cardTotal: '總會話',
  cardSpeed: '消耗速度',
  empty: '沒有正在執行的 Claude Code 會話',
  loading: '載入中…',
  loadFailed: (msg: string) => `載入失敗：${msg}`,
};
