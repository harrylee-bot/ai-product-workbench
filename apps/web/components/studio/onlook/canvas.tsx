// Derived from Onlook (Copyright 2024 On Off, Inc.), Apache-2.0.
// Upstream: apps/web/client/src/app/project/[id]/_components/canvas/index.tsx @ 423e2e924366419e418ee049093872d535eea41a
// Modified: Workbench service boundary, scoped state, accessible light UI.
// See third_party/onlook for original source, license and modification ledger.
"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const ZOOM_SENSITIVITY = 0.006;
const PAN_SENSITIVITY = 0.52;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const MAX_X = 10000;
const MAX_Y = 10000;
const MIN_X = -5000;
const MIN_Y = -5000;
export type CanvasPosition = { x: number; y: number };
export function clampZoom(scale: number) {
  return Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM);
}
export function clampPosition(position: CanvasPosition, scale: number) {
  return {
    x: Math.min(Math.max(position.x, MIN_X * scale), MAX_X * scale),
    y: Math.min(Math.max(position.y, MIN_Y * scale), MAX_Y * scale),
  };
}
/** Preserves upstream bounded pointer-centered zoom/pan. Frozen artifacts are not draggable code frames. */
export function Canvas({
  children,
  width,
  height,
  scale,
  onScale,
  onRenderedScale,
  panMode = false,
}: {
  children: ReactNode;
  width: number;
  height: number;
  scale: number | null;
  onScale: (value: number | null) => void;
  onRenderedScale?: (value: number) => void;
  panMode?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 24, y: 24 });
  const [size, setSize] = useState({ width: 1000, height: 650 });
  const [panning, setPanning] = useState(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const fitScale = Math.min(
    1,
    (size.width - 48) / width,
    (size.height - 48) / height,
  );
  const renderedScale = scale ?? Math.max(MIN_ZOOM, fitScale);
  const renderedPosition =
    scale === null
      ? { x: Math.max(24, (size.width - width * renderedScale) / 2), y: 24 }
      : position;
  const state = useRef({ renderedPosition, renderedScale });
  state.current = { renderedPosition, renderedScale };
  useEffect(() => {
    onRenderedScale?.(renderedScale);
  }, [renderedScale, onRenderedScale]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: container.clientWidth, height: container.clientHeight }),
    );
    setSize({ width: container.clientWidth, height: container.clientHeight });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (event.target instanceof HTMLTextAreaElement || !containerRef.current)
        return;
      event.preventDefault();
      const { renderedPosition: position, renderedScale: currentScale } =
        state.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = containerRef.current.getBoundingClientRect();
        const x = event.clientX - rect.left,
          y = event.clientY - rect.top;
        const newScale = clampZoom(
          currentScale * (1 - event.deltaY * ZOOM_SENSITIVITY),
        );
        const zoomFactor = newScale / currentScale - 1;
        onScale(newScale);
        setPosition(
          clampPosition(
            {
              x: position.x - (x - position.x) * zoomFactor,
              y: position.y - (y - position.y) * zoomFactor,
            },
            newScale,
          ),
        );
      } else {
        const deltaX =
          (event.deltaX + (event.shiftKey ? event.deltaY : 0)) *
          PAN_SENSITIVITY;
        const deltaY = (event.shiftKey ? 0 : event.deltaY) * PAN_SENSITIVITY;
        onScale(currentScale);
        setPosition(
          clampPosition(
            { x: position.x - deltaX, y: position.y - deltaY },
            currentScale,
          ),
        );
      }
    },
    [onScale],
  );
  useEffect(() => {
    const div = containerRef.current;
    if (!div) return;
    div.addEventListener("wheel", handleWheel, { passive: false });
    return () => div.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);
  const transformStyle = useMemo(
    () => ({
      transform: `translate(${renderedPosition.x}px, ${renderedPosition.y}px) scale(${renderedScale})`,
      transformOrigin: "0 0",
      width,
      height,
    }),
    [renderedPosition.x, renderedPosition.y, renderedScale, width, height],
  );
  return (
    <div
      ref={containerRef}
      className="studio-onlook-canvas"
      tabIndex={0}
      aria-label="页面舞台，方向键平移，0 适应页面"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "0") {
          onScale(null);
          return;
        }
        const moves: Record<string, CanvasPosition> = {
          ArrowLeft: { x: 60, y: 0 },
          ArrowRight: { x: -60, y: 0 },
          ArrowUp: { x: 0, y: 60 },
          ArrowDown: { x: 0, y: -60 },
        };
        const move = moves[e.key];
        if (move) {
          e.preventDefault();
          onScale(renderedScale);
          setPosition(
            clampPosition(
              {
                x: renderedPosition.x + move.x,
                y: renderedPosition.y + move.y,
              },
              renderedScale,
            ),
          );
        }
      }}
    >
      <div className="studio-canvas-transform" style={transformStyle}>
        {children}
      </div>
      {panMode && (
        <div
          className="studio-pan-overlay"
          style={{ cursor: panning ? "grabbing" : "grab" }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pointer.current = { x: e.clientX, y: e.clientY };
            setPanning(true);
            onScale(renderedScale);
            setPosition(renderedPosition);
          }}
          onPointerMove={(e) => {
            const before = pointer.current;
            if (!before) return;
            pointer.current = { x: e.clientX, y: e.clientY };
            setPosition((p) =>
              clampPosition(
                {
                  x: p.x + e.clientX - before.x,
                  y: p.y + e.clientY - before.y,
                },
                renderedScale,
              ),
            );
          }}
          onPointerUp={() => {
            pointer.current = null;
            setPanning(false);
          }}
          onPointerCancel={() => {
            pointer.current = null;
            setPanning(false);
          }}
        />
      )}
      <button
        type="button"
        className="studio-recenter"
        onClick={() => onScale(null)}
      >
        适应页面 · {Math.round(renderedScale * 100)}%
      </button>
    </div>
  );
}
