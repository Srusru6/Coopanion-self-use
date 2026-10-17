import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: '実行中の Claude Code セッションと、リアルタイムのトークン消費速度。',
  sheetTitle: 'セッション',
  headName: 'セッション',
  headStatus: '状態',
  headAction: '動作',
  headSpeed: '速度',
  headInput: '入力',
  headOutput: '出力',
  headCache: 'キャッシュ',
  headModel: 'モデル',
  cardBusy: '実行中',
  cardTotal: '総セッション',
  cardSpeed: '消費速度',
  empty: '実行中の Claude Code セッションはありません',
  loading: '読み込み中…',
  loadFailed: (msg: string) => `読み込み失敗：${msg}`,
};
