export const PROJECT_LIST_LOAD_MORE_THRESHOLD_PX = 240;

export function shouldLoadMoreProjects({
  clientHeight,
  hasNextPage,
  isFetchingNextPage,
  scrollHeight,
  scrollTop,
}: {
  clientHeight: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  if (!hasNextPage || isFetchingNextPage) return false;
  return scrollHeight - scrollTop - clientHeight <= PROJECT_LIST_LOAD_MORE_THRESHOLD_PX;
}
