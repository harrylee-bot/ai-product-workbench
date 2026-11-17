"use client";

/** Controlled directory for discussions with the same fixed input context.
 * Pagination, identity checks and selection persistence belong to its caller. */
export function RequirementSessions({
  items,
  selectedId,
  hasMore,
  loading,
  disabled,
  onSelect,
  onMore,
}: {
  items: readonly { id: string; label: string; version: number }[];
  selectedId: string;
  hasMore: boolean;
  loading: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onMore: () => void;
}) {
  if (items.length < 2 && !hasMore) return null;
  return (
    <div className="studio-requirement-directory">
      <label>
        需求讨论
        <select
          aria-label="需求讨论"
          value={selectedId}
          disabled={disabled || loading || !items.length}
          onChange={(event) => onSelect(event.target.value)}
        >
          {!items.some((item) => item.id === selectedId) && (
            <option value={selectedId}>
              {selectedId ? "当前讨论" : "选择已保存的讨论"}
            </option>
          )}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label.slice(0, 60)} · 摘要第 {item.version} 版
            </option>
          ))}
        </select>
      </label>
      {hasMore && (
        <button type="button" disabled={disabled || loading} onClick={onMore}>
          {loading ? "正在读取…" : "加载更多讨论"}
        </button>
      )}
    </div>
  );
}
