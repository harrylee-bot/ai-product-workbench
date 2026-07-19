export type WorkbenchModelCatalogState =
  | { error: null; retrying: false; status: "loading" }
  | { error: unknown; retrying: boolean; status: "error" }
  | { error: null; retrying: false; status: "empty" }
  | { error: null; retrying: false; status: "ready" };

type WorkbenchModelCatalogQueryState = {
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  isPending: boolean;
};

export function toWorkbenchModelCatalogState(
  query: WorkbenchModelCatalogQueryState,
  modelCount: number,
): WorkbenchModelCatalogState {
  if (query.isError) {
    return {
      error: query.error,
      retrying: query.isFetching,
      status: "error",
    };
  }
  if (query.isPending) return { error: null, retrying: false, status: "loading" };
  if (modelCount === 0) return { error: null, retrying: false, status: "empty" };
  return { error: null, retrying: false, status: "ready" };
}

export function resolveWorkbenchModelChoiceKey(
  currentKey: string,
  choices: readonly { key: string }[],
): string {
  return choices.some((choice) => choice.key === currentKey)
    ? currentKey
    : choices[0]?.key ?? "";
}
