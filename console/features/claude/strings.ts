import { pick } from '../../base/language.ts';
import { S as zhHant } from './strings.zh-Hant.ts';
import { S as ja } from './strings.ja.ts';
import { S as ko } from './strings.ko.ts';
import { S as fr } from './strings.fr.ts';
import { S as de } from './strings.de.ts';
import { S as es419 } from './strings.es-419.ts';
import { S as ptBR } from './strings.pt-BR.ts';
import { S as it } from './strings.it.ts';
import { S as ru } from './strings.ru.ts';

const zh = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: '正在运行的 Claude Code 会话，以及它们的实时 token 消耗速度。',
  sheetTitle: '会话',
  headName: '会话',
  headStatus: '状态',
  headAction: '动作',
  headSpeed: '速度',
  headInput: '输入',
  headOutput: '输出',
  headCache: '缓存',
  headModel: '模型',
  cardBusy: '忙碌会话',
  cardTotal: '总会话',
  cardSpeed: '消耗速度',
  empty: '没有正在运行的 Claude Code 会话',
  loading: '加载中…',
  loadFailed: (msg: string) => `加载失败：${msg}`,
};

export const en: typeof zh = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: 'The running Claude Code sessions and their live token speed.',
  sheetTitle: 'Sessions',
  headName: 'Session',
  headStatus: 'Status',
  headAction: 'Action',
  headSpeed: 'Speed',
  headInput: 'Input',
  headOutput: 'Output',
  headCache: 'Cache',
  headModel: 'Model',
  cardBusy: 'Busy',
  cardTotal: 'Sessions',
  cardSpeed: 'Speed',
  empty: 'No running Claude Code sessions',
  loading: 'Loading…',
  loadFailed: (msg: string) => `Failed to load: ${msg}`,
};

export const S = pick({
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
});
