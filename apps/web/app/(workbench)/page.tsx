"use client";

import { HomeScreen } from "@/components/workbench/workbench-home-screen";
import { useWorkbenchHomeController } from "@/lib/workbench/features/workbench-home-controller";

export default function WorkbenchHomePage() {
  const controller = useWorkbenchHomeController();

  return <HomeScreen {...controller} />;
}
