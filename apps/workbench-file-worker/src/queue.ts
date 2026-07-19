import type { Queue } from "pg-boss";
import {
  blobGcQueueOptions as sharedBlobGcQueueOptions,
  fileExtractQueueOptions as sharedFileExtractQueueOptions,
  knowledgeReleaseBuildQueueOptions as sharedKnowledgeReleaseBuildQueueOptions,
} from "@workbench/workbench-contracts";

export const blobGcRetryLimit = sharedBlobGcQueueOptions.retryLimit;
export const fileVerifyRetryLimit = 5;
export const fileExtractRetryLimit = sharedFileExtractQueueOptions.retryLimit;
export const knowledgeReleaseBuildRetryLimit = sharedKnowledgeReleaseBuildQueueOptions.retryLimit;

export const fileVerifyQueueOptions = {
  policy: "short",
  retryLimit: fileVerifyRetryLimit,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 10 * 60,
  heartbeatSeconds: 30,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  notify: true,
} satisfies Omit<Queue, "name">;

export const fileExtractQueueOptions = sharedFileExtractQueueOptions satisfies Omit<Queue, "name">;

export const knowledgeReleaseBuildQueueOptions = sharedKnowledgeReleaseBuildQueueOptions satisfies Omit<Queue, "name">;

export const blobGcQueueOptions = sharedBlobGcQueueOptions satisfies Omit<Queue, "name">;
