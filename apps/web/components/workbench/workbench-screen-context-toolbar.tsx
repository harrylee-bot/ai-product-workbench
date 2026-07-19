"use client";

import { NodeToolbar, Position } from "@xyflow/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlignCenterHorizontalIcon,
  AlignCenterVerticalIcon,
  AlignEndHorizontalIcon,
  AlignEndVerticalIcon,
  AlignHorizontalDistributeCenterIcon,
  AlignStartHorizontalIcon,
  AlignStartVerticalIcon,
  AlignVerticalDistributeCenterIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  FrameIcon,
  GripIcon,
  HistoryIcon,
  LinkIcon,
  PencilIcon,
  PlayIcon,
  SparklesIcon,
  StarIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Trash2Icon,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/utils";
import type { BoardNodeArrangeOperation } from "@/lib/workbench/features/board";
import { popoverTransition } from "./workbench-motion";

export type WorkbenchScreenContextToolbarAvailability = {
  canAlign: boolean;
  canCopyLink: boolean;
  canDelete: boolean;
  canDistribute: boolean;
  canDuplicate: boolean;
  canExport: boolean;
  canGenerate: boolean;
  canGenerateVariants: boolean;
  canModify: boolean;
  canOpenVersions: boolean;
  canPreview: boolean;
  canRename: boolean;
  canToggleFavourite: boolean;
  canToggleReaction: boolean;
};

export type WorkbenchScreenContextToolbarModel =
  | {
      kind: "single";
      availability: WorkbenchScreenContextToolbarAvailability;
      favourite: boolean;
      favouriteBusy: boolean;
      height: number;
      nodeIds: [string];
      previewAction: "generate" | "preview";
      reaction: "dislike" | "like" | null;
      title: string;
      width: number;
    }
  | {
      kind: "multiple";
      availability: WorkbenchScreenContextToolbarAvailability;
      count: number;
      nodeIds: string[];
      previewAction: "generate" | "preview";
    };

export type WorkbenchScreenContextToolbarProps = {
  model: WorkbenchScreenContextToolbarModel | null;
  onAlign: (operation: Extract<BoardNodeArrangeOperation, { kind: "align" }>) => void;
  onCopyLink: () => void;
  onDelete: () => void;
  onDistribute: (operation: Extract<BoardNodeArrangeOperation, { kind: "distribute" }>) => void;
  onDuplicate: () => void;
  onExport: () => void;
  onGenerate: () => void;
  onGenerateVariants: () => void;
  onModify: () => void;
  onOpenVersions: () => void;
  onPreview: () => void;
  onRename: () => void;
  onToggleFavourite: () => void;
  onToggleDislike: () => void;
  onToggleLike: () => void;
};

type ToolbarMenu = "align" | "distribute" | "more" | null;

type OpenToolbarMenu = Exclude<ToolbarMenu, null>;

export type WorkbenchFloatingRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

export type WorkbenchFloatingBounds = Pick<
  WorkbenchFloatingRect,
  "bottom" | "left" | "right" | "top"
>;

export type WorkbenchContextMenuPlacement = {
  left: number;
  maxHeight: number;
  side: "bottom" | "top";
};

const floatingViewportMargin = 12;
const floatingObstacleGap = 8;
const contextMenuGap = 6;
const contextMenuWidth = 224;

export function calculateToolbarCollisionOffset(
  rect: WorkbenchFloatingRect,
  bounds: WorkbenchFloatingBounds,
): { x: number; y: number } {
  const availableWidth = Math.max(0, bounds.right - bounds.left);
  const availableHeight = Math.max(0, bounds.bottom - bounds.top);
  const x = rect.width > availableWidth
    ? bounds.left - rect.left
    : rect.left < bounds.left
      ? bounds.left - rect.left
      : rect.right > bounds.right
        ? bounds.right - rect.right
        : 0;
  const y = rect.height > availableHeight
    ? bounds.top - rect.top
    : rect.top < bounds.top
      ? bounds.top - rect.top
      : rect.bottom > bounds.bottom
        ? bounds.bottom - rect.bottom
        : 0;
  return { x, y };
}

export function calculateContextMenuPlacement({
  align,
  bounds,
  leftOffset,
  menuHeight,
  menuWidth,
  toolbarRect,
}: {
  align: "center" | "start";
  bounds: WorkbenchFloatingBounds;
  leftOffset: number;
  menuHeight: number;
  menuWidth: number;
  toolbarRect: WorkbenchFloatingRect;
}): WorkbenchContextMenuPlacement {
  const availableBelow = Math.max(0, bounds.bottom - toolbarRect.bottom - contextMenuGap);
  const availableAbove = Math.max(0, toolbarRect.top - bounds.top - contextMenuGap);
  const side = menuHeight <= availableBelow
    ? "bottom"
    : menuHeight <= availableAbove
      ? "top"
      : availableBelow >= availableAbove ? "bottom" : "top";
  const maxHeight = Math.max(0, Math.floor(side === "bottom" ? availableBelow : availableAbove));
  const preferredLeft = align === "center"
    ? (toolbarRect.width - menuWidth) / 2
    : leftOffset;
  const absoluteLeft = clamp(
    toolbarRect.left + preferredLeft,
    bounds.left,
    Math.max(bounds.left, bounds.right - menuWidth),
  );
  return {
    left: Math.round((absoluteLeft - toolbarRect.left) * 100) / 100,
    maxHeight,
    side,
  };
}

export function WorkbenchScreenContextToolbar({
  model,
  onAlign,
  onCopyLink,
  onDelete,
  onDistribute,
  onDuplicate,
  onExport,
  onGenerate,
  onGenerateVariants,
  onModify,
  onOpenVersions,
  onPreview,
  onRename,
  onToggleFavourite,
  onToggleDislike,
  onToggleLike,
}: WorkbenchScreenContextToolbarProps) {
  const [menu, setMenu] = useState<ToolbarMenu>(null);
  const pendingMenuFocusRef = useRef<"first" | "last">("first");
  const actionBarRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<OpenToolbarMenu, HTMLButtonElement | null>>({
    align: null,
    distribute: null,
    more: null,
  });
  const menuIdBase = useId();
  const selectionKey = model?.nodeIds.join("\u0000") ?? "";
  const [toolbarRef, toolbarCollisionStyle] = useToolbarViewportCollision(
    selectionKey,
    menu,
  );

  const menuId = useCallback(
    (kind: OpenToolbarMenu) => `${menuIdBase}-${kind}-menu`,
    [menuIdBase],
  );
  const triggerId = useCallback(
    (kind: OpenToolbarMenu) => `${menuIdBase}-${kind}-trigger`,
    [menuIdBase],
  );

  const closeMenuAndRestoreFocus = useCallback((kind: OpenToolbarMenu) => {
    setMenu(null);
    scheduleAnimationFrame(() => {
      const trigger = triggerRefs.current[kind];
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    });
  }, []);

  const openMenu = useCallback((kind: OpenToolbarMenu, focus: "first" | "last" = "first") => {
    pendingMenuFocusRef.current = focus;
    setMenu(kind);
  }, []);

  const toggleMenu = useCallback((kind: OpenToolbarMenu) => {
    setMenu((current) => {
      if (current === kind) return null;
      pendingMenuFocusRef.current = "first";
      return kind;
    });
  }, []);

  const handleMenuTriggerKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    kind: OpenToolbarMenu,
  ) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openMenu(kind, event.key === "ArrowUp" ? "last" : "first");
  }, [openMenu]);

  useEffect(() => setMenu(null), [selectionKey]);

  useEffect(() => {
    const resetActionBarScroll = () => {
      if (actionBarRef.current) actionBarRef.current.scrollLeft = 0;
    };
    resetActionBarScroll();
    window.addEventListener("resize", resetActionBarScroll);
    window.visualViewport?.addEventListener("resize", resetActionBarScroll);
    return () => {
      window.removeEventListener("resize", resetActionBarScroll);
      window.visualViewport?.removeEventListener("resize", resetActionBarScroll);
    };
  }, [selectionKey]);

  useEffect(() => {
    if (!menu) return;
    const frame = scheduleAnimationFrame(() => {
      const menuElement = document.getElementById(menuId(menu));
      if (menuElement) focusMenuBoundary(menuElement, pendingMenuFocusRef.current);
    });
    return () => cancelScheduledAnimationFrame(frame);
  }, [menu, menuId]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-screen-context-toolbar]")) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenuAndRestoreFocus(menu);
    };
    window.addEventListener("mousedown", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeMenuAndRestoreFocus, menu]);

  if (!model || model.nodeIds.length === 0) return null;

  const invoke = (action: () => void) => {
    setMenu(null);
    action();
  };

  const rootClassName = "relative flex min-w-0 max-w-[calc(100vw-24px)] flex-col items-center gap-[7px]";
  const rootStyle: CSSProperties = {
    ...toolbarCollisionStyle,
    maxWidth: "calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))",
  };

  return (
    <NodeToolbar
      align="center"
      className="nodrag nopan nowheel z-[70] max-w-[calc(100vw-24px)] text-[#f1f3f4]"
      data-screen-context-toolbar
      isVisible
      nodeId={model.nodeIds}
      offset={12}
      position={Position.Top}
    >
      {model.kind === "single" ? (
        <div
          className={rootClassName}
          data-screen-context-toolbar-surface
          ref={toolbarRef}
          style={rootStyle}
        >
          <div className="flex min-w-0 h-[40px] max-w-full items-center overflow-x-auto rounded-full border border-white/[0.10] bg-[#18191b]/96 p-[3px] shadow-[0_18px_60px_-34px_rgba(0,0,0,0.95)] backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" ref={actionBarRef}>
            <ToolbarTextButton
              disabled={!model.availability.canGenerate}
              label="Generate"
              onClick={() => invoke(onGenerate)}
            />
            <ToolbarTextButton
              disabled={!model.availability.canModify}
              label="Modify"
              onClick={() => invoke(onModify)}
            />
            <ToolbarTextButton
              disabled={!model.availability.canPreview}
              icon={PlayIcon}
              label={model.previewAction === "preview" ? "Preview" : "Generate prototype"}
              onClick={() => invoke(onPreview)}
            />
            <ToolbarTextButton
              active={menu === "more"}
              ariaControls={menuId("more")}
              expanded={menu === "more"}
              hasPopup="menu"
              icon={ChevronDownIcon}
              id={triggerId("more")}
              label="More"
              onClick={() => toggleMenu("more")}
              onKeyDown={(event) => handleMenuTriggerKeyDown(event, "more")}
              ref={(node) => {
                triggerRefs.current.more = node;
              }}
            />
          </div>
          <div className="flex h-[24px] max-w-full items-center gap-[9px] text-[13px] font-medium leading-[19px] text-[#e8eaed]">
            <button
              aria-label={`Rename ${model.title}`}
              className="flex min-w-0 items-center gap-[8px] text-left hover:text-white disabled:cursor-default disabled:text-[#e8eaed]"
              disabled={!model.availability.canRename}
              onClick={() => invoke(onRename)}
              title="Rename"
              type="button"
            >
              <FrameIcon className="size-[16px] shrink-0 text-[#c7cad0]" />
              <span className="max-w-[min(420px,calc(100vw-170px))] truncate">{model.title}</span>
            </button>
            <span className="shrink-0 text-[#aeb3bb]">{formatDimension(model.width)} x {formatDimension(model.height)}</span>
            <GripIcon aria-hidden="true" className="size-[16px] shrink-0 text-[#8f949c]" />
          </div>
          <AnimatePresence>
            {menu === "more" && (
              <ContextMenu
                align="center"
                id={menuId("more")}
                labelledBy={triggerId("more")}
                onClose={() => closeMenuAndRestoreFocus("more")}
                onDismiss={() => setMenu(null)}
                toolbarRef={toolbarRef}
              >
                <ContextMenuItem
                  disabled={!model.availability.canRename}
                  icon={PencilIcon}
                  label="Rename"
                  onClick={() => invoke(onRename)}
                />
                <ContextMenuItem
                  disabled={!model.availability.canDuplicate}
                  icon={CopyIcon}
                  label="Duplicate"
                  onClick={() => invoke(onDuplicate)}
                />
                <ContextMenuItem
                  checked={model.favourite}
                  disabled={!model.availability.canToggleFavourite || model.favouriteBusy}
                  icon={StarIcon}
                  label={model.favourite ? "Unfavourite" : "Favourite"}
                  onClick={() => invoke(onToggleFavourite)}
                  roleType="menuitemcheckbox"
                />
                <div aria-label="Reaction" role="group">
                  <ContextMenuItem
                    active={model.reaction === "like"}
                    checked={model.reaction === "like"}
                    disabled={!model.availability.canToggleReaction || model.favouriteBusy}
                    icon={ThumbsUpIcon}
                    label="Like"
                    onClick={() => invoke(onToggleLike)}
                    roleType="menuitemradio"
                  />
                  <ContextMenuItem
                    active={model.reaction === "dislike"}
                    checked={model.reaction === "dislike"}
                    disabled={!model.availability.canToggleReaction || model.favouriteBusy}
                    icon={ThumbsDownIcon}
                    label="Dislike"
                    onClick={() => invoke(onToggleDislike)}
                    roleType="menuitemradio"
                  />
                </div>
                <ContextMenuItem
                  disabled={!model.availability.canOpenVersions}
                  icon={HistoryIcon}
                  label="Version history"
                  onClick={() => invoke(onOpenVersions)}
                />
                <ContextMenuItem
                  disabled={!model.availability.canCopyLink}
                  icon={LinkIcon}
                  label="Copy link"
                  onClick={() => invoke(onCopyLink)}
                />
                <ContextMenuItem
                  disabled={!model.availability.canExport}
                  icon={DownloadIcon}
                  label="Export"
                  onClick={() => invoke(onExport)}
                />
                <div className="my-[5px] h-px bg-white/[0.08]" role="separator" />
                <ContextMenuItem
                  danger
                  disabled={!model.availability.canDelete}
                  icon={Trash2Icon}
                  label="Delete"
                  onClick={() => invoke(onDelete)}
                />
              </ContextMenu>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <div
          className={rootClassName}
          data-screen-context-toolbar-surface
          ref={toolbarRef}
          style={rootStyle}
        >
          <div className="flex min-w-0 h-[42px] max-w-full items-center overflow-x-auto rounded-full border border-white/[0.10] bg-[#18191b]/96 p-[3px] shadow-[0_18px_60px_-34px_rgba(0,0,0,0.95)] backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" ref={actionBarRef}>
            <ToolbarTextButton
              active={menu === "align"}
              ariaControls={menuId("align")}
              disabled={!model.availability.canAlign}
              expanded={menu === "align"}
              hasPopup="menu"
              icon={ChevronDownIcon}
              id={triggerId("align")}
              label="Align"
              onClick={() => toggleMenu("align")}
              onKeyDown={(event) => handleMenuTriggerKeyDown(event, "align")}
              ref={(node) => {
                triggerRefs.current.align = node;
              }}
            />
            <ToolbarTextButton
              active={menu === "distribute"}
              ariaControls={menuId("distribute")}
              disabled={!model.availability.canDistribute}
              expanded={menu === "distribute"}
              hasPopup="menu"
              icon={ChevronDownIcon}
              id={triggerId("distribute")}
              label="Distribute"
              onClick={() => toggleMenu("distribute")}
              onKeyDown={(event) => handleMenuTriggerKeyDown(event, "distribute")}
              ref={(node) => {
                triggerRefs.current.distribute = node;
              }}
            />
            <ToolbarTextButton
              disabled={!model.availability.canDuplicate}
              icon={CopyIcon}
              label="Duplicate"
              onClick={() => invoke(onDuplicate)}
            />
            <ToolbarTextButton
              danger
              disabled={!model.availability.canDelete}
              icon={Trash2Icon}
              label="Delete"
              onClick={() => invoke(onDelete)}
            />
            <ToolbarTextButton
              disabled={!model.availability.canExport}
              icon={DownloadIcon}
              label="Export"
              onClick={() => invoke(onExport)}
            />
            <ToolbarTextButton
              disabled={!model.availability.canPreview}
              icon={PlayIcon}
              label={model.previewAction === "preview" ? "Preview" : "Generate prototype"}
              onClick={() => invoke(onPreview)}
            />
            <ToolbarTextButton
              disabled={!model.availability.canGenerateVariants}
              icon={SparklesIcon}
              label="Generate variants"
              onClick={() => invoke(onGenerateVariants)}
            />
          </div>
          <div className="h-[20px] text-[13px] font-medium leading-[20px] text-[#aeb3bb]">
            {model.count} selected
          </div>
          <AnimatePresence>
            {menu === "align" && (
              <ContextMenu
                align="start"
                id={menuId("align")}
                labelledBy={triggerId("align")}
                onClose={() => closeMenuAndRestoreFocus("align")}
                onDismiss={() => setMenu(null)}
                toolbarRef={toolbarRef}
              >
                {alignItems.map((item) => (
                  <ContextMenuItem
                    icon={item.icon}
                    key={item.label}
                    label={item.label}
                    onClick={() => invoke(() => onAlign(item.operation))}
                  />
                ))}
              </ContextMenu>
            )}
            {menu === "distribute" && (
              <ContextMenu
                align="start"
                id={menuId("distribute")}
                labelledBy={triggerId("distribute")}
                leftOffset={86}
                onClose={() => closeMenuAndRestoreFocus("distribute")}
                onDismiss={() => setMenu(null)}
                toolbarRef={toolbarRef}
              >
                {distributeItems.map((item) => (
                  <ContextMenuItem
                    icon={item.icon}
                    key={item.label}
                    label={item.label}
                    onClick={() => invoke(() => onDistribute(item.operation))}
                  />
                ))}
              </ContextMenu>
            )}
          </AnimatePresence>
        </div>
      )}
    </NodeToolbar>
  );
}

const alignItems: Array<{
  icon: typeof AlignStartVerticalIcon;
  label: string;
  operation: Extract<BoardNodeArrangeOperation, { kind: "align" }>;
}> = [
  { icon: AlignStartVerticalIcon, label: "Left", operation: { kind: "align", alignment: "left" } },
  { icon: AlignCenterVerticalIcon, label: "Horizontal center", operation: { kind: "align", alignment: "center" } },
  { icon: AlignEndVerticalIcon, label: "Right", operation: { kind: "align", alignment: "right" } },
  { icon: AlignStartHorizontalIcon, label: "Top", operation: { kind: "align", alignment: "top" } },
  { icon: AlignCenterHorizontalIcon, label: "Vertical center", operation: { kind: "align", alignment: "middle" } },
  { icon: AlignEndHorizontalIcon, label: "Bottom", operation: { kind: "align", alignment: "bottom" } },
];

const distributeItems: Array<{
  icon: typeof AlignHorizontalDistributeCenterIcon;
  label: string;
  operation: Extract<BoardNodeArrangeOperation, { kind: "distribute" }>;
}> = [
  {
    icon: AlignHorizontalDistributeCenterIcon,
    label: "Horizontal spacing",
    operation: { kind: "distribute", axis: "horizontal" },
  },
  {
    icon: AlignVerticalDistributeCenterIcon,
    label: "Vertical spacing",
    operation: { kind: "distribute", axis: "vertical" },
  },
];

type ToolbarTextButtonProps = {
  active?: boolean;
  ariaControls?: string;
  danger?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  hasPopup?: "menu";
  icon?: typeof PlayIcon;
  id?: string;
  label: string;
  onClick: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
};

const ToolbarTextButton = forwardRef<HTMLButtonElement, ToolbarTextButtonProps>(function ToolbarTextButton({
  active = false,
  ariaControls,
  danger = false,
  disabled = false,
  expanded,
  hasPopup,
  icon: Icon,
  id,
  label,
  onClick,
  onKeyDown,
}, ref) {
  return (
    <button
      aria-controls={ariaControls}
      aria-expanded={expanded}
      aria-haspopup={hasPopup}
      className={cn(
        "flex h-[34px] shrink-0 items-center gap-[6px] rounded-full px-[10px] text-[14px] font-medium transition-colors active:scale-[0.97]",
        active ? "bg-white/[0.10] text-white" : "text-[#e8eaed] hover:bg-white/[0.07]",
        danger && "text-[#f2a7a7] hover:bg-[#ef8c8c]/10",
        disabled && "cursor-not-allowed opacity-40 active:scale-100",
      )}
      disabled={disabled}
      id={id}
      onClick={onClick}
      onKeyDown={onKeyDown}
      ref={ref}
      type="button"
    >
      <span>{label}</span>
      {Icon && <Icon aria-hidden="true" className="size-[14px] shrink-0" />}
    </button>
  );
});

function ContextMenu({
  align,
  children,
  id,
  leftOffset = 0,
  labelledBy,
  onClose,
  onDismiss,
  toolbarRef,
}: {
  align: "center" | "start";
  children: ReactNode;
  id: string;
  leftOffset?: number;
  labelledBy: string;
  onClose: () => void;
  onDismiss: () => void;
  toolbarRef: RefObject<HTMLDivElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useContextMenuPlacement(
    menuRef,
    toolbarRef,
    align,
    leftOffset,
  );

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "absolute z-20 w-[224px] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[8px] border border-white/[0.09] bg-[#18191b]/98 p-[6px] shadow-[0_24px_80px_-36px_rgba(0,0,0,0.98)] backdrop-blur-xl",
      )}
      data-screen-context-menu
      data-side={placement.side}
      exit={{ opacity: 0, y: placement.side === "bottom" ? -3 : 3 }}
      id={id}
      initial={{ opacity: 0, y: placement.side === "bottom" ? -3 : 3 }}
      onKeyDown={(event) => handleContextMenuKeyDown(event, menuRef, onClose, onDismiss)}
      role="menu"
      aria-labelledby={labelledBy}
      ref={menuRef}
      style={{
        left: placement.left,
        maxHeight: placement.maxHeight || undefined,
        ...(placement.side === "bottom"
          ? { top: `calc(100% + ${contextMenuGap}px)` }
          : { bottom: `calc(100% + ${contextMenuGap}px)` }),
      }}
      transition={popoverTransition}
    >
      {children}
    </motion.div>
  );
}

function ContextMenuItem({
  active = false,
  checked,
  danger = false,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  roleType = "menuitem",
}: {
  active?: boolean;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  icon: typeof PencilIcon;
  label: string;
  onClick: () => void;
  roleType?: "menuitem" | "menuitemcheckbox" | "menuitemradio";
}) {
  return (
    <button
      className={cn(
        "flex h-[36px] w-full items-center gap-[10px] rounded-[6px] px-[9px] text-left text-[13px] font-medium transition-colors hover:bg-white/[0.06]",
        danger ? "text-[#f2a7a7]" : "text-[#e8eaed]",
        active && "bg-white/[0.09] text-white",
        disabled && "cursor-not-allowed opacity-40",
      )}
      aria-checked={roleType === "menuitem" ? undefined : checked}
      disabled={disabled}
      onClick={onClick}
      onPointerMove={(event) => {
        if (!event.currentTarget.disabled) event.currentTarget.focus();
      }}
      role={roleType}
      tabIndex={-1}
      type="button"
    >
      <Icon aria-hidden="true" className="size-[15px] shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function useToolbarViewportCollision(
  selectionKey: string,
  menu: ToolbarMenu,
): [RefObject<HTMLDivElement | null>, CSSProperties] {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const measure = useCallback(() => {
    const element = toolbarRef.current;
    if (!element) return;
    const displayedRect = toFloatingRect(element.getBoundingClientRect());
    const renderedOffset = readInlineTranslate3d(element.style.transform);
    const baseRect = translateFloatingRect(displayedRect, -renderedOffset.x, -renderedOffset.y);
    const bounds = getCanvasViewportBounds(element, baseRect);
    const nextOffset = calculateToolbarCollisionOffset(baseRect, bounds);
    setOffset((currentOffset) => (
      nextOffset.x === currentOffset.x && nextOffset.y === currentOffset.y
        ? currentOffset
        : nextOffset
    ));
  }, []);

  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = scheduleAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    schedule();

    const parent = element.parentElement;
    const mutationObserver = typeof MutationObserver === "function" && parent
      ? new MutationObserver(schedule)
      : null;
    mutationObserver?.observe(parent!, { attributes: true, attributeFilter: ["style", "class"] });

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(schedule)
      : null;
    resizeObserver?.observe(element);
    const flow = element.closest<HTMLElement>(".react-flow");
    if (flow) resizeObserver?.observe(flow);
    for (const obstacle of document.querySelectorAll<HTMLElement>(
      "[data-right-tool-rail], [data-project-composer], [data-utility-pill]",
    )) {
      resizeObserver?.observe(obstacle);
    }

    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame !== null) cancelScheduledAnimationFrame(frame);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [measure, menu, selectionKey]);

  return [toolbarRef, {
    transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
  }];
}

function useContextMenuPlacement(
  menuRef: RefObject<HTMLDivElement | null>,
  toolbarRef: RefObject<HTMLDivElement | null>,
  align: "center" | "start",
  leftOffset: number,
): WorkbenchContextMenuPlacement {
  const [placement, setPlacement] = useState<WorkbenchContextMenuPlacement>({
    left: align === "center" ? 0 : leftOffset,
    maxHeight: 360,
    side: "bottom",
  });

  const measure = useCallback(() => {
    const menuElement = menuRef.current;
    const toolbarElement = toolbarRef.current;
    if (!menuElement || !toolbarElement) return;
    const toolbarRect = toFloatingRect(toolbarElement.getBoundingClientRect());
    const menuRect = toFloatingRect(menuElement.getBoundingClientRect());
    const menuHeight = Math.max(menuElement.scrollHeight, menuRect.height);
    const menuWidth = Math.max(menuElement.offsetWidth, menuRect.width, contextMenuWidth);
    const predictedRect: WorkbenchFloatingRect = {
      ...menuRect,
      bottom: toolbarRect.bottom + contextMenuGap + menuHeight,
      left: toolbarRect.left,
      right: toolbarRect.left + menuWidth,
      top: toolbarRect.bottom + contextMenuGap,
      width: menuWidth,
      height: menuHeight,
    };
    const bounds = getCanvasViewportBounds(toolbarElement, predictedRect);
    const nextPlacement = calculateContextMenuPlacement({
      align,
      bounds,
      leftOffset,
      menuHeight,
      menuWidth,
      toolbarRect,
    });
    setPlacement((current) => current.left === nextPlacement.left
      && current.maxHeight === nextPlacement.maxHeight
      && current.side === nextPlacement.side
      ? current
      : nextPlacement);
  }, [align, leftOffset, menuRef, toolbarRef]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    const toolbarElement = toolbarRef.current;
    if (!element || !toolbarElement) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = scheduleAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    schedule();
    const parent = toolbarElement.parentElement;
    const mutationObserver = typeof MutationObserver === "function" && parent
      ? new MutationObserver(schedule)
      : null;
    mutationObserver?.observe(parent!, { attributes: true, attributeFilter: ["style", "class"] });
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(schedule)
      : null;
    resizeObserver?.observe(element);
    resizeObserver?.observe(toolbarElement);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame !== null) cancelScheduledAnimationFrame(frame);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [measure, menuRef, toolbarRef]);

  return placement;
}

function handleContextMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  menuRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
  onDismiss: () => void,
) {
  const menu = menuRef.current;
  if (!menu) return;
  const items = getEnabledMenuItems(menu);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const triggerId = menu.getAttribute("aria-labelledby");
    const trigger = triggerId ? document.getElementById(triggerId) : null;
    onDismiss();
    scheduleAnimationFrame(() => focusAdjacentTabStop(trigger, event.shiftKey));
    return;
  }
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? delta > 0 ? 0 : items.length - 1
      : (currentIndex + delta + items.length) % items.length;
    focusElement(items[nextIndex]!);
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusElement(items[event.key === "Home" ? 0 : items.length - 1]!);
    return;
  }
  if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const needle = event.key.toLocaleLowerCase();
    const start = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    const ordered = [...items.slice(start), ...items.slice(0, start)];
    const match = ordered.find((item) => item.textContent?.trim().toLocaleLowerCase().startsWith(needle));
    if (match) {
      event.preventDefault();
      focusElement(match);
    }
  }
}

function focusMenuBoundary(menu: HTMLElement, boundary: "first" | "last") {
  const items = getEnabledMenuItems(menu);
  const item = boundary === "first" ? items[0] : items[items.length - 1];
  if (item) focusElement(item);
}

function getEnabledMenuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
  )).filter((item) => {
    const button = item as HTMLButtonElement;
    return !button.disabled && item.getAttribute("aria-disabled") !== "true";
  });
}

function focusAdjacentTabStop(trigger: HTMLElement | null, backwards: boolean) {
  if (!trigger) return;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    "button, a[href], input, select, textarea, [tabindex]",
  )).filter((element) => (
    !element.hasAttribute("disabled")
    && element.getAttribute("aria-hidden") !== "true"
    && element.tabIndex >= 0
  ));
  const index = candidates.indexOf(trigger);
  if (index < 0) {
    focusElement(trigger);
    return;
  }
  const next = candidates[index + (backwards ? -1 : 1)] ?? trigger;
  focusElement(next);
}

function focusElement(element: HTMLElement) {
  element.focus({ preventScroll: true });
}

function toFloatingRect(rect: Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">): WorkbenchFloatingRect {
  const width = Number.isFinite(rect.width) && rect.width > 0 ? rect.width : Math.max(0, rect.right - rect.left);
  const height = Number.isFinite(rect.height) && rect.height > 0 ? rect.height : Math.max(0, rect.bottom - rect.top);
  return {
    bottom: rect.bottom,
    height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width,
  };
}

function translateFloatingRect(rect: WorkbenchFloatingRect, x: number, y: number): WorkbenchFloatingRect {
  return {
    ...rect,
    bottom: rect.bottom + y,
    left: rect.left + x,
    right: rect.right + x,
    top: rect.top + y,
  };
}

function readInlineTranslate3d(transform: string): { x: number; y: number } {
  const match = /^translate3d\((-?(?:\d+\.?\d*|\.\d+))px,\s*(-?(?:\d+\.?\d*|\.\d+))px,\s*0(?:px)?\)$/.exec(
    transform.trim(),
  );
  if (!match) return { x: 0, y: 0 };
  return { x: Number(match[1]), y: Number(match[2]) };
}

function getCanvasViewportBounds(
  anchor: HTMLElement,
  floatingRect: WorkbenchFloatingRect,
): WorkbenchFloatingBounds {
  const flow = anchor.closest<HTMLElement>(".react-flow");
  const flowRect = flow ? toFloatingRect(flow.getBoundingClientRect()) : null;
  const viewport = window.visualViewport;
  const windowWidth = window.innerWidth || document.documentElement.clientWidth || floatingRect.right;
  const windowHeight = window.innerHeight || document.documentElement.clientHeight || floatingRect.bottom;
  const visualLeft = viewport?.offsetLeft ?? 0;
  const visualTop = viewport?.offsetTop ?? 0;
  const visualRight = visualLeft + (viewport?.width || windowWidth);
  const visualBottom = visualTop + (viewport?.height || windowHeight);
  let bounds: WorkbenchFloatingBounds = {
    bottom: Math.min(flowRect?.bottom || visualBottom, visualBottom) - floatingViewportMargin,
    left: Math.max(flowRect?.left || visualLeft, visualLeft) + floatingViewportMargin,
    right: Math.min(flowRect?.right || visualRight, visualRight) - floatingViewportMargin,
    top: Math.max(flowRect?.top || visualTop, visualTop) + floatingViewportMargin,
  };

  const rail = document.querySelector<HTMLElement>("[data-right-tool-rail]");
  if (rail) {
    const railRect = toFloatingRect(rail.getBoundingClientRect());
    if (hasArea(railRect) && overlapsVertically(floatingRect, railRect)) {
      const leftEdge = railRect.left - floatingObstacleGap;
      const rightEdge = railRect.right + floatingObstacleGap;
      const topEdge = railRect.top - floatingObstacleGap;
      const bottomEdge = railRect.bottom + floatingObstacleGap;
      const horizontalCandidates = [
        floatingRect.width <= leftEdge - bounds.left
          ? { distance: Math.abs(leftEdge - floatingRect.right), side: "left" as const }
          : null,
        floatingRect.width <= bounds.right - rightEdge
          ? { distance: Math.abs(rightEdge - floatingRect.left), side: "right" as const }
          : null,
      ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
      const horizontal = horizontalCandidates.sort((left, right) => left.distance - right.distance)[0];
      if (horizontal?.side === "left") {
        bounds = { ...bounds, right: Math.min(bounds.right, leftEdge) };
      } else if (horizontal?.side === "right") {
        bounds = { ...bounds, left: Math.max(bounds.left, rightEdge) };
      } else {
        const verticalCandidates = [
          floatingRect.height <= topEdge - bounds.top
            ? { distance: Math.abs(topEdge - floatingRect.bottom), side: "top" as const }
            : null,
          floatingRect.height <= bounds.bottom - bottomEdge
            ? { distance: Math.abs(bottomEdge - floatingRect.top), side: "bottom" as const }
            : null,
        ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
        const vertical = verticalCandidates.sort((top, bottom) => top.distance - bottom.distance)[0];
        if (vertical?.side === "top") {
          bounds = { ...bounds, bottom: Math.min(bounds.bottom, topEdge) };
        } else if (vertical?.side === "bottom") {
          bounds = { ...bounds, top: Math.max(bounds.top, bottomEdge) };
        }
      }
    }
  }

  for (const obstacle of document.querySelectorAll<HTMLElement>(
    "[data-project-composer], [data-utility-pill]",
  )) {
    const obstacleRect = toFloatingRect(obstacle.getBoundingClientRect());
    if (!hasArea(obstacleRect) || !overlapsHorizontally(floatingRect, obstacleRect)) continue;
    if (obstacleRect.top >= floatingRect.top + floatingRect.height / 2) {
      bounds = { ...bounds, bottom: Math.min(bounds.bottom, obstacleRect.top - floatingObstacleGap) };
    } else if (obstacleRect.bottom <= floatingRect.top + floatingRect.height / 2) {
      bounds = { ...bounds, top: Math.max(bounds.top, obstacleRect.bottom + floatingObstacleGap) };
    }
  }

  return {
    bottom: Math.max(bounds.top + 1, bounds.bottom),
    left: Math.min(bounds.left, bounds.right - 1),
    right: Math.max(bounds.left + 1, bounds.right),
    top: Math.min(bounds.bottom - 1, bounds.top),
  };
}

function hasArea(rect: WorkbenchFloatingRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function overlapsHorizontally(left: WorkbenchFloatingRect, right: WorkbenchFloatingRect): boolean {
  return left.left < right.right && left.right > right.left;
}

function overlapsVertically(top: WorkbenchFloatingRect, bottom: WorkbenchFloatingRect): boolean {
  return top.top < bottom.bottom && top.bottom > bottom.top;
}

function scheduleAnimationFrame(callback: () => void): number | null {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    callback();
    return null;
  }
  return window.requestAnimationFrame(callback);
}

function cancelScheduledAnimationFrame(frame: number | null) {
  if (frame !== null && typeof window !== "undefined") window.cancelAnimationFrame(frame);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function formatDimension(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : "-";
}
