"use client";

import "./mindmap.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { Download, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type MindNodeData = { label: string; status: string; owner: string };
type MindNode = Node<MindNodeData>;

const seedNodes: MindNode[] = [
  { id: "root", type: "input", position: { x: 80, y: 300 }, data: { label: "需求管理平台", status: "规划中", owner: "产品团队" } },
  { id: "intake", position: { x: 390, y: 80 }, data: { label: "需求收集", status: "进行中", owner: "产品经理" } },
  { id: "review", position: { x: 390, y: 300 }, data: { label: "评审与排期", status: "进行中", owner: "项目负责人" } },
  { id: "release", position: { x: 390, y: 520 }, data: { label: "研发与发版", status: "规划中", owner: "研发团队" } },
  { id: "form", position: { x: 720, y: 10 }, data: { label: "表单提交", status: "已上线", owner: "全员" } },
  { id: "import", position: { x: 720, y: 150 }, data: { label: "外部需求导入", status: "规划中", owner: "产品经理" } },
  { id: "priority", position: { x: 720, y: 300 }, data: { label: "优先级确认", status: "进行中", owner: "项目负责人" } },
  { id: "calendar", position: { x: 720, y: 440 }, data: { label: "日历发版视图", status: "已上线", owner: "项目负责人" } },
  { id: "notify", position: { x: 720, y: 580 }, data: { label: "上线通知", status: "规划中", owner: "运营" } },
];

const seedEdges: Edge[] = [
  { id: "e-root-intake", source: "root", target: "intake" },
  { id: "e-root-review", source: "root", target: "review" },
  { id: "e-root-release", source: "root", target: "release" },
  { id: "e-intake-form", source: "intake", target: "form" },
  { id: "e-intake-import", source: "intake", target: "import" },
  { id: "e-review-priority", source: "review", target: "priority" },
  { id: "e-release-calendar", source: "release", target: "calendar" },
  { id: "e-release-notify", source: "release", target: "notify" },
];

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch { return fallback; }
}

function MindmapPageInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<MindNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("需求脑图");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setNodes(readStored("workbench-mindmap-nodes", seedNodes));
    setEdges(readStored("workbench-mindmap-edges", seedEdges));
    setTitle(readStored("workbench-mindmap-title", "需求脑图"));
  }, [setEdges, setNodes]);

  const onConnect = useCallback((connection: Connection) => setEdges((current) => addEdge({ ...connection, animated: true }, current)), [setEdges]);
  const addNode = useCallback(() => {
    const id = `req-${Date.now()}`;
    setNodes((current) => [...current, { id, position: { x: 360, y: 240 }, data: { label: "新需求", status: "规划中", owner: "待分配" } }]);
    setSelected(id);
  }, [setNodes]);
  const deleteSelected = useCallback(() => {
    if (!selected || selected === "root") return;
    setNodes((current) => current.filter((node) => node.id !== selected));
    setEdges((current) => current.filter((edge) => edge.source !== selected && edge.target !== selected));
    setSelected(null);
  }, [selected, setEdges, setNodes]);
  const save = useCallback(() => {
    localStorage.setItem("workbench-mindmap-nodes", JSON.stringify(nodes));
    localStorage.setItem("workbench-mindmap-edges", JSON.stringify(edges));
    localStorage.setItem("workbench-mindmap-title", JSON.stringify(title));
    setSaved(true); window.setTimeout(() => setSaved(false), 1600);
  }, [edges, nodes, title]);
  const reset = useCallback(() => { setNodes(seedNodes); setEdges(seedEdges); setTitle("需求脑图"); localStorage.removeItem("workbench-mindmap-nodes"); localStorage.removeItem("workbench-mindmap-edges"); }, [setEdges, setNodes]);
  const exportJson = useCallback(() => { const blob = new Blob([JSON.stringify({ title, nodes, edges }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "需求脑图.json"; link.click(); URL.revokeObjectURL(url); }, [edges, nodes, title]);
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selected), [nodes, selected]);

  return <main className="mindmap-page">
    <header className="mindmap-header">
      <div><a className="mindmap-back" href="/">产品工作台</a><span className="mindmap-divider">/</span><input aria-label="脑图标题" value={title} onChange={(event) => setTitle(event.target.value)} /></div>
      <div className="mindmap-actions">
        <button type="button" onClick={addNode}><Plus size={16} /> 新增需求</button>
        <button type="button" onClick={deleteSelected} disabled={!selected || selected === "root"}><Trash2 size={16} /> 删除</button>
        <button type="button" onClick={reset}><RotateCcw size={16} /> 重置</button>
        <button type="button" onClick={exportJson}><Download size={16} /> 导出</button>
        <button className="primary" type="button" onClick={save}><Save size={16} /> {saved ? "已保存" : "保存"}</button>
      </div>
    </header>
    <section className="mindmap-body">
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, node) => setSelected(node.id)} onPaneClick={() => setSelected(null)} fitView colorMode="dark" minZoom={0.25} maxZoom={1.5}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#4b4e54" />
        <Controls />
        <MiniMap pannable zoomable nodeColor={(node) => node.id === selected ? "#8b7cff" : "#4f8cff"} />
      </ReactFlow>
      {selectedNode && <aside className="mindmap-inspector"><div className="inspector-kicker">需求节点</div><h2>{selectedNode.data.label}</h2><dl><dt>状态</dt><dd>{selectedNode.data.status}</dd><dt>负责人</dt><dd>{selectedNode.data.owner}</dd></dl><p>拖动节点调整结构；从节点边缘连接可建立父子关系。</p></aside>}
    </section>
  </main>;
}

export default function MindmapPage() { return <ReactFlowProvider><MindmapPageInner /></ReactFlowProvider>; }
