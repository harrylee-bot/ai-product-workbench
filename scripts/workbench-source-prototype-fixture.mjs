export function sourcePrototypeInputFixture(revision = 1) {
  return {
    protocol: "workbench.prototype-source-input.v1",
    documentId: "source-procurement-demo",
    title: "源码采购审批原型",
    revision,
    summary: "合成采购审批原型：申请人提交采购申请，审批人筛选待办并批准；页面状态仅在当前预览会话内保存。",
    entryFile: "src/App.tsx",
    pages: [{ id: "page-purchases", name: "采购申请", route: "/" }, { id: "page-review", name: "审批记录", route: "/review" }],
    files: [
      { path: "src/App.tsx", content: `import React, { useState } from 'react';
import seed from './purchases.json';
import './styles.css';
export default function App() {
  const [items,setItems]=useState(seed);
  const [query,setQuery]=useState('');
  const [page,setPage]=useState('purchases');
  const [name,setName]=useState('');
  const approved=items.filter(item=>item.approved).length;
  const visible=items.filter(item=>item.name.includes(query)&&(page!=='review'||item.approved));
  return <main><header><span className="eyebrow">PURCHASE WORKSPACE</span><h1>采购审批工作台</h1><p>源码原型 · 版本 ${revision}</p></header>
    <nav aria-label="页面"><button aria-pressed={page==='purchases'} onClick={()=>setPage('purchases')}>采购申请</button><button aria-pressed={page==='review'} onClick={()=>setPage('review')}>审批记录</button></nav>
    <section className="metrics"><article><strong>{items.length}</strong><span>采购申请</span></article><article><strong>{items.length-approved}</strong><span>待审批</span></article><article><strong>{approved}</strong><span>已批准</span></article></section>
    <label className="search">搜索采购申请<input aria-label="搜索采购申请" value={query} onChange={event=>setQuery(event.target.value)}/></label>
    <section className="requests" aria-label="申请列表">{visible.length===0?<p role="status">没有匹配的申请</p>:visible.map(item=><article key={item.id}><div><h2>{item.name}</h2><p>预算 ¥{item.amount} · {item.owner}</p></div><span>{item.approved?'已批准':'待审批'}</span><button disabled={item.approved} aria-label={'批准 '+item.name} onClick={()=>setItems(items.map(row=>row.id===item.id?{...row,approved:true}:row))}>{item.approved?'已批准':'批准申请'}</button></article>)}</section>
    <form onSubmit={event=>{event.preventDefault();if(!name.trim())return;setItems([...items,{id:String(items.length+1),name:name.trim(),amount:1000,owner:'演示申请人',approved:false}]);setName('');setPage('purchases');}}><label>申请名称<input aria-label="申请名称" value={name} onChange={event=>setName(event.target.value)} required/></label><button type="submit">新建采购申请</button></form>
  </main>;
}` },
      { path: "src/purchases.json", content: JSON.stringify([{ id: "purchase-1", name: "研发笔记本采购", amount: 12000, owner: "产品研发部", approved: false }, { id: "purchase-2", name: "会议室设备更新", amount: 8000, owner: "行政部", approved: false }]) },
      { path: "src/styles.css", content: `*{box-sizing:border-box}body{margin:0;background:#f3f5fb;color:#172033;font-family:system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:32px}header{padding:8px 0 24px}.eyebrow{color:#6257d5;font-size:11px;font-weight:700;letter-spacing:.12em}h1{margin:10px 0;font-size:30px}p{color:#69758a}nav{display:flex;gap:8px;margin-bottom:24px}button{border:0;border-radius:9px;background:#6c5ce7;color:white;padding:11px 16px;cursor:pointer}button[aria-pressed=false]{background:white;color:#5c6678}button:disabled{background:#dce9df;color:#34754c;cursor:default}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.metrics article{display:grid;gap:8px;padding:24px;background:white;border-radius:16px}.metrics strong{font-size:30px}.metrics span{font-size:13px;color:#69758a}input{display:block;border:1px solid #dce1ed;border-radius:8px;padding:12px;background:white;font:inherit;width:100%;margin-top:8px}.search{display:block;margin:24px 0}.requests{display:grid;gap:12px}.requests article{display:flex;align-items:center;gap:20px;padding:20px;background:white;border:1px solid #e1e5ef;border-radius:14px}.requests article>div{flex:1}h2{margin:0;font-size:16px}.requests article p{font-size:13px;margin-bottom:0}.requests article>span{font-size:12px;color:#69758a}form{display:flex;align-items:end;gap:12px;margin-top:24px}form label{flex:1;font-size:13px}@media(max-width:600px){main{padding:18px}h1{font-size:24px}.metrics{gap:8px}.metrics article{padding:16px}.requests article{padding:16px;flex-wrap:wrap}.requests article>div{flex-basis:100%}form{align-items:stretch;flex-direction:column}}` },
    ],
  };
}
