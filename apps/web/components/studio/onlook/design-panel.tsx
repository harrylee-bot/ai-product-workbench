// Derived from Onlook (Copyright 2024 On Off, Inc.), Apache-2.0.
// Upstream: apps/web/client/src/app/project/[id]/_components/left-panel/design-panel/index.tsx @ 423e2e924366419e418ee049093872d535eea41a
// Modified: Workbench service boundary, scoped state, accessible light UI.
// See third_party/onlook for original source, license and modification ledger.
"use client";
import {
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

const narrowScreen = "(max-width: 767px)";
const isNarrow = () => window.matchMedia?.(narrowScreen).matches ?? false;
function listenForResize(notify: () => void) {
  const media = window.matchMedia?.(narrowScreen);
  media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
}

export type DesignTab = {
  value: string;
  label: string;
  icon: ReactNode;
  content?: ReactNode;
};
/** Onlook's rail + mutually exclusive panel, opened by click/keyboard to avoid hover traps. */
export function DesignPanel({
  tabs,
  selectedTab,
  onSelect,
  panelTrigger,
}: {
  tabs: DesignTab[];
  selectedTab: string | null;
  onSelect: (tab: string | null, trigger: HTMLElement | null) => void;
  panelTrigger: RefObject<HTMLElement | null>;
}) {
  const selected = tabs.find((tab) => tab.value === selectedTab);
  const panelId = useId();
  const narrow = useSyncExternalStore(listenForResize, isNarrow, () => false);
  return (
    <div className="studio-design-panel">
      <nav className="studio-rail" aria-label="项目导航">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            aria-pressed={tab.content ? undefined : selectedTab === tab.value}
            aria-expanded={tab.content ? selectedTab === tab.value : undefined}
            aria-controls={
              tab.content && selectedTab === tab.value ? panelId : undefined
            }
            aria-label={tab.label}
            title={tab.label}
            onClick={(event) =>
              onSelect(
                selectedTab === tab.value ? null : tab.value,
                event.currentTarget,
              )
            }
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
      {selected?.content && (
        <ContextPanel
          key={selected.value}
          id={panelId}
          tab={selected}
          modal={narrow}
          trigger={panelTrigger}
          onClose={() => onSelect(null, null)}
        />
      )}
    </div>
  );
}

function ContextPanel({
  id,
  tab,
  modal,
  trigger,
  onClose,
}: {
  id: string;
  tab: DesignTab;
  modal: boolean;
  trigger: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const opener = trigger.current;
    const button = closeButton.current;
    const panel = button?.closest(".studio-context");
    const element = dialog.current;
    if (element) element.showModal();
    else if (opener instanceof HTMLButtonElement)
      button?.focus({ preventScroll: true });
    return () => {
      const restore = panel?.contains(document.activeElement);
      element?.close();
      if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [modal, trigger]);

  const body = (
    <>
      <div className="studio-panel-heading">
        <h2>{tab.label}</h2>
        <button
          type="button"
          ref={closeButton}
          aria-label="关闭面板"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {tab.content}
    </>
  );
  if (modal)
    return (
      <dialog
        id={id}
        className="studio-context"
        aria-label={tab.label}
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        {body}
      </dialog>
    );
  return (
    <aside
      id={id}
      className="studio-context"
      aria-label={tab.label}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229
        ) {
          onClose();
        }
      }}
    >
      {body}
    </aside>
  );
}
