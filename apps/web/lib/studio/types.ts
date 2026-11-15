import type {
  RunDesignStyle,
  RunTargetSurface,
  StartRunRequest,
} from "@workbench/workbench-contracts";
export type StudioSubmission = {
  prompt: string;
  modelId: string;
  workflow: StartRunRequest["workflow"];
  targetSurface: RunTargetSurface;
  designStyle: RunDesignStyle;
  sourceIds: string[];
  files: File[];
  onFileSource?: (file: File, sourceId: string) => void;
  pinnedSourceIds?: string[];
  requestedArtifactKinds: StartRunRequest["requestedArtifactKinds"];
  artifactTargets: StartRunRequest["artifactTargets"];
  generationIntent: StartRunRequest["generationIntent"];
  prdScreenPlan?: StartRunRequest["prdScreenPlan"];
};
export type StudioView =
  | "pages"
  | "documents"
  | "resources"
  | "knowledge"
  | "runs"
  | "publishing"
  | "project";

export type StudioArtifactContext = {
  title: string;
  workflow: "edit" | "generate";
  generationIntent?: StartRunRequest["generationIntent"];
  prdScreenPlan?: StartRunRequest["prdScreenPlan"];
  artifactTargets: StartRunRequest["artifactTargets"];
  requestedArtifactKinds: StartRunRequest["requestedArtifactKinds"];
};

export type StudioPlanTarget = {
  kind: "draft" | "revision";
  id: string;
  etag: string;
  feedbackIds?: string[];
};
