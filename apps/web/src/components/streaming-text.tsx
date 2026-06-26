"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_CHARS_PER_SECOND = 90;
const MIN_STEP = 1;

/**
 * 把一段会持续增长的目标文本按节奏逐字符渲染，形成打字机效果。
 *
 * - text 增长（流式累加）时，从已显示位置接着吐，不重置已显示内容。
 * - text 回退/变短（切换会话/新 run）时，重置为空再重新吐。
 * - active=false（已定格或纯历史消息）时瞬间补齐全部，定格为普通文本。
 *
 * 纯展示组件，不触碰任何数据流。
 */
export function StreamingText({
  text,
  active,
  charsPerSecond = DEFAULT_CHARS_PER_SECOND,
  onDone,
  children,
}: {
  text: string;
  active?: boolean;
  /** 打字速率（字符/秒）。越大越快。 */
  charsPerSecond?: number;
  /** active 阶段内打满到完整 text 时回调一次。 */
  onDone?: () => void;
  /** 逐字渲染的容器；不传则直接渲染文本节点。 */
  children?: (visible: string, isStreaming: boolean) => React.ReactNode;
}) {
  const [visibleCount, setVisibleCount] = useState(0);

  // 用 ref 同步目标串与开关，rAF 循环内部读取，避免把会高频变化的值塞进 effect 依赖。
  const textRef = useRef(text);
  const activeRef = useRef(active ?? true);
  const rateRef = useRef(charsPerSecond);
  const frameRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const doneRef = useRef(false);
  const lastTargetLenRef = useRef(text.length);

  textRef.current = text;
  activeRef.current = active ?? true;
  rateRef.current = charsPerSecond;

  // 目标串回退/变短时重置，防止残留导致错位。
  useEffect(() => {
    if (text.length < lastTargetLenRef.current) {
      setVisibleCount(0);
      doneRef.current = false;
    }
    lastTargetLenRef.current = text.length;
  }, [text]);

  useEffect(() => {
    // 已定格或纯历史消息：直接展示全部，不跑打字动画。
    if (active === false) {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastTsRef.current = null;
      setVisibleCount(text.length);
      return;
    }

    const tick = (ts: number) => {
      const target = textRef.current;
      const rate = rateRef.current;

      setVisibleCount((current) => {
        if (current >= target.length) {
          // 已吐满，停止循环；onDone 在下面统一处理。
          if (frameRef.current) cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
          lastTsRef.current = null;
          return current;
        }

        if (lastTsRef.current === null) {
          lastTsRef.current = ts;
        }
        const delta = ts - lastTsRef.current;
        lastTsRef.current = ts;

        const advance = Math.max(MIN_STEP, Math.round((delta / 1000) * rate));
        return Math.min(current + advance, target.length);
      });

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastTsRef.current = null;
    };
  }, [active]);

  // 触发 onDone：当处于 active 且已打满时回调一次；目标串追加后可再次触发。
  useEffect(() => {
    if (active !== false && visibleCount >= text.length && text.length > 0 && !doneRef.current) {
      doneRef.current = true;
      onDone?.();
    }
    if (visibleCount < text.length) {
      doneRef.current = false;
    }
  }, [visibleCount, text.length, active, onDone]);

  const isStreaming = active !== false && visibleCount < text.length;
  const visible = text.slice(0, visibleCount);

  if (children) return children(visible, isStreaming);
  return <>{visible}</>;
}
