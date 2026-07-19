"use client";

import type { ArtifactVersionPreference } from "@workbench/workbench-contracts";
import { StarIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import {
  createContext,
  useContext,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  type SVGProps,
} from "react";

import { cn } from "@/lib/utils";

export type WorkbenchArtifactPreferenceAction = "dislike" | "favorite" | "like";

export type WorkbenchArtifactPreferenceController = {
  artifactVersionId: string;
  screenId: string;
  busy: boolean;
  preference: Pick<ArtifactVersionPreference, "favorite" | "reaction"> | null;
  onToggle: (action: WorkbenchArtifactPreferenceAction) => void;
};

const WorkbenchArtifactPreferenceContext = createContext<
  WorkbenchArtifactPreferenceController | null
>(null);

export function WorkbenchArtifactPreferenceProvider({
  children,
  controller,
}: {
  children: ReactNode;
  controller: WorkbenchArtifactPreferenceController | null;
}) {
  return (
    <WorkbenchArtifactPreferenceContext.Provider value={controller}>
      {children}
    </WorkbenchArtifactPreferenceContext.Provider>
  );
}

export function WorkbenchArtifactPreferenceActions({
  artifactVersionId,
  screenId,
}: {
  artifactVersionId: string | null;
  screenId: string | null;
}) {
  const candidate = useContext(WorkbenchArtifactPreferenceContext);
  const controller = candidate?.artifactVersionId === artifactVersionId
    && candidate.screenId === screenId
    ? candidate
    : null;
  const available = Boolean(controller?.preference);
  const actions: Array<{
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    id: WorkbenchArtifactPreferenceAction;
    label: string;
    pressed: boolean;
  }> = [
    {
      icon: StarIcon,
      id: "favorite",
      label: "收藏界面",
      pressed: controller?.preference?.favorite ?? false,
    },
    {
      icon: ThumbsUpIcon,
      id: "like",
      label: "喜欢",
      pressed: controller?.preference?.reaction === "like",
    },
    {
      icon: ThumbsDownIcon,
      id: "dislike",
      label: "不喜欢",
      pressed: controller?.preference?.reaction === "dislike",
    },
  ];

  const toggle = (event: MouseEvent<HTMLButtonElement>, action: WorkbenchArtifactPreferenceAction) => {
    event.stopPropagation();
    if (!controller?.preference || controller.busy) return;
    controller.onToggle(action);
  };

  return actions.map((action) => {
    const Icon = action.icon;
    return (
      <button
        aria-label={action.label}
        aria-pressed={action.pressed}
        className={cn(
          "grid size-[24px] place-items-center rounded-full text-[#d8dce2] transition-colors hover:bg-white/[0.08] hover:text-[#f1f3f4] disabled:cursor-not-allowed disabled:opacity-45",
          action.pressed && "bg-white/[0.10] text-[#f1f3f4]",
        )}
        disabled={!available || controller?.busy}
        key={action.id}
        onClick={(event) => toggle(event, action.id)}
        title={available ? action.label : "偏好尚未就绪"}
        type="button"
      >
        <Icon className={cn("size-[15px]", action.id === "favorite" && action.pressed && "fill-current")} />
      </button>
    );
  });
}
