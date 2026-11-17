"use client";
import type {
  GenerationPreview,
  PrototypeGeometryNode,
  PrototypePage,
} from "@workbench/workbench-contracts";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { DraftProjection } from "./draft-projection";
import { acceptPrototypeGeometry } from "./geometry-bridge";
import {
  createPrototypeSandboxDocument,
  type PrototypePreviewInteraction,
} from "./preview";

import { Canvas } from "./onlook/canvas";
import { DeviceSelector } from "./onlook/device-selector";
import { BaseRect } from "./onlook/base-rect";

type Props = {
  storageScope?: string;
  locate?: {
    revisionId: string;
    pageId: string;
    nodeId: string | null;
    requestId: string;
  };
  readOnly?: boolean;
  revisionId: string;
  title: string;
  html?: string | null;
  pages: PrototypePage[];
  pageId: string;
  onPage: (id: string) => void;
  onSelection: (selection?: PrototypePreviewInteraction) => void;
  draftIdentity: string;
  previews: GenerationPreview[];
  showDraft: boolean;
  running: boolean;
};
export function PageStage({
  storageScope,
  locate,
  readOnly = false,
  revisionId,
  title,
  html,
  pages,
  pageId,
  onPage,
  onSelection,
  draftIdentity,
  previews,
  showDraft,
  running,
}: Props) {
  const frame = useRef<HTMLIFrameElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"browse" | "select">("browse");
  const [overview, setOverview] = useState(false),
    [layersOpen, setLayersOpen] = useState(false);
  const [search, setSearch] = useState("");
  const preferenceKey = storageScope
    ? `workbench:studio:${storageScope}:viewport`
    : null;
  const [size, setSize] = useState(() => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem(preferenceKey ?? "") ?? "null",
      );
      if (
        value &&
        Number.isFinite(value.width) &&
        Number.isFinite(value.height) &&
        value.width >= 280 &&
        value.width <= 2560 &&
        value.height >= 320 &&
        value.height <= 2560
      )
        return { width: Number(value.width), height: Number(value.height) };
    } catch {
      /* Storage can be disabled; keep state in memory. */
    }
    return { width: 1280, height: 800 };
  });
  useEffect(() => {
    if (preferenceKey)
      try {
        sessionStorage.setItem(preferenceKey, JSON.stringify(size));
      } catch {
        /* Storage can be disabled; keep state in memory. */
      }
  }, [size, preferenceKey]);
  const [zoom, setZoom] = useState<number | null>(null),
    [available, setAvailable] = useState(900);
  const [node, setNode] = useState<PrototypeGeometryNode | null>(null),
    [hover, setHover] = useState<PrototypeGeometryNode | null>(null);
  const [layers, setLayers] = useState<PrototypeGeometryNode[]>([]),
    [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0),
    [loaded, setLoaded] = useState(false);
  const lastSequence = useRef(0);
  const sessionId = useMemo(
    () => `frame-${crypto.randomUUID()}`,
    [revisionId, reload],
  );
  const srcDoc = useMemo(
    () =>
      html
        ? createPrototypeSandboxDocument(html, { revisionId, sessionId })
        : undefined,
    [html, revisionId, sessionId],
  );
  const [scale, setScale] = useState(1),
    [panMode, setPanMode] = useState(false);
  const command = (command: string, extra = {}) =>
    frame.current?.contentWindow?.postMessage(
      {
        protocol: "workbench.studio.frame.v1",
        sessionId,
        revisionId,
        pageId,
        command,
        ...extra,
      },
      "*",
    );
  const selectPage = () => {
    command("page");
    command("mode", { mode });
    command("layers");
  };
  useEffect(() => {
    if (!viewport.current) return;
    const element = viewport.current;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setNode(null);
    setHover(null);
    setLayers([]);
    onSelection(undefined);
    selectPage();
  }, [pageId, revisionId]);
  useEffect(() => {
    lastSequence.current = 0;
    setLoaded(false);
  }, [sessionId]);
  useEffect(() => {
    command("mode", { mode });
    if (mode === "browse") {
      setNode(null);
      setHover(null);
      onSelection(undefined);
    }
  }, [mode]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
        return;
      setMode("browse");
      setLayersOpen(false);
      setPanMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    if (!html || loaded) return;
    const timer = setTimeout(
      () => setNotice("页面加载较慢，可重新载入；这不会重新生成版本。"),
      10000,
    );
    return () => clearTimeout(timer);
  }, [html, loaded, reload]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !["", "null"].includes(event.origin)
      )
        return;
      if (
        event.data?.kind === "page" &&
        pages.some((p) => p.id === event.data.pageId)
      ) {
        const next = acceptPrototypeGeometry(
          event.data,
          { sessionId, revisionId, pageId: event.data.pageId },
          lastSequence.current,
        );
        if (next) {
          lastSequence.current = next.sequence;
          onPage(next.pageId);
        }
        return;
      }
      const data = acceptPrototypeGeometry(
        event.data,
        { sessionId, revisionId, pageId },
        lastSequence.current,
      );
      if (!data) return;
      lastSequence.current = data.sequence;
      if (data.kind === "layers") setLayers(data.layers);
      if (data.kind === "hover") setHover(data.node);
      if (["selection", "measure", "missing"].includes(data.kind))
        setNode(data.node);
      if (data.kind === "selection")
        onSelection(
          data.node
            ? {
                nodeId: data.node.nodeId,
                revisionId,
                target: data.node.selector,
                tag: data.node.tag,
                label: data.node.label,
                pageId,
              }
            : undefined,
        );
      if (data.kind === "missing") {
        setNotice("原元素未找到，可保留正文并添加普通批注。");
        onSelection(undefined);
      }
      if (data.kind === "exit") setMode("browse");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [pageId, pages, revisionId, sessionId, onPage, onSelection]);
  const appliedLocation = useRef<string | null>(null);
  useEffect(() => {
    if (
      !locate ||
      appliedLocation.current === locate.requestId ||
      locate.revisionId !== revisionId ||
      showDraft
    )
      return;
    setOverview(false);
    if (locate.pageId !== pageId) {
      onPage(locate.pageId);
      return;
    }
    if (!loaded) return;
    appliedLocation.current = locate.requestId;
    const nextMode = locate.nodeId ? "select" : "browse";
    setMode(nextMode);
    command("page");
    command("mode", { mode: nextMode });
    if (locate.nodeId) command("selectNode", { nodeId: locate.nodeId });
  }, [locate?.requestId, revisionId, pageId, loaded, showDraft]);
  const preview = previews.find((p) => p.kind === "prototype") ?? previews[0];
  const draftPages = preview?.screens ?? [];
  const [knownDraftPages, setKnownDraftPages] = useState<
    { id: string; name: string }[]
  >([]);
  const [updatedPage, setUpdatedPage] = useState("");
  const lastDraft = useRef<{ scope: string; pages: Map<string, string> }>({
    scope: "",
    pages: new Map(),
  });
  const draftSignature = JSON.stringify(draftPages);
  useEffect(() => {
    const previous = lastDraft.current;
    if (previous.scope !== draftIdentity) {
      previous.scope = draftIdentity;
      previous.pages = new Map();
      setKnownDraftPages([]);
      setUpdatedPage("");
    }
    let changed = "";
    for (const page of draftPages) {
      const text = JSON.stringify(page);
      if (previous.pages.has(page.id) && previous.pages.get(page.id) !== text)
        changed = page.id;
      previous.pages.set(page.id, text);
    }
    setKnownDraftPages((current) => {
      const map = new Map(current.map((page) => [page.id, page]));
      for (const page of draftPages)
        map.set(page.id, { id: page.id, name: page.name });
      return [...map.values()].slice(0, 50);
    });
    if (changed) setUpdatedPage(changed);
    const timer = setTimeout(() => setUpdatedPage(""), 2500);
    return () => clearTimeout(timer);
  }, [draftSignature, draftIdentity]);
  const draftPage = pageId
    ? draftPages.find((p) => p.id === pageId)
    : draftPages[0];
  const filtered = pages.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase()),
  );
  const selectedPage = pages.find((p) => p.id === pageId) ?? pages[0];
  const box = node ?? hover;
  return (
    <section className="visual-stage" aria-label="页面舞台">
      <div className="visual-stage-toolbar">
        <button
          type="button"
          aria-pressed={overview}
          onClick={() => setOverview((v) => !v)}
        >
          {overview ? "返回页面" : "页面总览"}
        </button>
        <select
          aria-label="当前页面"
          value={selectedPage?.id ?? ""}
          onChange={(e) => onPage(e.target.value)}
        >
          <option value="">选择页面</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.order + 1}. {p.title}
            </option>
          ))}
        </select>
        <div className="visual-toolbar-spacer" />
        <button type="button" onClick={() => setZoom(null)}>
          适应
        </button>
        <button
          type="button"
          aria-label="缩小"
          onClick={() => setZoom(Math.max(0.1, scale - 0.1))}
        >
          −
        </button>
        <button type="button" onClick={() => setZoom(1)}>
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          aria-label="放大"
          onClick={() => setZoom(Math.min(2, scale + 0.1))}
        >
          ＋
        </button>
        <DeviceSelector
          size={size}
          onChange={(value) => {
            setSize(value);
            setZoom(null);
          }}
        />
      </div>
      {html && !showDraft && (
        <div className="visual-modebar">
          <div role="group" aria-label="页面模式">
            <button
              type="button"
              aria-pressed={mode === "browse"}
              onClick={() => {
                setMode("browse");
                setPanMode(false);
              }}
            >
              浏览
            </button>
            {!readOnly && (
              <>
                <button
                  type="button"
                  aria-pressed={mode === "select"}
                  onClick={() => {
                    setMode("select");
                    setPanMode(false);
                  }}
                >
                  选择元素
                </button>
                <button
                  type="button"
                  aria-expanded={layersOpen}
                  onClick={() => {
                    setLayersOpen((v) => !v);
                    command("layers");
                  }}
                >
                  图层
                </button>
              </>
            )}
            <button
              type="button"
              aria-pressed={panMode}
              onClick={() => setPanMode((v) => !v)}
            >
              平移
            </button>
          </div>
          <span>
            {panMode
              ? "拖动舞台 · 关闭平移后操作页面"
              : mode === "browse"
                ? "可直接操作页面 · 预览尺寸不会重新生成"
                : "点击选中 · Esc 返回浏览"}
          </span>
          <button
            type="button"
            onClick={() => {
              setReload((v) => v + 1);
              setNotice("");
            }}
          >
            重载预览
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="visual-notice">
          {notice}
        </p>
      )}
      <div className="visual-stage-body">
        {layersOpen && !showDraft && (
          <aside className="visual-layers" aria-label="可定位图层">
            <p>可定位元素（最多 120 项）</p>
            {layers.map((layer, i) => (
              <button
                type="button"
                key={`${layer.selector}:${i}`}
                onClick={() => {
                  setMode("select");
                  command("select", { selector: layer.selector });
                }}
              >
                {layer.tag} · {layer.label || layer.nodeId}
              </button>
            ))}
            {node && (
              <button type="button" onClick={() => command("parent")}>
                选择父级
              </button>
            )}
          </aside>
        )}
        <div
          ref={viewport}
          className="visual-viewport"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setMode("browse");
              setLayersOpen(false);
              setPanMode(false);
            }
          }}
        >
          {showDraft && preview ? (
            <div className="visual-draft">
              <p className="visual-draft-label">
                生成中草稿 · 部分预览，内容可能变化 · 暂不可操作
              </p>
              {preview.kind === "prd" ? (
                <article className="visual-document">
                  <Streamdown>{preview.markdown}</Streamdown>
                </article>
              ) : (
                <>
                  <div className="visual-draft-pages">
                    {knownDraftPages.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        aria-pressed={draftPage?.id === p.id}
                        onClick={() => onPage(p.id)}
                      >
                        {p.name}
                        {updatedPage === p.id ? " · 已更新" : ""}
                      </button>
                    ))}
                  </div>
                  {draftPage && (
                    <DraftProjection
                      key={`${draftIdentity}:${draftPage.id}`}
                      page={draftPage}
                      available={available}
                      running={running}
                      updated={updatedPage === draftPage.id}
                    />
                  )}
                  {!draftPage && (
                    <p className="studio-empty-copy">
                      该页暂无中间预览。收到该页的新投影后会在此显示。
                    </p>
                  )}
                  <p>
                    当前窗口 {draftPages.length} 页 · 已显示{" "}
                    {
                      new Set(
                        draftPages.flatMap((p) =>
                          p.nodes.map((n) => `${p.id}:${n.id}`),
                        ),
                      ).size
                    }{" "}
                    个节点 · 未包含的页面并未删除
                  </p>
                </>
              )}
            </div>
          ) : overview && pages.length ? (
            <>
              <label className="visual-page-search">
                查找页面
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="按页面名称搜索"
                />
              </label>
              <div className="visual-overview">
                {filtered.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onPage(p.id);
                      setOverview(false);
                    }}
                  >
                    <PageThumbnail page={p} html={html ?? ""} />
                    <strong>
                      {p.order + 1}. {p.title}
                    </strong>
                    <span>可预览</span>
                  </button>
                ))}
              </div>
            </>
          ) : selectedPage && srcDoc ? (
            <Canvas
              width={size.width}
              height={size.height}
              scale={zoom}
              onScale={setZoom}
              onRenderedScale={setScale}
              panMode={panMode}
            >
              <div
                className="visual-paper"
                style={{ width: size.width, height: size.height }}
              >
                <iframe
                  ref={frame}
                  key={sessionId}
                  title={title || selectedPage.title}
                  srcDoc={srcDoc}
                  onLoad={() => {
                    setLoaded(true);
                    setNotice("");
                    selectPage();
                  }}
                  sandbox="allow-scripts allow-forms"
                />
                {mode === "select" && box && (
                  <>
                    <BaseRect
                      left={box.x}
                      top={box.y}
                      width={box.width}
                      height={box.height}
                    />
                    <span
                      className="studio-dimension"
                      style={{ left: box.x, top: box.y - 24 }}
                    >
                      {Math.round(box.width)} × {Math.round(box.height)} CSS px
                    </span>
                  </>
                )}
              </div>
            </Canvas>
          ) : (
            <div className="visual-empty">
              <span className="visual-empty-symbol">▧</span>
              <h2>{running ? "页面正在形成" : "把想法变成可操作的页面"}</h2>
              <p>
                {running
                  ? "当前阶段尚未提供中间预览，收到真实内容后将在这里展示。"
                  : "在下方描述需求，审阅计划后开始。默认同时生成需求文档和原型。"}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PageThumbnail({ page, html }: { page: PrototypePage; html: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const src = useMemo(() => {
    if (!visible) return undefined;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const fragment = new DOMParser().parseFromString(page.content, "text/html");
    fragment
      .querySelectorAll("script,iframe,object,embed,link,meta,base")
      .forEach((e) => e.remove());
    fragment.querySelectorAll("*").forEach((e) =>
      [...e.attributes].forEach((a) => {
        if (
          /^on/i.test(a.name) ||
          ["src", "href", "srcset", "action"].includes(a.name)
        )
          e.removeAttribute(a.name);
      }),
    );
    const styles = [...doc.querySelectorAll("style")]
      .map((e) => e.textContent)
      .join("\n");
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><foreignObject width="1280" height="800"><div xmlns="http://www.w3.org/1999/xhtml"><style>${styles.replace(/<\/style/gi, "")}</style>${fragment.body.innerHTML}</div></foreignObject></svg>`)}`;
  }, [visible, page.content, html]);
  return (
    <span ref={ref} className="visual-thumbnail">
      {src && !failed ? (
        <img
          alt={`${page.title} 页面缩略图`}
          src={src}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{failed ? "缩略图不可用 · 点击打开页面" : "页面预览"}</span>
      )}
    </span>
  );
}
