import "@xyflow/react/dist/style.css";
import "./styles.css";

import {
  addEdge,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createElement } from "react";

const STORAGE_KEY = "apitable-feishu-canvas-v1";

const seedNodes = [
  { id: "root", type: "canvas", position: { x: 90, y: 230 }, data: { kind: "requirement", title: "需求管理平台", status: "规划中", owner: "产品团队", color: "violet" }, style: { width: 250, height: 124 } },
  { id: "intake", type: "canvas", position: { x: 430, y: 40 }, data: { kind: "requirement", title: "需求收集", status: "进行中", owner: "产品经理", color: "blue" }, style: { width: 230, height: 112 } },
  { id: "review", type: "canvas", position: { x: 430, y: 250 }, data: { kind: "requirement", title: "评审与排期", status: "进行中", owner: "项目负责人", color: "blue" }, style: { width: 230, height: 112 } },
  { id: "release", type: "canvas", position: { x: 430, y: 460 }, data: { kind: "requirement", title: "研发与发版", status: "规划中", owner: "研发团队", color: "blue" }, style: { width: 230, height: 112 } },
  { id: "form", type: "canvas", position: { x: 760, y: -20 }, data: { kind: "sticky", title: "表单提交", status: "已上线", owner: "全员", color: "yellow" }, style: { width: 220, height: 112 } },
  { id: "import", type: "canvas", position: { x: 760, y: 130 }, data: { kind: "text", title: "外部需求导入", status: "规划中", owner: "产品经理", color: "plain" }, style: { width: 220, height: 90 } },
  { id: "priority", type: "canvas", position: { x: 760, y: 270 }, data: { kind: "shape", title: "优先级确认", status: "进行中", owner: "项目负责人", color: "blue", shape: "ellipse" }, style: { width: 220, height: 110 } },
  { id: "calendar", type: "canvas", position: { x: 760, y: 430 }, data: { kind: "requirement", title: "日历发版视图", status: "已上线", owner: "项目负责人", color: "blue" }, style: { width: 220, height: 112 } },
  { id: "notify", type: "canvas", position: { x: 760, y: 590 }, data: { kind: "requirement", title: "上线通知", status: "规划中", owner: "运营", color: "blue" }, style: { width: 220, height: 112 } },
];

const seedEdges = [
  ["root", "intake"], ["root", "review"], ["root", "release"], ["intake", "form"],
  ["intake", "import"], ["review", "priority"], ["release", "calendar"], ["release", "notify"],
].map(([source, target]) => ({ id: `e-${source}-${target}`, source, target, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, color: "#9589ff" }, style: { stroke: "#8176d8", strokeWidth: 2 } }));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function readStored() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function emitUpdate(id, patch) { window.dispatchEvent(new CustomEvent("mindmap-node-update", { detail: { id, patch } })); }

function CanvasNode({ id, data, selected }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title || "");
  const kind = data.kind || "requirement";
  const meta = [data.status, data.owner].filter(Boolean).join(" · ");
  useEffect(() => setDraft(data.title || ""), [data.title]);
  const commitTitle = () => { const title = draft.trim(); if (title && title !== data.title) emitUpdate(id, { title }); setEditing(false); };
  return <div className={`canvas-node kind-${kind} color-${data.color || "blue"} ${data.shape === "ellipse" ? "shape-ellipse" : ""}`}>
    <NodeResizer isVisible={selected} minWidth={150} minHeight={70} lineStyle={{ borderColor: "#8b7cff" }} handleStyle={{ width: 9, height: 9, borderRadius: 2, background: "#8b7cff", border: "0" }} onResizeEnd={(_, params) => emitUpdate(id, { width: Math.round(params.width), height: Math.round(params.height) })} />
    <Handle type="target" position={Position.Left} className="flow-handle" />
    <div className="node-kind">{kind === "sticky" ? "便签" : kind === "text" ? "文本" : kind === "shape" ? "形状" : "需求"}</div>
    {editing ? <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commitTitle} onKeyDown={(event) => { if (event.key === "Enter") commitTitle(); if (event.key === "Escape") setEditing(false); }} onPointerDown={(event) => event.stopPropagation()} /> : <div className="node-title" onClick={(event) => { event.stopPropagation(); setEditing(true); }} title="点击编辑">{data.title || "未命名"}</div>}
    {meta && <div className="node-meta" onClick={(event) => { event.stopPropagation(); setEditing(true); }}>{meta}</div>}
    <Handle type="source" position={Position.Right} className="flow-handle" />
  </div>;
}

const nodeTypes = { canvas: CanvasNode };

function CanvasApp() {
  const stored = useMemo(() => readStored(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(stored?.nodes || seedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(stored?.edges || seedEdges);
  const [title, setTitle] = useState(stored?.title || "需求脑图");
  const [tool, setTool] = useState("select");
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const flow = useReactFlow();
  const beforeDrag = useRef(null);

  const snapshot = useCallback(() => ({ nodes: clone(nodes), edges: clone(edges), title }), [edges, nodes, title]);
  const record = useCallback(() => { setHistory((current) => [...current.slice(-49), snapshot()]); setFuture([]); }, [snapshot]);
  const applySnapshot = useCallback((next) => { setNodes(next.nodes); setEdges(next.edges); setTitle(next.title); }, [setEdges, setNodes]);

  useEffect(() => {
    const handler = (event) => setNodes((current) => current.map((node) => node.id === event.detail.id ? { ...node, data: { ...node.data, ...event.detail.patch }, style: { ...node.style, ...(event.detail.patch.width ? { width: event.detail.patch.width } : {}), ...(event.detail.patch.height ? { height: event.detail.patch.height } : {}) } } : node));
    window.addEventListener("mindmap-node-update", handler);
    return () => window.removeEventListener("mindmap-node-update", handler);
  }, [setNodes]);

  const selectedIds = useMemo(() => nodes.filter((node) => node.selected).map((node) => node.id), [nodes]);

  const addNode = useCallback((kind, position) => { record(); const id = `node-${Date.now().toString(36)}`; const defaults = { requirement: { title: "新需求", color: "blue" }, text: { title: "输入文本", color: "plain" }, sticky: { title: "新便签", color: "yellow" }, shape: { title: "新形状", color: "blue", shape: "ellipse" } }; const item = defaults[kind]; setNodes((current) => [...current, { id, type: "canvas", position, data: { kind, status: "", owner: "", ...item }, style: { width: 220, height: kind === "text" ? 80 : 110 }, selected: true }]); setTool("select"); }, [record, setNodes]);
  const deleteSelected = useCallback(() => { if (!selectedIds.length) return; record(); setNodes((current) => current.filter((node) => !selectedIds.includes(node.id))); setEdges((current) => current.filter((edge) => !selectedIds.includes(edge.source) && !selectedIds.includes(edge.target))); }, [record, selectedIds, setEdges, setNodes]);
  const onConnect = useCallback((connection) => { record(); setEdges((current) => addEdge({ ...connection, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, color: "#9589ff" }, style: { stroke: "#8176d8", strokeWidth: 2 } }, current)); }, [record, setEdges]);
  const save = useCallback(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify({ title, nodes, edges })); setSaved(true); window.setTimeout(() => setSaved(false), 1400); }, [edges, nodes, title]);
  const reset = useCallback(() => { record(); setNodes(clone(seedNodes)); setEdges(clone(seedEdges)); setTitle("需求脑图"); localStorage.removeItem(STORAGE_KEY); }, [record, setEdges, setNodes]);
  const undo = useCallback(() => { setHistory((current) => { if (!current.length) return current; const previous = current[current.length - 1]; setFuture((next) => [...next, snapshot()]); applySnapshot(previous); return current.slice(0, -1); }); }, [applySnapshot, snapshot]);
  const redo = useCallback(() => { setFuture((current) => { if (!current.length) return current; const next = current[current.length - 1]; setHistory((previous) => [...previous, snapshot()]); applySnapshot(next); return current.slice(0, -1); }); }, [applySnapshot, snapshot]);
  const exportJson = useCallback(() => { const blob = new Blob([JSON.stringify({ title, nodes, edges }, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "需求脑图画布.json"; link.click(); URL.revokeObjectURL(link.href); }, [edges, nodes, title]);
  const importJson = useCallback(() => { const input = document.createElement("input"); input.type = "file"; input.accept = "application/json"; input.onchange = () => { const file = input.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const value = JSON.parse(String(reader.result)); if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error(); record(); setNodes(value.nodes); setEdges(value.edges); setTitle(value.title || "需求脑图"); } catch { window.alert("导入文件格式不正确"); } }; reader.readAsText(file); }; input.click(); }, [record, setEdges, setNodes]);

  useEffect(() => { const keydown = (event) => { if (event.target instanceof HTMLInputElement) return; if (event.key === "Delete" || event.key === "Backspace") deleteSelected(); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); } }; window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown); }, [deleteSelected, redo, undo]);

  return <main className="feishu-canvas-page">
    <header className="canvas-header"><div className="canvas-brand"><a href="/">需求管理</a><span>/</span><input value={title} aria-label="画布名称" onChange={(event) => setTitle(event.target.value)} /></div><div className="canvas-header-actions"><button onClick={undo} disabled={!history.length} title="撤销">↶</button><button onClick={redo} disabled={!future.length} title="重做">↷</button><span className="header-divider" /><button onClick={importJson}>导入</button><button onClick={exportJson}>导出</button><button onClick={save} className="primary">{saved ? "已保存" : "保存"}</button></div></header>
    <section className="canvas-shell">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeDragStart={() => { beforeDrag.current = snapshot(); }} onNodeDragStop={() => { if (beforeDrag.current) { setHistory((current) => [...current.slice(-49), beforeDrag.current]); setFuture([]); beforeDrag.current = null; } }} onPaneClick={(event) => { if (tool !== "select") { const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); addNode(tool, position); } }} onNodeClick={() => setTool("select")} selectionOnDrag selectionMode={SelectionMode.Partial} panOnDrag={tool === "select"} zoomOnScroll multiSelectionKeyCode={["Shift", "Meta", "Control"]} connectionLineType={ConnectionLineType.SmoothStep} fitView colorMode="dark" minZoom={0.2} maxZoom={2.2} defaultEdgeOptions={{ type: "smoothstep" }}>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#424650" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => node.data?.color === "yellow" ? "#e8b95b" : node.data?.color === "violet" ? "#8d7bff" : "#4f8cff"} />
        <Panel position="top-left" className="tool-rail"><button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="选择">↖</button><button className={tool === "text" ? "active" : ""} onClick={() => setTool("text")} title="文本">T</button><button className={tool === "sticky" ? "active" : ""} onClick={() => setTool("sticky")} title="便签">▤</button><button className={tool === "requirement" ? "active" : ""} onClick={() => setTool("requirement")} title="需求模块">▣</button><button className={tool === "shape" ? "active" : ""} onClick={() => setTool("shape")} title="形状">○</button><button onClick={deleteSelected} disabled={!selectedIds.length} className="tool-danger" title="删除选中">⌫</button><button onClick={reset} title="重置">↺</button></Panel>
        <Panel position="top-center" className="canvas-tip">{tool === "select" ? "拖动空白处平移，拖动模块移动；点击文字直接编辑" : "点击画布放置元素，点击选择工具返回选择模式"}</Panel>
      </ReactFlow>
    </section>
  </main>;
}

createRoot(document.getElementById("root")).render(<ReactFlowProvider><CanvasApp /></ReactFlowProvider>);
