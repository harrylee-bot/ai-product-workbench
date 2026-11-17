import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  const release=await this.db.knowledgeRelease.findFirst({where:{status:'ready',projectId},orderBy:{version:'desc'}})??await this.db.knowledgeRelease.findFirst({where:{status:'ready',projectId:null,OR:[{workspaceId:project.workspaceId},{workspaceId:null}]},orderBy:[{version:'desc'},{createdAt:'desc'}]});
  if(!release)throw requirementProblem('REQUIREMENT_KNOWLEDGE_UNAVAILABLE',503);
  const result=await this.retrieval.retrieve({principalId,projectId,releaseId:release.id,query:query.slice(0,2000),mode:this.hybrid?'hybrid':'lexical',routeScope:'production'},signal);
  const policy=await this.retrieval.retrieve({principalId,projectId,releaseId:release.id,query:'产品能力地图 业务增量 任务分类 知识分层 冲突裁决',mode:this.hybrid?'hybrid':'lexical',routeScope:'production'},signal);
  const items=[...new Map([...result.items,...policy.items].map(item=>[item.citation.id,item])).values()];
  const evidence:RequirementEvidence[]=items.slice(0,30).map(({citation:c})=>({id:c.id,releaseId:release.id,releaseVersion:release.version,documentId:c.documentId,chunkId:c.chunkId,sourcePath:c.sourcePath,title:c.title,quote:c.quote,scope:classifyEvidenceScope(c.sourcePath,c.quote),checksum:createHash('sha256').update(c.quote).digest('hex')}));
  return {releaseId:release.id,evidence,retrievalEvidence:[result.evidence,policy.evidence]};
 }
}
export function classifyEvidenceScope(path:string,quote:string):RequirementEvidence['scope']{
 if(/区域|案例|省分|省公司|市公司|试点/u.test(path)||/(仅适用|适用范围)[^\n]{0,60}(省|市|区域)/u.test(quote))return 'regional';
 if(/模板|活动类型/u.test(path))return 'template';
 if(/原型|\.rp\b|\.html\b/iu.test(path))return 'prototype';
 if(/产品架构|平台共性|产品能力地图|业务增量规则|知识库使用规范|业务增量原型规则/u.test(path))return 'platform';
 return 'uncertain';
}
