import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: 'Работающие сеансы Claude Code и их скорость расхода token в реальном времени.',
  sheetTitle: 'Сеансы',
  headName: 'Сеанс',
  headStatus: 'Состояние',
  headAction: 'Действие',
  headSpeed: 'Скорость',
  headInput: 'Ввод',
  headOutput: 'Вывод',
  headCache: 'Кэш',
  headModel: 'Модель',
  cardBusy: 'Активные',
  cardTotal: 'Сеансы',
  cardSpeed: 'Скорость',
  empty: 'Нет работающих сеансов Claude Code',
  loading: 'Загрузка…',
  loadFailed: (msg: string) => `Не удалось загрузить: ${msg}`,
};
