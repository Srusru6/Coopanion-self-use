import type { en } from './strings.ts';

export const S: Partial<typeof en> = {
  // index.ts
  navLabel: 'Claude',
  pageTitle: 'Claude',
  pageDesc: '실행 중인 Claude Code 세션과 실시간 토큰 소비 속도.',
  sheetTitle: '세션',
  headName: '세션',
  headStatus: '상태',
  headAction: '동작',
  headSpeed: '속도',
  headInput: '입력',
  headOutput: '출력',
  headCache: '캐시',
  headModel: '모델',
  cardBusy: '실행 중',
  cardTotal: '전체 세션',
  cardSpeed: '소비 속도',
  empty: '실행 중인 Claude Code 세션이 없습니다',
  loading: '불러오는 중…',
  loadFailed: (msg: string) => `불러오기 실패: ${msg}`,
};
