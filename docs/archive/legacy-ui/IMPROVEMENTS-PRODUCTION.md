# [历史归档] AI Product Workbench 前端改进清单
> 基于 feat/aichatbot-frontend 分支（生产环境）

**技术栈**: Next.js 14 + Vercel AI SDK + SWR + Radix UI + Tailwind

---

## 优先级 1️⃣：性能优化（影响用户体验）

### Task 1.1: 优化消息对比逻辑
**文件**: `apps/web/hooks/use-active-chat.tsx`  
**优先级**: 🔴 高  
**工作量**: 1.5 小时

**当前问题** (第 103-117 行):
```typescript
function messagesSignature(messages: ChatMessage[]) {
  return messages
    .map((message) => {
      const partSignature = message.parts
        .map((part: any) => {
          if (part.type === "text") {
            return `${part.type}:${part.text ?? ""}`;
          }
          return `${part.type}:${part.state ?? ""}`;
        })
        .join(",");
      return `${message.id}:${message.role}:${partSignature}`;
    })
    .join("|");
}
```

❌ **问题**: 每次状态更新都序列化整个消息历史，在长对话中性能下降

**改进目标**:
```typescript
// 只对比最后一条消息和消息数量
function quickMessagesCheck(local: ChatMessage[], server: ChatMessage[]) {
  if (local.length !== server.length) return false;
  if (local.length === 0) return true;
  
  const lastLocal = local[local.length - 1];
  const lastServer = server[server.length - 1];
  
  return lastLocal.id === lastServer.id && 
         messagesSignature([lastLocal]) === messagesSignature([lastServer]);
}
```

**需要修改**:
- [ ] 在 `use-active-chat.tsx` 添加增量对比函数
- [ ] 替换 `messagesSignature()` 调用为增量对比
- [ ] 添加性能监控日志

**验证**:
```bash
npm run dev  # 测试 20+ 条消息的对话性能
```

---

### Task 1.2: 减少无效轮询
**文件**: `apps/web/hooks/use-active-chat.tsx`  
**优先级**: 🔴 高  
**工作量**: 2 小时

**当前问题** (第 193-217 行):
```typescript
const { data: runtimeStatus, mutate: mutateRuntimeStatus } = useSWR(
  isNewChat ? null : `chat-runtime-status-${chatId}`,
  () => getChatRuntimeStatus(chatId),
  {
    revalidateOnFocus: true,
    refreshInterval: (latest) =>
      latest?.latestRun?.status === "running" ? RUN_STATUS_REFRESH_MS : 0,
    dedupingInterval: CHAT_DATA_DEDUPE_MS,
  }
);
```

❌ **问题**: 
- `refreshInterval` 在没有运行时任务仍然触发（因为 `latest` 可能是 undefined）
- `RUNNING_MESSAGES_REFRESH_MS = 12000` 太频繁
- 同时轮询 runtime status 和 messages，造成双倍请求

**改进目标**:
```typescript
// 1. 智能轮询间隔
const IDLE_REFRESH_MS = 30_000;      // 空闲时 30 秒
const ACTIVE_REFRESH_MS = 8_000;     // 活跃时 8 秒

// 2. 合并轮询逻辑
refreshInterval: (latest) => {
  if (!latest) return 0;
  const isRunning = latest.latestRun?.status === "running";
  return isRunning ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
}
```

**需要修改**:
- [ ] 调整轮询间隔常量（8s/30s 替代 12s）
- [ ] 添加轮询状态判断逻辑
- [ ] 增加 `dedupingInterval` 到 8000ms

**验证**:
```bash
# 开发者工具 Network 面板
# 1. 生成时：8 秒一次请求
# 2. 空闲时：30 秒一次请求
```

---

### Task 1.3: 简化错误恢复机制
**文件**: `apps/web/hooks/use-active-chat.tsx`  
**优先级**: 🔴 高  
**工作量**: 2 小时

**当前问题** (第 738-809 行):
```typescript
const STREAM_RECOVERY_ATTEMPTS = 8;  // 最多 8 次重试
const STREAM_RECOVERY_INTERVAL_MS = 2000;

for (let attempt = 0; attempt < STREAM_RECOVERY_ATTEMPTS; attempt += 1) {
  if (attempt > 0) {
    await delay(STREAM_RECOVERY_INTERVAL_MS * Math.min(attempt, 4));
  }
  // 用户看不到恢复进度
}
```

❌ **问题**:
- 8 次重试对用户来说是黑盒，可能等待 20+ 秒无反馈
- 没有提供手动重试选项
- 恢复状态不可见

**改进目标**:
```typescript
// 1. 减少重试次数
const STREAM_RECOVERY_ATTEMPTS = 3;

// 2. 添加恢复状态到 runtimeProcess
type RuntimeProcessSnapshot = {
  // ... 现有字段
  recoveryAttempt?: number;
  maxRecoveryAttempts?: number;
};

// 3. 在 UI 显示恢复进度
setRuntimeProcess((current) => ({
  ...current,
  recoveryAttempt: attempt + 1,
  maxRecoveryAttempts: STREAM_RECOVERY_ATTEMPTS,
  title: `恢复中 (${attempt + 1}/${STREAM_RECOVERY_ATTEMPTS})`,
}));
```

**需要修改**:
- [ ] 减少 `STREAM_RECOVERY_ATTEMPTS` 到 3
- [ ] 在 `lib/types.ts` 添加恢复状态字段
- [ ] 更新 `recoverPersistedReply` 函数设置恢复状态
- [ ] 在 `components/chat/console.tsx` 显示恢复进度

**新增功能**:
- [ ] 显示"恢复中 (1/3)" 进度
- [ ] 3 次失败后显示"手动重试"按钮
- [ ] 点击重试调用 `regenerate()`

**验证**:
```bash
# 模拟网络中断
# 1. 开发者工具 Network -> Offline
# 2. 发送消息，观察恢复进度显示
# 3. 3 次后显示重试按钮
```

---

## 优先级 2️⃣：代码质量（提升可维护性）

### Task 2.1: 移除 any 类型
**文件**: 多个文件  
**优先级**: 🟡 中  
**工作量**: 3 小时

**当前问题**:
```typescript
// use-active-chat.tsx:107
.map((part: any) => {

// use-active-chat.tsx:827
message.parts.some((part: any) => {
```

❌ **问题**: 丢失类型安全，容易引入运行时错误

**改进目标**:
```typescript
// 使用已定义的类型
import type { ChatMessage } from "@/lib/types";

function messagesSignature(messages: ChatMessage[]) {
  return messages.map((message) => {
    const partSignature = message.parts
      .map((part) => {  // 类型自动推断
        if (part.type === "text") {
          return `${part.type}:${part.text ?? ""}`;
        }
        return `${part.type}:${"state" in part ? part.state : ""}`;
      })
      .join(",");
    // ...
  });
}
```

**需要修改**:
- [ ] `use-active-chat.tsx` - 移除所有 `any`，使用 `ChatMessage` 类型
- [ ] `nest-client.ts` - 用类型守卫替代 `as` 断言
- [ ] 添加 Zod schema 验证运行时数据

**验证**:
```bash
npm run typecheck  # 应该无类型错误
```

---

### Task 2.2: API 客户端增强
**文件**: `apps/web/lib/api/nest-client.ts`  
**优先级**: 🟡 中  
**工作量**: 1.5 小时

**当前实现**:
```typescript
export async function nestFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    credentials: "include",
    ...init,
  });
  // ...
}
```

✅ **已经不错**: 有基础错误处理和友好提示

**可改进点**:
1. 添加请求去重（防止短时间内重复请求）
2. 添加请求追踪 ID（便于调试）
3. 添加请求超时控制

**改进目标**:
```typescript
const requestCache = new Map<string, Promise<any>>();

export async function nestFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const requestId = generateRequestId();
  const cacheKey = `${init?.method ?? 'GET'}:${path}`;
  
  // 请求去重
  if (requestCache.has(cacheKey)) {
    return requestCache.get(cacheKey);
  }
  
  const promise = fetch(`${getApiBase()}${path}`, {
    credentials: "include",
    signal: AbortSignal.timeout(30000),  // 30s 超时
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,  // 追踪 ID
      ...(init?.headers ?? {}),
    },
  }).then(/* ... */).finally(() => {
    requestCache.delete(cacheKey);
  });
  
  requestCache.set(cacheKey, promise);
  return promise;
}
```

**需要修改**:
- [ ] 添加请求缓存 Map
- [ ] 添加 `X-Request-Id` header
- [ ] 添加 AbortSignal 超时控制
- [ ] 添加请求去重逻辑

**验证**:
```bash
# 测试快速连续点击
# Network 面板应该只看到一个请求
```

---

### Task 2.3: 组件性能优化
**文件**: `apps/web/components/chat/*.tsx`  
**优先级**: 🟡 中  
**工作量**: 2 小时

**当前问题**:
```tsx
// multimodal-input.tsx 已经部分使用 memo
export const PureMultimodalInput = memo(
  MultimodalInput,
  (prevProps, nextProps) => {
    // 自定义对比逻辑
  }
);
```

✅ **已有部分优化**: `multimodal-input.tsx` 使用了 `memo`

**可改进的组件**:
- `components/chat/message.tsx` - 消息组件（渲染频繁）
- `components/chat/artifact.tsx` - 画布组件（较重）
- `components/chat/suggested-actions.tsx` - 建议操作

**改进目标**:
```tsx
// message.tsx
export const Message = memo(function Message({ message, votes }) {
  const handleVote = useCallback((type: 'up' | 'down') => {
    // ...
  }, [message.id]);
  
  return (/* ... */);
}, (prev, next) => {
  // 只在消息内容变化时重新渲染
  return prev.message.id === next.message.id &&
         messagesSignature([prev.message]) === messagesSignature([next.message]);
});
```

**需要修改**:
- [ ] `message.tsx` - 添加 `React.memo` + 自定义对比
- [ ] `artifact.tsx` - 使用 `useMemo` 缓存渲染结果
- [ ] `suggested-actions.tsx` - 稳定 callback 引用

**验证**:
```bash
# React DevTools Profiler
# 查看组件重新渲染次数
```

---

## 优先级 3️⃣：用户体验改进

### Task 3.1: 更详细的错误提示
**文件**: `apps/web/hooks/use-active-chat.tsx`  
**优先级**: 🟢 低  
**工作量**: 1.5 小时

**当前实现** (第 350-359 行):
```typescript
if (error instanceof ChatbotError) {
  toast({ type: "error", description: error.message });
} else {
  toast({
    type: "error",
    description: isRecoverableStreamError
      ? "连接中断，正在尝试恢复回复"
      : message || "出错了，请稍后重试",
  });
}
```

✅ **已有基础错误处理**

**可改进点**:
1. 区分错误类型（网络错误、服务器错误、业务错误）
2. 提供具体的恢复建议
3. 显示错误时间和 runId 便于追踪

**改进目标**:
```typescript
function getErrorDetails(error: unknown, runId?: string) {
  if (error instanceof ChatbotError) {
    return {
      title: "请求失败",
      message: error.message,
      action: error.statusCode === 429 ? "稍后重试" : "联系支持",
    };
  }
  
  const message = error instanceof Error ? error.message : "";
  const isNetworkError = /fetch|network/i.test(message);
  
  return {
    title: isNetworkError ? "网络连接中断" : "生成失败",
    message: isNetworkError 
      ? "请检查网络连接后重试" 
      : message || "未知错误",
    action: "重试",
    metadata: { runId, timestamp: new Date().toISOString() },
  };
}
```

**需要修改**:
- [ ] 添加 `getErrorDetails` 错误分类函数
- [ ] 更新 `onError` 使用详细错误信息
- [ ] Toast 组件显示操作按钮

---

### Task 3.2: 添加请求日志（调试用）
**文件**: `apps/web/lib/api/nest-client.ts`  
**优先级**: 🟢 低  
**工作量**: 1 小时

**改进目标**:
```typescript
// 开发环境下记录所有 API 请求
if (process.env.NODE_ENV === 'development') {
  console.group(`🌐 API ${init?.method ?? 'GET'} ${path}`);
  console.log('Request ID:', requestId);
  console.log('Payload:', init?.body);
  console.log('Response:', result);
  console.groupEnd();
}
```

**需要修改**:
- [ ] 在 `nestFetch` 添加开发环境日志
- [ ] 记录请求耗时
- [ ] 添加 localStorage 开关控制日志

---

## 📋 执行计划

### Week 1: 性能优化（必须完成）
```bash
Day 1-2: Task 1.1 消息对比优化 (1.5h)
Day 2-3: Task 1.2 减少轮询 (2h)
Day 3-4: Task 1.3 错误恢复优化 (2h)
# 总计: 5.5 小时
```

### Week 2: 代码质量（推荐完成）
```bash
Day 1-2: Task 2.1 移除 any (3h)
Day 3:   Task 2.2 API 增强 (1.5h)
Day 4:   Task 2.3 组件优化 (2h)
# 总计: 6.5 小时
```

### Week 3: 体验改进（可选）
```bash
Day 1: Task 3.1 错误提示 (1.5h)
Day 2: Task 3.2 请求日志 (1h)
# 总计: 2.5 小时
```

---

## ✅ 完成验证清单

### 性能测试
```bash
□ 长对话（50+ 消息）渲染流畅
□ 生成时轮询间隔 8 秒
□ 空闲时轮询间隔 30 秒
□ 网络中断恢复 < 30 秒
□ 恢复进度对用户可见
```

### 代码质量
```bash
□ npm run typecheck 通过
□ 无 any 类型
□ 无 ESLint 警告
□ 关键函数有注释
```

### 用户体验
```bash
□ 错误提示清晰具体
□ 有手动重试按钮
□ 加载状态明确
□ 无卡顿现象
```

---

## 🎯 与 main 分支 IMPROVEMENTS.md 的对比

| 维度 | main 分支清单 | 本清单（生产环境） |
|------|--------------|------------------|
| 适用范围 | Zustand + React Query 版本 | AI SDK + SWR 版本 ✅ |
| 文件路径 | `apps/web/src/*` | `apps/web/*` ✅ |
| 技术栈 | 错误 | 正确 ✅ |
| 可执行性 | ❌ 文件不存在 | ✅ 基于实际代码 |
| 优先级 | 组件抽取、样式系统 | 性能、错误处理 ✅ |

---

**预计完成时间**: 14-15 小时  
**难度等级**: 中等  
**推荐分配**: 1-2 个开发者协作

**关键收益**:
- 长对话性能提升 40%+
- 网络请求减少 60%
- 错误恢复体验显著改善
- 代码类型安全性提升
