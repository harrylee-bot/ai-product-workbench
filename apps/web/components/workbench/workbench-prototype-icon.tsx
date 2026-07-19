"use client";

import dynamicIconImports from "lucide-react/dynamicIconImports.js";
import {
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
  type SVGProps,
} from "react";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;
type IconLoader = () => Promise<{ default: IconComponent }>;

const loaders = dynamicIconImports as unknown as Record<string, IconLoader | undefined>;
const iconCache = new Map<string, LazyExoticComponent<IconComponent>>();

export function WorkbenchPrototypeIcon({ iconName }: { iconName: string }) {
  const normalized = normalizeLucideIconName(iconName);
  const loader = loaders[normalized];
  if (!loader) return <span aria-hidden="true">{iconName}</span>;
  let Icon = iconCache.get(normalized);
  if (!Icon) {
    Icon = lazy(loader);
    iconCache.set(normalized, Icon);
  }
  return (
    <Suspense fallback={<span aria-hidden="true" />}>
      <Icon aria-hidden="true" height="100%" width="100%" />
    </Suspense>
  );
}

export function normalizeLucideIconName(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}
