// Derived from Onlook (Copyright 2024 On Off, Inc.), Apache-2.0.
// Upstream: apps/web/client/src/app/project/[id]/_components/canvas/overlay/elements/rect/hover.tsx @ 423e2e924366419e418ee049093872d535eea41a
// Modified: Workbench service boundary, scoped state, accessible light UI.
// See third_party/onlook for original source, license and modification ledger.
import type { RectDimensions } from "./base-rect";
import React from "react";
import { BaseRect } from "./base-rect";

interface HoverRectProps {
  rect: RectDimensions | null;
  isComponent?: boolean;
}

export const HoverRect: React.FC<HoverRectProps> = ({ rect, isComponent }) => {
  if (!rect) {
    return null;
  }
  return <BaseRect {...rect} isComponent={isComponent} strokeWidth={1} />;
};
