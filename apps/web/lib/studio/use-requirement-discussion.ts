"use client";
import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  canonicalJson,
  createRequirementSessionRequestSchema,
  postRequirementMessageRequestSchema,
  confirmRequirementRequestSchema,
  requirementConfirmationSchema,
  type RequirementContext,
  type RequirementSession,
  type ThreadEntry,
} from "@workbench/workbench-contracts";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import {
  createIdempotencyKey,
  type Versioned,
} from "@/lib/workbench/transport/contracts";
import { useWorkbenchProjectsApi } from "./api";
import { useStudioRequirementApi } from "./requirement-api";
import { studioRecordKey, useStudioStoredRecord } from "./stored-record";
import { useStudioInputPreparation } from "./use-input-preparation";
import type { StudioSubmission } from "./types";

const addressed = {
  sessionId: z.string().min(1),
  etag: z.string().min(1),
  key: z.string().min(8),
};
const commandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      key: addressed.key,
      request: createRequirementSessionRequestSchema,
      messageKey: addressed.key,
      message: postRequirementMessageRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      ...addressed,
      request: postRequirementMessageRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirm"),
      ...addressed,
      request: confirmRequirementRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("turn"),
      ...addressed,
      turnId: z.string().min(1),
      action: z.enum(["cancel", "retry"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispatch"),
      ...addressed,
      confirmationId: z.string().min(1),
      summaryVersion: z.number().int().positive(),
      summaryChecksum: z.string().min(1),
    })
    .strict(),
]);
const recordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().optional(),
    command: commandSchema.optional(),
    requiresReview: z.boolean().optional(),
    awaitingResult: z.boolean().optional(),
    awaitingConfirmationId: z.string().optional(),
    awaitingTurnId: z.string().optional(),
    baseline: requirementConfirmationSchema.optional(),
  })
  .strict();
type Command = z.infer<typeof commandSchema>;
class InactiveDiscussion extends Error {}

export function explicitSuggestionIntent(text: string) {
  return /^(按建议直接生成|按以上建议直接生成|确认需求并生成)[。！!\s]*$/u.test(
    text.trim(),
  )
    ? ("confirm_suggestion" as const)
    : ("discuss" as const);
}

const denied = (error: unknown) =>
  isWorkbenchApiError(error) && [401, 403, 404].includes(error.status);
const mergeEntries = (...lists: readonly (readonly ThreadEntry[])[]) =>
  [...new Map(lists.flat().map((entry) => [entry.id, entry])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  );

export function useRequirementDiscussion({
  projectId,
  threadId,
  context,
  contextKey,
  canEdit,
  enabled = true,
  initialEntries = [],
  operation,
}: {
  projectId: string;
  threadId: string;
  context: RequirementContext;
  contextKey: string;
  canEdit: boolean;
  enabled?: boolean;
  initialEntries?: readonly ThreadEntry[];
  operation?: Pick<
    StudioSubmission,
    "workflow" | "artifactTargets" | "generationIntent" | "prdScreenPlan"
  >;
}) {
  const api = useStudioRequirementApi(),
    projects = useWorkbenchProjectsApi(),
    client = useQueryClient();
  const { user } = useWorkbenchAuth();
  const input = useStudioInputPreparation(projectId);
  const key = studioRecordKey(
    user?.id,
    projectId,
    "requirement-discussion-v1",
    threadId,
    contextKey,
  );
  const local = useStudioStoredRecord(key, recordSchema);
  const identity = `${user?.id ?? ""}:${projectId}:${threadId}:${contextKey}`;
  const currentScope = useRef(identity);
  currentScope.current = identity;
  const [pendingScope, setPendingScope] = useState("");
  const [accessFailure, setAccessFailure] = useState<{
    identity: string;
    error: Error;
  } | null>(null);
  const revoked = accessFailure?.identity === identity;
  const busy = useRef<{ isCurrent: () => boolean } | null>(null);
  const scopeCurrent = () =>
    currentScope.current === identity && local.isCurrent();
  const check = () => {
    if (!scopeCurrent()) throw new InactiveDiscussion();
  };
  const persist = (value: z.infer<typeof recordSchema>) => {
    check();
    if (
      !local.save({
        ...value,
        baseline:
          value.baseline ??
          local.value?.baseline ??
          (snapshot.data?.value.confirmation?.status === "started"
            ? snapshot.data.value.confirmation
            : undefined),
      })
    )
      throw new Error(
        "无法保存本次操作的恢复记录，请恢复浏览器存储后重试；需求尚未发送。",
      );
  };
  const queryPrefix = [
    "studio",
    "requirement-discussion",
    user?.id ?? "",
    projectId,
    threadId,
    contextKey,
  ];
  const matches = (session: RequirementSession) =>
    session.projectId === projectId &&
    session.threadId === threadId &&
    canonicalJson(session.context) === canonicalJson(context) &&
    (!operation ||
      canonicalJson({
        workflow: session.generationRequest.workflow,
        artifactTargets: session.generationRequest.artifactTargets,
        generationIntent: session.generationRequest.generationIntent,
        prdScreenPlan: session.generationRequest.prdScreenPlan ?? null,
      }) ===
        canonicalJson({
          ...operation,
          prdScreenPlan: operation.prdScreenPlan ?? null,
        }));
  const list = useInfiniteQuery({
    queryKey: [...queryPrefix, "list"],
    enabled: enabled && !!user && !!threadId && !revoked,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const result = await api.list(threadId, {
        cursor: pageParam,
        limit: 100,
      });
      if (
        result.items.some(
          (session) =>
            session.projectId !== projectId || session.threadId !== threadId,
        )
      )
        throw new Error("讨论目录与当前项目不匹配");
      return result;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const directory = [
    ...new Map(
      (list.data?.pages.flatMap((page) => page.items) ?? [])
        .filter(matches)
        .map((session) => [session.id, session]),
    ).values(),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // An unrelated first page must never cause a duplicate discussion. Continue
  // reading until a matching fixed context is found, or the catalog is exhausted.
  const searchingDirectory =
    !local.value?.sessionId &&
    !directory.length &&
    (list.isPending || !!list.hasNextPage);
  useEffect(() => {
    if (
      enabled &&
      !revoked &&
      searchingDirectory &&
      list.hasNextPage &&
      !list.isFetching &&
      !list.error
    )
      void list.fetchNextPage();
  }, [enabled, revoked, searchingDirectory, list]);
  const sessionId = local.value?.sessionId ?? directory[0]?.id ?? "";
  const snapshotKey = (id: string) => [...queryPrefix, "session", id];
  const snapshot = useQuery({
    queryKey: snapshotKey(sessionId),
    enabled:
      enabled && !!user && !!sessionId && !revoked && !denied(list.error),
    queryFn: async () => {
      const result = await api.get(sessionId);
      if (result.value.id !== sessionId || !matches(result.value))
        throw new Error("讨论快照与固定输入上下文不匹配");
      return result;
    },
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data?.value;
      return data &&
        (["analyzing", "confirmed", "generating"].includes(data.state) ||
          data.confirmation?.status === "pending")
        ? 1500
        : 5000;
    },
  });
  const accessDenied = revoked || denied(list.error) || denied(snapshot.error);
  const confirmedBaseline = snapshot.data?.value.confirmation;
  useEffect(() => {
    if (
      accessDenied ||
      !enabled ||
      local.value?.command ||
      confirmedBaseline?.status !== "started" ||
      local.value?.baseline?.id === confirmedBaseline.id
    )
      return;
    local.save({
      ...local.value,
      version: 1,
      sessionId,
      baseline: confirmedBaseline,
    });
  }, [accessDenied, enabled, confirmedBaseline, local, sessionId]);
  const entriesKey = [...queryPrefix, "entries"];
  const seed = initialEntries.filter((entry) => entry.threadId === threadId);
  // Bootstrap supplies the latest 500 entries. Read new messages from that
  // sequence, independently of the ASC cursor used for older history.
  const tail = useQuery({
    queryKey: [...entriesKey, "live"],
    enabled: enabled && !!user && !!threadId && !accessDenied,
    queryFn: async () => {
      let current = mergeEntries(
        seed,
        client.getQueryData<ThreadEntry[]>([...entriesKey, "live"]) ?? [],
      );
      for (let page = 0; page < 5; page++) {
        const result = await projects.listThreadEntries(threadId, {
          afterSequence: current.at(-1)?.sequence ?? 0,
          limit: 100,
        });
        if (result.items.some((entry) => entry.threadId !== threadId))
          throw new Error("交流记录不属于当前项目对话");
        current = mergeEntries(current, result.items);
        if (result.nextAfterSequence === null) break;
      }
      return current;
    },
    refetchInterval: snapshot.data?.value.state === "analyzing" ? 1500 : 5000,
    retry: false,
  });
  const history = useInfiniteQuery({
    queryKey: [...entriesKey, "history"],
    enabled: false,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const result = await projects.listThreadEntries(threadId, {
        afterSequence: pageParam,
        limit: 50,
      });
      if (result.items.some((entry) => entry.threadId !== threadId))
        throw new Error("交流记录不属于当前项目对话");
      return result;
    },
    getNextPageParam: (page) => page.nextAfterSequence ?? undefined,
    retry: false,
  });
  const privateDenied =
    accessDenied || denied(tail.error) || denied(history.error);
  useEffect(() => {
    if (!privateDenied) return;
    const error = [list.error, snapshot.error, tail.error, history.error].find(
      denied,
    );
    if (error) setAccessFailure({ identity, error });
    local.clear();
    client.removeQueries({ queryKey: queryPrefix });
    // The denied transition clears this scope once; mutable helper identities
    // must not repeatedly remove/refetch an unavailable discussion.
  }, [privateDenied, identity, client]);
  const remember = (result: Versioned<RequirementSession>) => {
    check();
    if (!matches(result.value))
      throw new Error("返回的需求讨论与当前项目或源版本不匹配");
    client.setQueryData(snapshotKey(result.value.id), result);
    void client.invalidateQueries({ queryKey: [...queryPrefix, "list"] });
    void client.invalidateQueries({ queryKey: [...queryPrefix, "entries"] });
  };
  const execute = async (initial: Command): Promise<RequirementSession> => {
    check();
    let command = initial;
    if (command.kind === "create") {
      const created = await api.create(threadId, command.request, command.key);
      remember(created);
      command = {
        kind: "message",
        sessionId: created.value.id,
        etag: created.etag,
        key: command.messageKey,
        request: command.message,
      };
      persist({ version: 1, sessionId: created.value.id, command });
    }
    let result: Versioned<RequirementSession>;
    try {
      if (command.kind === "message")
        result = await api.message(
          command.sessionId,
          command.request,
          command.etag,
          command.key,
        );
      else if (command.kind === "confirm")
        result = await api.confirm(
          command.sessionId,
          command.request,
          command.etag,
          command.key,
        );
      else if (command.kind === "dispatch")
        result = await api.retryConfirmation(
          command.sessionId,
          command.confirmationId,
          command.etag,
          command.key,
        );
      else
        result = await api.turn(
          command.action,
          command.sessionId,
          command.turnId,
          command.etag,
          command.key,
        );
    } catch (cause) {
      check();
      if (isWorkbenchApiError(cause) && [409, 412].includes(cause.status)) {
        persist({
          version: 1,
          sessionId: command.sessionId,
          command,
          requiresReview: true,
        });
        void client.invalidateQueries({
          queryKey: snapshotKey(command.sessionId),
        });
      }
      throw cause;
    }
    const receipt = result.value.confirmation;
    if (
      (command.kind === "confirm" &&
        (!receipt ||
          receipt.summaryVersion !== command.request.summaryVersion ||
          receipt.summaryChecksum !== command.request.summaryChecksum)) ||
      (command.kind === "dispatch" &&
        (!receipt ||
          receipt.id !== command.confirmationId ||
          receipt.summaryVersion !== command.summaryVersion ||
          receipt.summaryChecksum !== command.summaryChecksum))
    )
      throw new Error(
        "生成回执与本次确认不匹配，请恢复原操作核实，未打开其他任务",
      );
    if (result.value.id !== command.sessionId)
      throw new Error("需求回执与本次讨论不匹配");
    remember(result);
    const starts =
      command.kind === "confirm" ||
      command.kind === "dispatch" ||
      (command.kind === "message" &&
        command.request.intent === "confirm_suggestion");
    const retains = command.kind === "turn" && command.action === "retry";
    persist({
      version: 1,
      sessionId: result.value.id,
      baseline: receipt?.status === "started" ? receipt : undefined,
      awaitingResult: starts || (retains && local.value?.awaitingResult),
      awaitingConfirmationId: starts
        ? receipt?.id
        : retains
          ? local.value?.awaitingConfirmationId
          : undefined,
      awaitingTurnId: starts
        ? receipt
          ? undefined
          : result.value.activeTurn?.id
        : retains
          ? local.value?.awaitingTurnId
          : undefined,
    });
    return result.value;
  };
  const perform = async (action: () => Promise<RequirementSession | null>) => {
    if (!enabled) throw new Error("固定来源尚未恢复完成，请稍后重试。");
    if (privateDenied)
      throw new Error("当前需求讨论已无法访问，请重新核对项目权限");
    if (!canEdit) throw new Error("当前权限只能查看需求讨论");
    if (busy.current?.isCurrent()) return null;
    const task = { isCurrent: scopeCurrent };
    busy.current = task;
    setPendingScope(identity);
    try {
      check();
      return await action();
    } catch (cause) {
      if (cause instanceof InactiveDiscussion) return null;
      if (denied(cause) && scopeCurrent())
        setAccessFailure({ identity, error: cause as Error });
      throw cause;
    } finally {
      if (busy.current === task) busy.current = null;
      if (scopeCurrent()) setPendingScope("");
    }
  };
  const requireSettledCommand = () => {
    if (local.value?.command && !local.value.requiresReview)
      throw new Error(
        "上次操作的回执尚未核实，请先恢复结果，避免重复发送或生成。",
      );
  };
  const send = (submission: StudioSubmission) =>
    perform(async () => {
      requireSettledCommand();
      if (
        searchingDirectory ||
        list.isPending ||
        (sessionId && snapshot.isPending)
      )
        throw new Error("正在恢复已有需求讨论，请稍候再发送");
      if (!local.value?.sessionId && list.error) throw list.error;
      if (!threadId) throw new Error("项目对话尚未就绪，请重新加载");
      if (
        context.kind === "revision" &&
        new Set(context.feedbackIds).size + (context.anchor ? 1 : 0) > 100
      )
        throw new Error("每次修订最多采用 100 条批注，请先减少已选批注。");
      const generationRequest = await input.prepare(submission, check);
      const request = postRequirementMessageRequestSchema.parse({
        text: submission.prompt.trim(),
        generationRequest,
        intent: explicitSuggestionIntent(submission.prompt),
      });
      const latest = sessionId
        ? local.value?.requiresReview
          ? await api.get(sessionId)
          : (snapshot.data ?? (await api.get(sessionId)))
        : null;
      check();
      if (latest && !matches(latest.value))
        throw new Error("讨论快照与当前固定来源不匹配，需求尚未发送");
      const command: Command = latest
        ? {
            kind: "message",
            sessionId,
            etag: latest.etag,
            key: createIdempotencyKey("requirement-message"),
            request,
          }
        : {
            kind: "create",
            key: createIdempotencyKey("requirement-session"),
            request: { generationRequest, context },
            messageKey: createIdempotencyKey("requirement-message"),
            message: request,
          };
      persist({ version: 1, sessionId: sessionId || undefined, command });
      return execute(command);
    });
  const confirm = (review: {
    id: string;
    version: number;
    acceptPlatformChanges: boolean;
  }) =>
    perform(async () => {
      requireSettledCommand();
      if (local.value?.requiresReview)
        throw new Error("请先重新核对最新摘要，再确认生成");
      const current = snapshot.data;
      if (
        !current ||
        current.value.id !== review.id ||
        current.value.summaryVersion !== review.version ||
        !current.value.summaryChecksum ||
        current.value.state !== "ready_to_confirm"
      )
        throw new Error("改动摘要已变化，请先核对最新版本");
      const request = confirmRequirementRequestSchema.parse({
        summaryVersion: review.version,
        summaryChecksum: current.value.summaryChecksum,
        acceptedAssumptionIds:
          current.value.card?.assumptions?.map((item) => item.id) ?? [],
        acceptedPlatformChanges: review.acceptPlatformChanges,
      });
      const command: Command = {
        kind: "confirm",
        sessionId,
        etag: current.etag,
        key: createIdempotencyKey("requirement-confirm"),
        request,
      };
      persist({ version: 1, sessionId, command });
      return execute(command);
    });
  const recover = () =>
    perform(async () => {
      if (!local.value?.command) return snapshot.data?.value ?? null;
      if (local.value.requiresReview)
        throw new Error(
          "内容已更新，请核对最新摘要后重新发送或确认，不能重放旧版本。",
        );
      if (local.value.command.kind !== "create") {
        const current = await api.get(local.value.command.sessionId);
        check();
        if (
          current.value.id !== local.value.command.sessionId ||
          !matches(current.value)
        )
          throw new Error("恢复记录不属于当前项目及固定来源，未重放操作");
      }
      persist(local.value);
      return execute(local.value.command);
    });
  const turn = (action: "cancel" | "retry") =>
    perform(async () => {
      requireSettledCommand();
      const current = snapshot.data;
      if (!current?.value.activeTurn)
        throw new Error("当前没有可操作的需求分析");
      const command: Command = {
        kind: "turn",
        sessionId,
        etag: current.etag,
        key: createIdempotencyKey(`requirement-${action}`),
        turnId: current.value.activeTurn.id,
        action,
      };
      persist({
        version: 1,
        sessionId,
        command,
        awaitingResult: local.value?.awaitingResult,
        awaitingConfirmationId: local.value?.awaitingConfirmationId,
        awaitingTurnId: local.value?.awaitingTurnId,
      });
      return execute(command);
    });
  const retryGeneration = () =>
    perform(async () => {
      requireSettledCommand();
      if (local.value?.requiresReview) throw new Error("请先核对最新需求状态");
      const current = snapshot.data;
      const receipt = current?.value.confirmation;
      if (!current || receipt?.status !== "pending")
        throw new Error("当前没有等待启动的已确认任务，请重新读取状态");
      const command: Command = {
        kind: "dispatch",
        sessionId,
        etag: current.etag,
        key: createIdempotencyKey("requirement-dispatch"),
        confirmationId: receipt.id,
        summaryVersion: receipt.summaryVersion,
        summaryChecksum: receipt.summaryChecksum,
      };
      persist({ version: 1, sessionId, command });
      return execute(command);
    });
  const messages =
    privateDenied || !enabled
      ? []
      : mergeEntries(
          seed,
          tail.data ?? [],
          history.data?.pages.flatMap((page) => page.items) ?? [],
        );
  const firstSeed = seed[0]?.sequence ?? 1;
  const lastHistorical = history.data?.pages.at(-1);
  const hasMore =
    firstSeed > 1 &&
    (!lastHistorical ||
      (!!lastHistorical.nextAfterSequence &&
        (lastHistorical.items.at(-1)?.sequence ?? 0) < firstSeed - 1));
  return {
    snapshot: privateDenied || !enabled ? undefined : snapshot.data?.value,
    messages,
    generationBaseline:
      privateDenied || !enabled
        ? undefined
        : snapshot.data?.value.confirmation?.status === "started"
          ? snapshot.data.value.confirmation
          : (local.value?.baseline ??
            directory.find(
              (session) => session.confirmation?.status === "started",
            )?.confirmation ??
            undefined),
    generationResult:
      enabled &&
      !privateDenied &&
      local.value?.awaitingResult &&
      !local.value.command &&
      !local.value.requiresReview &&
      confirmedBaseline?.status === "started" &&
      (local.value.awaitingConfirmationId
        ? confirmedBaseline.id === local.value.awaitingConfirmationId
        : !!local.value.awaitingTurnId &&
          snapshot.data?.value.activeTurn?.id === local.value.awaitingTurnId)
        ? confirmedBaseline
        : undefined,
    directory,
    sessionId,
    hasMoreSessions: !!list.hasNextPage,
    loadingSessions: list.isFetching,
    loadMoreSessions: async () => {
      if (enabled && !privateDenied && list.hasNextPage && !list.isFetching)
        await list.fetchNextPage();
    },
    selectSession: (id: string) => {
      check();
      if (
        !enabled ||
        privateDenied ||
        busy.current?.isCurrent() ||
        local.value?.command ||
        local.value?.requiresReview
      )
        throw new Error("请先核实当前操作，再切换需求讨论");
      if (!directory.some((session) => session.id === id))
        throw new Error("所选讨论与当前固定来源不匹配");
      persist({ version: 1, sessionId: id });
    },
    hasMore,
    retryGeneration,
    send,
    confirm,
    recover,
    turn,
    loadMore: async () => {
      if (privateDenied || !enabled) return;
      if (!history.data) await history.refetch();
      else await history.fetchNextPage();
    },
    uploads: input.uploads,
    pending: pendingScope === identity,
    loading:
      searchingDirectory ||
      list.isPending ||
      (!!sessionId && snapshot.isPending),
    error:
      (revoked ? accessFailure.error : null) ??
      snapshot.error ??
      list.error ??
      tail.error ??
      history.error,
    storageError: local.error,
    command: local.value?.command,
    requiresReview: !!local.value?.requiresReview,
    awaitingResult: !!local.value?.awaitingResult,
    acknowledgeResult: () =>
      local.save({
        version: 1,
        sessionId,
        baseline:
          local.value?.baseline ??
          (confirmedBaseline?.status === "started"
            ? confirmedBaseline
            : undefined),
      }),
    reviewLatest: async () => {
      check();
      if (!sessionId || !local.value?.requiresReview) return;
      const latest = await api.get(sessionId);
      remember(latest);
      persist({
        version: 1,
        sessionId,
        awaitingResult: local.value.awaitingResult,
        awaitingConfirmationId: local.value.awaitingConfirmationId,
        awaitingTurnId: local.value.awaitingTurnId,
      });
    },
    refresh: async () => {
      setAccessFailure(null);
      await Promise.all([
        list.refetch(),
        ...(sessionId ? [snapshot.refetch()] : []),
        tail.refetch(),
      ]);
    },
  };
}
