import { pick, pickFor, type Language, type LanguageTable } from '../../base/language.ts';
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
  navLabel: '学习监督',
  pageTitle: '学习监督',
  pageDesc: '不定时读取前台窗口，判断在专注还是分心，并记录专注时间。只在本机读取窗口标题与进程名。',
  cardToday: '今日专注',
  cardNow: '当前',
  cardMode: '记录方式',
  sheetSessions: '最近的专注时段',
  headTime: '时间',
  headDuration: '时长',
  headKind: '类型',
  kindAuto: '自动',
  kindManual: '手动',
  modeAuto: '自动',
  modeManual: '手动',
  modeBoth: '自动 + 手动',
  statsTitle: '数据统计',
  periodDay: '今日',
  periodWeek: '近 7 天',
  periodMonth: '近 30 天',
  periodYear: '近 12 个月',
  periodAll: '全部',
  cardTotal: '合计',
  cardSessions: '专注时段',
  cardLongest: '最长一段',
  cardActive: '活跃',
  unitHour: '小时',
  unitDay: '天',
  unitMonth: '个月',
  unitYear: '年',
  chartEmpty: '这段时间还没有专注记录',
  focusing: '专注中',
  idle: '未在专注',
  empty: '今天还没有记录专注时段',
  loading: '加载中…',
  loadFailed: (msg: string) => `加载失败：${msg}`,
  btnStart: '开始专注',
  btnStop: '结束专注',
};

export const en: typeof zh = {
  // index.ts
  navLabel: 'Study',
  pageTitle: 'Study',
  pageDesc: 'Reads the foreground window at irregular intervals to tell study from distraction and record focus time. Only the window title and process name are read, locally.',
  cardToday: "Today's focus",
  cardNow: 'Now',
  cardMode: 'Tracking',
  sheetSessions: 'Recent focus sessions',
  headTime: 'Time',
  headDuration: 'Duration',
  headKind: 'Kind',
  kindAuto: 'Auto',
  kindManual: 'Manual',
  modeAuto: 'Auto',
  modeManual: 'Manual',
  modeBoth: 'Auto + manual',
  statsTitle: 'Statistics',
  periodDay: 'Today',
  periodWeek: 'Last 7 days',
  periodMonth: 'Last 30 days',
  periodYear: 'Last 12 months',
  periodAll: 'All time',
  cardTotal: 'Total',
  cardSessions: 'Sessions',
  cardLongest: 'Longest',
  cardActive: 'Active',
  unitHour: 'hours',
  unitDay: 'days',
  unitMonth: 'months',
  unitYear: 'years',
  chartEmpty: 'No focus sessions recorded in this period',
  focusing: 'Focusing',
  idle: 'Idle',
  empty: 'No focus sessions recorded today',
  loading: 'Loading…',
  loadFailed: (msg: string) => `Failed to load: ${msg}`,
  btnStart: 'Start focus',
  btnStop: 'Stop focus',
};

/** Every string the study page and its WebUI panel draw. */
export type StudyStrings = typeof zh;

const TABLE: LanguageTable<typeof zh> = {
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
};

export const S = pick(TABLE);

/** The same strings for a language named by the caller, such as a WebUI panel's `ctx.language`. */
export function studyStrings(language: Language): typeof zh {
  return pickFor(language, TABLE);
}
