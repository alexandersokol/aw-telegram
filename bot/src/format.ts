/** Ukrainian display formatting shared by reports, menus and coordination messages. */
import type {CategoryPath} from './contracts.js';

export function duration(ms: number): string {
  if (ms > 0 && ms < 60000) return 'менше 1 хв';
  const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60);
  return hours ? `${hours} год ${String(minutes % 60).padStart(2, '0')} хв` : `${minutes} хв`;
}

/** null is the opt-in uncategorized pseudo-category. */
export const categoryLabel = (path: CategoryPath | null): string => path === null ? 'Без категорії' : path.join(' › ');

export function selectionLabel(paths: CategoryPath[], uncategorized: boolean): string {
  const labels = [...paths.map(categoryLabel), ...(uncategorized ? [categoryLabel(null)] : [])];
  return labels.length ? labels.join(', ') : 'нічого';
}
