// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, type PropsWithChildren } from "react";
import {
  requirementDiscussionRequestSchema,
  requirementSessionSchema,
} from "@workbench/workbench-contracts";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  message: vi.fn(),
  confirm: vi.fn(),
  retryConfirmation: vi.fn(),
  turn: vi.fn(),
  prepare: vi.fn(),
  messages: vi.fn(),
}));
vi.mock("@/lib/auth/workbench-auth", () => ({
  useWorkbenchAuth: () => ({ user: { id: "actor-one" } }),
}));
vi.mock("./requirement-api", () => ({ useStudioRequirementApi: () => mocks }));
vi.mock("./use-input-preparation", () => ({
  useStudioInputPreparation: () => ({ prepare: mocks.prepare, uploads: [] }),
}));
import { WorkbenchApiError } from "@/lib/workbench/api";
import {
  explicitSuggestionIntent,
  useRequirementDiscussion,
} from "./use-requirement-discussion";
import type { StudioSubmission } from "./types";
const request = requirementDiscussionRequestSchema.parse({
  prompt: "增加活动领取次数",
  modelId: "chosen-model",
  workflow: "generate",
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  sourceIds: [],
  requestedArtifactKinds: ["prd", "prototype"],
  artifactTargets: [],
  generationIntent: null,
  canvasSnapshot: null,
});
const input = { ...request, files: [] } as StudioSubmission;
const now = "2026-11-17T00:00:00.000Z";
const session = (extra = {}) =>
  requirementSessionSchema.parse({
    id: "session-one",
    projectId: "project-one",
    threadId: "thread-one",
    revision: 1,
    state: "discussing",
    context: { kind: "new" },
    generationRequest: request,
    summaryVersion: 0,
    summaryChecksum: null,
    card: null,
    evidence: [],
    activeTurn: null,
    confirmation: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
const ready = () =>
  session({
    state: "ready_to_confirm",
    summaryVersion: 2,
    summaryChecksum: "a".repeat(64),
    card: {
      goal: "增加领取限制",
      platform: "活动平台",
      modules: ["规则配置"],
      roles: ["策划"],
      existingCapabilities: [],
      reuse: [],
      changes: ["新增领取次数字段"],
      affectedPages: ["规则页"],
      affectedFlows: ["领取"],
      targetSurface: "web",
      designConstraints: [],
      outputKinds: ["prd", "prototype"],
      assumptions: [{ id: "a-one", text: "沿用字段布局", evidenceIds: [] }],
      issues: [],
      platformChanges: [],
      preserved: ["登录"],
    },
  });
const receipt = (extra = {}) => ({
  id: "confirmation-one",
  summaryVersion: 2,
  summaryChecksum: "a".repeat(64),
  status: "started",
  failureCode: null,
  acceptedAssumptionIds: ["a-one"],
  acceptedPlatformChanges: false,
  confirmedAt: now,
  planId: "plan-one",
  runId: "run-one",
  ...extra,
});
const versioned = (value = session()) => ({
  value,
  etag: `"${value.revision}"`,
});
const failure = (status: number) =>
  new WorkbenchApiError({
    type: "about:blank",
    status,
    title: "Fixture failure",
    code: `HTTP_${status}`,
  });
let clients: QueryClient[] = [];
function setup(extra = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    (props: { contextKey: string; canEdit: boolean; enabled?: boolean }) =>
      useRequirementDiscussion({
        projectId: "project-one",
        threadId: "thread-one",
        context: { kind: "new" },
        ...props,
        ...extra,
      }),
    { wrapper, initialProps: { contextKey: "new", canEdit: true } },
  );
  return { ...hook, client };
}
beforeEach(() => {
  sessionStorage.clear();
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.get.mockResolvedValue(versioned());
  mocks.create.mockResolvedValue(versioned());
  mocks.message.mockResolvedValue(
    versioned(session({ revision: 2, state: "analyzing" })),
  );
  mocks.confirm.mockResolvedValue(
    versioned(
      session({ revision: 3, state: "generating", confirmation: receipt() }),
    ),
  );
  mocks.prepare.mockResolvedValue(request);
  mocks.messages.mockImplementation(async sessionId => ({
    sessionId,
    items: [],
    nextCursor: null,
  }));
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients = [];
  vi.restoreAllMocks();
});
it("ordinary send persists a discussion and message without confirming or creating an artifact Run", async () => {
  const hook = setup();
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    await hook.result.current.send(input);
  });
  expect(mocks.create).toHaveBeenCalledWith(
    "thread-one",
    { generationRequest: request, context: { kind: "new" } },
    expect.any(String),
  );
  expect(mocks.message).toHaveBeenCalledWith(
    "session-one",
    { text: input.prompt, generationRequest: request, intent: "discuss" },
    '"1"',
    expect.any(String),
  );
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(hook.result.current.command).toBeUndefined();
});
it("replays the exact message key and ETag after a lost response, including after remount", async () => {
  mocks.message.mockRejectedValueOnce(failure(503));
  const first = setup();
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  await act(async () => {
    await expect(first.result.current.send(input)).rejects.toThrow();
  });
  const sent = mocks.message.mock.calls[0];
  first.unmount();
  const second = setup();
  await waitFor(() =>
    expect(second.result.current.command?.kind).toBe("message"),
  );
  await act(async () => {
    await second.result.current.recover();
  });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.message.mock.calls[1]).toEqual(sent);
});
it("does not send any mutation when the recovery key cannot be saved", async () => {
  const hook = setup();
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await act(async () => {
    await expect(hook.result.current.send(input)).rejects.toThrow("无法保存");
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.message).not.toHaveBeenCalled();
});
it("requires an explicit latest review after CAS rejection instead of silently replaying an old confirmation", async () => {
  const current = versioned(ready());
  mocks.list.mockResolvedValue({ items: [current.value] });
  mocks.get.mockResolvedValue(current);
  mocks.confirm.mockRejectedValueOnce(failure(412));
  const hook = setup();
  await waitFor(() =>
    expect(hook.result.current.snapshot?.state).toBe("ready_to_confirm"),
  );
  const review = {
    id: "session-one",
    version: 2,
    acceptPlatformChanges: false,
  };
  await act(async () => {
    await expect(hook.result.current.confirm(review)).rejects.toThrow();
  });
  await waitFor(() => expect(hook.result.current.requiresReview).toBe(true));
  await act(async () => {
    await expect(hook.result.current.recover()).rejects.toThrow("不能重放");
  });
  await act(async () => {
    await expect(hook.result.current.confirm(review)).rejects.toThrow(
      "先重新核对",
    );
  });
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  await act(async () => {
    await hook.result.current.reviewLatest();
  });
  await act(async () => {
    await hook.result.current.confirm(review);
  });
  expect(mocks.confirm.mock.calls[1][3]).not.toBe(
    mocks.confirm.mock.calls[0][3],
  );
});
it("confirms one fixed summary/checksum and explicitly accepts displayed suggestions", async () => {
  mocks.list.mockResolvedValue({ items: [ready()] });
  mocks.get.mockResolvedValue(versioned(ready()));
  const hook = setup();
  await waitFor(() =>
    expect(hook.result.current.snapshot?.summaryVersion).toBe(2),
  );
  await act(async () => {
    await hook.result.current.confirm({
      id: "session-one",
      version: 2,
      acceptPlatformChanges: true,
    });
  });
  expect(mocks.confirm).toHaveBeenCalledWith(
    "session-one",
    {
      summaryVersion: 2,
      summaryChecksum: "a".repeat(64),
      acceptedAssumptionIds: ["a-one"],
      acceptedPlatformChanges: true,
    },
    '"1"',
    expect.any(String),
  );
  expect(hook.result.current.awaitingResult).toBe(true);
});
it("blocks 101 feedback plus element references before preparing attachments", async () => {
  const hook = setup({
    context: {
      kind: "revision",
      revisionId: "revision-one",
      feedbackIds: Array.from(
        { length: 100 },
        (_, index) => `feedback-${index}`,
      ),
      anchor: {
        sourceRevisionId: "revision-one",
        scope: "node",
        pageId: "page-one",
        nodeId: "node-one",
        quote: "领取",
      },
    },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    await expect(hook.result.current.send(input)).rejects.toThrow("100");
  });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
it("does not bind an artifact operation to an unrelated latest new-project session", async () => {
  mocks.list.mockResolvedValue({ items: [session()] });
  const operation = {
    workflow: "edit",
    artifactTargets: [
      {
        artifactId: "artifact-one",
        artifactVersionId: "version-one",
        screenIds: [],
      },
    ],
    generationIntent: null,
  };
  const hook = setup({ operation });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.snapshot).toBeUndefined();
  expect(mocks.get).not.toHaveBeenCalled();
});
it("ignores a late response after leaving and returning to the same discussion scope", async () => {
  let resolve!: (value: ReturnType<typeof versioned>) => void;
  mocks.create.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const hook = setup();
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  let sent!: Promise<unknown>;
  act(() => {
    sent = hook.result.current.send(input);
  });
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  hook.rerender({ contextKey: "other", canEdit: true });
  hook.rerender({ contextKey: "new", canEdit: true });
  await act(async () => {
    resolve(versioned());
    await expect(sent).resolves.toBeNull();
  });
  expect(mocks.message).not.toHaveBeenCalled();
});
it("hides private snapshots and cached messages when authorization is revoked", async () => {
  mocks.list.mockResolvedValue({ items: [ready()] });
  mocks.get.mockResolvedValue(versioned(ready()));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.snapshot?.card).toBeTruthy());
  mocks.get.mockRejectedValue(failure(403));
  mocks.list.mockRejectedValue(failure(403));
  await act(async () => {
    await hook.result.current.refresh();
  });
  await waitFor(() => expect(hook.result.current.snapshot).toBeUndefined());
  expect(hook.result.current.messages).toEqual([]);
  expect(hook.result.current.error?.message).toBe("Fixture failure");
});
it("loads history for the selected discussion from newest to oldest and displays it chronologically", async () => {
  const entry = (sequence: number) => ({
    id: `entry-${sequence}`,
    threadId: "thread-one",
    sequence,
    role: "user",
    kind: "user.prompt",
    content: {
      protocol: "workbench.v1",
      type: "user.prompt",
      text: `消息${sequence}`,
      sourceIds: [],
    },
    producedByRunId: null,
    createdAt: now,
  });
  mocks.list.mockResolvedValue({ items: [session()], nextCursor: null });
  mocks.messages.mockImplementation(async (sessionId, options) => ({
    sessionId,
    items: options.cursor ? [entry(1)] : [entry(501), entry(500)],
    nextCursor: options.cursor ? null : "older",
  }));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(2));
  expect(mocks.messages).toHaveBeenCalledWith("session-one", {
    cursor: undefined,
    limit: 50,
  });
  expect(hook.result.current.hasMore).toBe(true);
  await act(async () => {
    await hook.result.current.loadMore();
  });
  await waitFor(() =>
    expect(
      hook.result.current.messages.map((message) => message.sequence),
    ).toEqual([1, 500, 501]),
  );
});
it("viewer and unrestored input contexts cannot start analysis", async () => {
  const viewer = setup();
  viewer.rerender({ contextKey: "new", canEdit: false });
  await act(async () => {
    await expect(viewer.result.current.send(input)).rejects.toThrow("只能查看");
  });
  const draft = setup({ enabled: false });
  await act(async () => {
    await expect(draft.result.current.send(input)).rejects.toThrow("固定来源");
  });
  expect(mocks.create).not.toHaveBeenCalled();
});
it("recognizes only an explicit whole-message authorization, never a quoted or negative suggestion", () => {
  expect(explicitSuggestionIntent("按建议直接生成！")).toBe(
    "confirm_suggestion",
  );
  for (const text of [
    "不要按建议直接生成",
    "你说按建议直接生成是什么意思",
    "用户写了‘确认需求并生成’",
    "直接生成",
    "请先看看",
  ])
    expect(explicitSuggestionIntent(text)).toBe("discuss");
});

it("retains the frozen generation receipt when later discussion clears the session confirmation", async () => {
  const baseline = {
    id: "confirmation-one",
    summaryVersion: 2,
    summaryChecksum: "a".repeat(64),
    status: "started",
    failureCode: null,
    acceptedAssumptionIds: ["a-one"],
    acceptedPlatformChanges: false,
    confirmedAt: now,
    planId: "plan-one",
    runId: "run-one",
  };
  const started = session({ state: "generating", confirmation: baseline });
  mocks.list.mockResolvedValue({ items: [started] });
  mocks.get.mockResolvedValue(versioned(started));
  const hook = setup();
  await waitFor(() =>
    expect(hook.result.current.generationBaseline?.id).toBe("confirmation-one"),
  );
  await act(async () => {
    await hook.result.current.send(input);
  });
  expect(hook.result.current.snapshot?.confirmation).toBeNull();
  expect(hook.result.current.generationBaseline?.summaryChecksum).toBe(
    "a".repeat(64),
  );
});

it("checks a stored recovery command against its authorized project and source before replay", async () => {
  mocks.message.mockRejectedValueOnce(failure(503));
  const first = setup();
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  await act(async () => {
    await expect(first.result.current.send(input)).rejects.toThrow();
  });
  first.unmount();
  mocks.get.mockResolvedValue(
    versioned(session({ projectId: "other-project" })),
  );
  const second = setup();
  await waitFor(() =>
    expect(second.result.current.command?.kind).toBe("message"),
  );
  await act(async () => {
    await expect(second.result.current.recover()).rejects.toThrow(
      "不属于当前项目",
    );
  });
  expect(mocks.message).toHaveBeenCalledTimes(1);
});

it("scans beyond 100 unrelated discussions and restores the matching source without a duplicate", async () => {
  const unrelated = Array.from({ length: 100 }, (_, i) =>
    session({
      id: `unrelated-${i}`,
      context: {
        kind: "revision",
        revisionId: `revision-${i}`,
        feedbackIds: [],
        anchor: null,
      },
    }),
  );
  mocks.list.mockImplementation(async (_thread, query) =>
    query.cursor
      ? { items: [session()], nextCursor: null }
      : { items: unrelated, nextCursor: "bound-cursor" },
  );
  const hook = setup();
  await waitFor(() =>
    expect(hook.result.current.snapshot?.id).toBe("session-one"),
  );
  expect(mocks.list).toHaveBeenCalledWith("thread-one", {
    cursor: "bound-cursor",
    limit: 100,
  });
  await act(async () => {
    await hook.result.current.send(input);
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.message).toHaveBeenCalledTimes(1);
});
it("recovers dispatch after refresh without the original confirmation key and replays a lost retry exactly", async () => {
  const pending = session({
    state: "confirmed",
    revision: 8,
    confirmation: receipt({
      status: "pending",
      failureCode: "DISPATCH_UNAVAILABLE",
      planId: null,
      runId: null,
    }),
  });
  mocks.list.mockResolvedValue({ items: [pending], nextCursor: null });
  mocks.get.mockResolvedValue(versioned(pending));
  mocks.retryConfirmation
    .mockRejectedValueOnce(failure(503))
    .mockResolvedValueOnce(
      versioned(
        session({ state: "generating", revision: 9, confirmation: receipt() }),
      ),
    );
  const first = setup();
  await waitFor(() => expect(first.result.current.snapshot?.revision).toBe(8));
  await act(async () => {
    await expect(first.result.current.retryGeneration()).rejects.toThrow();
  });
  const sent = mocks.retryConfirmation.mock.calls[0];
  expect(sent).toEqual([
    "session-one",
    "confirmation-one",
    '"8"',
    expect.any(String),
  ]);
  first.unmount();
  const second = setup();
  await waitFor(() =>
    expect(second.result.current.command?.kind).toBe("dispatch"),
  );
  await act(async () => {
    await second.result.current.recover();
  });
  expect(mocks.retryConfirmation.mock.calls[1]).toEqual(sent);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(second.result.current.generationResult?.id).toBe("confirmation-one");
});
it("does not open a later confirmation from another tab while waiting for an earlier one", async () => {
  mocks.list.mockResolvedValue({ items: [ready()], nextCursor: null });
  mocks.get.mockResolvedValue(versioned(ready()));
  mocks.confirm.mockResolvedValue(
    versioned(
      session({
        state: "confirmed",
        confirmation: receipt({ status: "pending", planId: null, runId: null }),
      }),
    ),
  );
  const hook = setup();
  await waitFor(() =>
    expect(hook.result.current.snapshot?.state).toBe("ready_to_confirm"),
  );
  await act(async () => {
    await hook.result.current.confirm({
      id: "session-one",
      version: 2,
      acceptPlatformChanges: false,
    });
  });
  mocks.get.mockResolvedValue(
    versioned(
      session({
        state: "generating",
        confirmation: receipt({ id: "someone-elses-confirmation" }),
      }),
    ),
  );
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(hook.result.current.awaitingResult).toBe(true);
  expect(hook.result.current.generationResult).toBeUndefined();
});
it("keeps the original confirmation command if its response carries a different frozen summary", async () => {
  mocks.list.mockResolvedValue({ items: [ready()], nextCursor: null });
  mocks.get.mockResolvedValue(versioned(ready()));
  mocks.confirm.mockResolvedValue(
    versioned(session({ confirmation: receipt({ summaryVersion: 99 }) })),
  );
  const hook = setup();
  await waitFor(() =>
    expect(hook.result.current.snapshot?.state).toBe("ready_to_confirm"),
  );
  await act(async () => {
    await expect(
      hook.result.current.confirm({
        id: "session-one",
        version: 2,
        acceptPlatformChanges: false,
      }),
    ).rejects.toThrow("不匹配");
  });
  expect(hook.result.current.command?.kind).toBe("confirm");
  expect(hook.result.current.generationResult).toBeUndefined();
});
it("clears automatic opening when ordinary follow-up supersedes an earlier confirmed task", async () => {
  mocks.list.mockResolvedValue({ items: [ready()], nextCursor: null });
  mocks.get.mockResolvedValue(versioned(ready()));
  const hook = setup();
  await waitFor(() =>
    expect(hook.result.current.snapshot?.state).toBe("ready_to_confirm"),
  );
  await act(async () => {
    await hook.result.current.confirm({
      id: "session-one",
      version: 2,
      acceptPlatformChanges: false,
    });
  });
  await act(async () => {
    await hook.result.current.send(input);
  });
  expect(hook.result.current.awaitingResult).toBe(false);
  expect(hook.result.current.generationBaseline?.id).toBe("confirmation-one");
});
it("ignores legacy browser submissions and baselines without migrating or replaying them", async () => {
  sessionStorage.setItem(
    "workbench:studio:actor-one:project-one:requirement-discussion:thread-one:new",
    JSON.stringify({
      version: 1,
      sessionId: "legacy-session",
      baseline: { id: "legacy-confirmation" },
      awaitingResult: true,
    }),
  );
  sessionStorage.setItem(
    "workbench:studio:actor-one:project-one:submission",
    JSON.stringify({ target: { kind: "draft", id: "legacy-draft" } }),
  );
  const hook = setup();
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.storageError).toBe("");
  expect(hook.result.current.command).toBeUndefined();
  expect(hook.result.current.generationResult).toBeUndefined();
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(
    sessionStorage.getItem("workbench:studio:actor-one:project-one:submission"),
  ).toContain("legacy-draft");
});
it("switches only among loaded matching sessions and blocks switching with an unknown receipt", async () => {
  const second = session({ id: "session-two" });
  mocks.list.mockResolvedValue({
    items: [session(), second],
    nextCursor: null,
  });
  mocks.get.mockImplementation(async (id) => versioned(session({ id })));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.directory).toHaveLength(2));
  act(() => hook.result.current.selectSession("session-two"));
  await waitFor(() =>
    expect(hook.result.current.snapshot?.id).toBe("session-two"),
  );
  mocks.message.mockRejectedValueOnce(failure(503));
  await act(async () => {
    await expect(hook.result.current.send(input)).rejects.toThrow();
  });
  expect(() => hook.result.current.selectSession("session-one")).toThrow(
    "先核实",
  );
});

it.each([99, 100])(
  "preserves %i selected feedback identities in the new revision discussion",
  async (count) => {
    const context = {
      kind: "revision" as const,
      revisionId: "revision-one",
      feedbackIds: Array.from(
        { length: count },
        (_, index) => `feedback-${index}`,
      ),
      anchor:
        count === 99
          ? {
              sourceRevisionId: "revision-one",
              scope: "node" as const,
              pageId: "page-one",
              nodeId: "node-one",
              quote: "领取",
            }
          : null,
    };
    mocks.create.mockResolvedValue(versioned(session({ context })));
    mocks.message.mockResolvedValue(
      versioned(session({ context, revision: 2 })),
    );
    const hook = setup({ context });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => {
      await hook.result.current.send(input);
    });
    expect(mocks.create.mock.calls[0][1].context).toEqual(context);
    expect(mocks.message).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
  },
);
