import type { Stage } from '../shared/core/domain.js';
import type { Palette } from './palette.js';
/** Shared by card stripes, column markers and selected mobile tabs. */
export function stageColor(stageId: string, stages: readonly Pick<Stage, 'stageId' | 'countsAsDone'>[], colors: Palette): string {
  const index = stages.findIndex(s => s.stageId === stageId);
  if (stages[index]?.countsAsDone) return colors.stageDone;
  if (index <= 0) return colors.foregroundMuted;
  const middle = stages.slice(1, index + 1).filter(s => !s.countsAsDone).length - 1;
  return middle % 2 === 0 ? colors.stageBlue : colors.stagePurple;
}
