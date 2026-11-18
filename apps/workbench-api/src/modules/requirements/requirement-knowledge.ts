import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parseEmbeddingProfileV1, parseRetrievalProfileV1 } from '@workbench/workbench-knowledge';
import type { RequirementEvidence } from '@workbench/workbench-contracts';
import { WorkbenchDbService } from '../../platform/database/workbench-db.service.js';
import { AccessService } from '../access/access.service.js';
import { KnowledgeRetrievalConfig } from '../knowledge/knowledge-retrieval.config.js';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service.js';
import { PrismaKnowledgeRetrievalStore } from '../knowledge/prisma-knowledge-retrieval.store.js';
import { JiebaQuerySegmenterAdapter } from '../knowledge/jieba-query-segmenter.adapter.js';
import { TeiQueryEmbeddingAdapter } from '../knowledge/tei-query-embedding.adapter.js';
import { TeiRerankerAdapter } from '../knowledge/tei-reranker.adapter.js';
import { requirementProblem } from './requirement-policy.js';
@Injectable()
export class RequirementKnowledge {
 private readonly retrieval:KnowledgeRetrievalService;
 constructor(private readonly db:WorkbenchDbService,private readonly access:AccessService,config:KnowledgeRetrievalConfig){
  this.retrieval=new KnowledgeRetrievalService(access,new PrismaKnowledgeRetrievalStore(db),{segmenter:new JiebaQuerySegmenterAdapter(),...(config.providers?{queryEmbedding:new TeiQueryEmbeddingAdapter(config.providers.embedding),reranker:new TeiRerankerAdapter(config.providers.reranker)}:{})});
  this.hybrid=!!config.providers;
 }
 private readonly hybrid:boolean;
 async retrieve(principalId:string,projectId:string,query:string,signal:AbortSignal){
  const project=await this.access.findProject(principalId,projectId,'read');
  const profiles={embeddingProfile:{select:{spec:true}},retrievalProfile:{select:{spec:true}}};
  const release=await this.db.knowledgeRelease.findFirst({include:profiles,where:{status:'ready',projectId},orderBy:{version:'desc'}})??await this.db.knowledgeRelease.findFirst({include:profiles,where:{status:'ready',projectId:null,OR:[{workspaceId:project.workspaceId},{workspaceId:null}]},orderBy:[{version:'desc'},{createdAt:'desc'}]});
  if(!release)throw requirementProblem('REQUIREMENT_KNOWLEDGE_UNAVAILABLE',503);
  let search=query.slice(0,2000);
  if(this.hybrid){
   const embedding=parseEmbeddingProfileV1(release.embeddingProfile.spec).spec;
   const reranker=parseRetrievalProfileV1(release.retrievalProfile.spec).spec.reranker;
   // Reserve room for the pinned document window, prefixes and pair separators.
   const budget=Math.min(embedding.tokenizer.modelMaximumTokens-Buffer.byteLength(embedding.input.queryPrefix),
    reranker.tokenizer.maximumInputTokens-Math.min(embedding.tokenizer.chunkMaximumTokens,Math.floor(reranker.tokenizer.maximumInputTokens/2)))-3;
   search=requirementSearchExcerpt(query,budget);
  }
  const result=await this.retrieval.retrieve({principalId,projectId,releaseId:release.id,query:search,mode:this.hybrid?'hybrid':'lexical',routeScope:'production'},signal);
  const policy=await this.retrieval.retrieve({principalId,projectId,releaseId:release.id,query:'产品能力地图 业务增量 任务分类 知识分层 冲突裁决',mode:this.hybrid?'hybrid':'lexical',routeScope:'production'},signal);
  const items=[...new Map([...result.items,...policy.items].map(item=>[item.citation.id,item])).values()];
  const evidence:RequirementEvidence[]=items.slice(0,30).map(({citation:c})=>({id:c.id,releaseId:release.id,releaseVersion:release.version,documentId:c.documentId,chunkId:c.chunkId,sourcePath:c.sourcePath,title:c.title,quote:c.quote,scope:classifyEvidenceScope(c.sourcePath,c.quote),checksum:createHash('sha256').update(c.quote).digest('hex')}));
  return {releaseId:release.id,evidence,retrievalEvidence:[result.evidence,policy.evidence]};
 }
}
// A search query is a projection of the discussion. Keep full messages for the
// model and the confirmation, even when they exceed the encoder's pair window.
export function requirementSearchExcerpt(text:string,budget:number):string {
 const normalized=text.trim().normalize('NFKC');
 if(Buffer.byteLength(normalized)<=budget)return normalized;
 const points=Array.from(normalized);
 const window=Math.floor((budget-2)/3);
 if(window<4)throw requirementProblem('REQUIREMENT_KNOWLEDGE_UNAVAILABLE',503);
 function excerpt(start:number,direction:number){
  const selected:string[]=[];let bytes=0;
  for(let i=start;i>=0&&i<points.length;i+=direction){
   const c=points[i]!;
   if(bytes+Buffer.byteLength(c)>window)break;
   selected.push(c);bytes+=Buffer.byteLength(c);
  }
  return (direction<0?selected.reverse():selected).join('').trim();
 }
 return [excerpt(0,1),excerpt(Math.floor(points.length/2),1),excerpt(points.length-1,-1)].filter(Boolean).join('\n');
}
export function classifyEvidenceScope(path:string,quote:string):RequirementEvidence['scope']{
 if(/区域|案例|省分|省公司|市公司|试点/u.test(path)||/(仅适用|适用范围)[^\n]{0,60}(省|市|区域)/u.test(quote))return 'regional';
 if(/模板|活动类型/u.test(path))return 'template';
 if(/原型|\.rp\b|\.html\b/iu.test(path))return 'prototype';
 if(/产品架构|平台共性|产品能力地图|业务增量规则|知识库使用规范|业务增量原型规则/u.test(path))return 'platform';
 return 'uncertain';
}
