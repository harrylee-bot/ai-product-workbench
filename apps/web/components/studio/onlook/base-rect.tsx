// Derived from Onlook (Copyright 2024 On Off, Inc.), Apache-2.0.
// Upstream: apps/web/client/src/app/project/[id]/_components/canvas/overlay/elements/rect/base.tsx @ 423e2e924366419e418ee049093872d535eea41a
// Modified: Workbench service boundary, scoped state, accessible light UI.
// See third_party/onlook for original source, license and modification ledger.

export type RectDimensions = {
  width: number;
  height: number;
  top: number;
  left: number;
};

import React from "react";

export interface RectProps extends RectDimensions {
  isComponent?: boolean;
  className?: string;
  children?: React.ReactNode;
  strokeWidth?: number;
}

export const BaseRect: React.FC<RectProps> = ({
  width,
  height,
  top,
  left,
  isComponent,
  className,
  children,
  strokeWidth = 2,
}) => {
  if (
    width === undefined ||
    height === undefined ||
    top === undefined ||
    left === undefined
  ) {
    return null;
  }

  return (
    <div
      style={{
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        pointerEvents: "none",
      }}
      className={className}
      data-onlook-ignore="true"
      data-testid="selection-outline"
    >
      <svg
        overflow="visible"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <rect
          width={width}
          height={height}
          fill="none"
          stroke={isComponent ? "#7c3aed" : "#2563eb"}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {children}
      </svg>
    </div>
  );
};
