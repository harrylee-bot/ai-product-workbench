import { describe,it,expect } from 'vitest';
import { assertConfirmed,isReady,validateAnalysis } from '../src/modules/requirements/requirement-policy.js';
import { classifyEvidenceScope, requirementSearchExcerpt } from '../src/modules/requirements/requirement-knowledge.js';
import type { RequirementCard,RequirementEvidence } from '@workbench/workbench-contracts';
export const evidence:RequirementEvidence[]=[{id:'cite-1',releaseId:'release-1',releaseVersion:1,documentId:'doc-1',chunkId:'chunk-1',sourcePath:'01-产品架构/产品能力地图.md',title:'活动平台',quote:'活动管理包括列表、新建和复制。',scope:'platform',checksum:'a'.repeat(64)}];
export const card:RequirementCard={goal:'为活动列表新增渠道筛选',platform:'既有活动平台',modules:['活动管理'],roles:['策划'],existingCapabilities:[{description:'复用活动列表',evidenceIds:['cite-1'],scope:'platform'}],reuse:['原列表'],changes:['增加渠道筛选'],affectedPages:['活动列表'],affectedFlows:['按渠道筛选'],targetSurface:'web',designConstraints:['保留现有导航'],outputKinds:['prd','prototype'],assumptions:[],issues:[],platformChanges:[],preserved:['原有区域权限']};
describe('Incremental requirement boundary',()=>{
 it('keeps long requirement search within the pinned encoder budget and includes later context',()=>{
  const query='开头渠道规则。'+'📄资格审核'.repeat(150)+'结尾区域范围。';
  const excerpt=requirementSearchExcerpt(query,250);
  expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(250);
  expect(excerpt).toMatch(/^开头渠道规则/u);expect(excerpt).toMatch(/结尾区域范围。$/u);
  expect(excerpt).not.toContain('�');expect(requirementSearchExcerpt('渠道筛选',250)).toBe('渠道筛选');
 });
 it('keeps partial discussion out of generation',()=>expect(isReady(null,evidence)).toBe(false));
 it('permits a grounded incremental addition',()=>expect(isReady(card,evidence)).toBe(true));
 it('cannot count retrieval alone as a complete requirement',()=>expect(isReady({existingCapabilities:card.existingCapabilities},evidence)).toBe(false));
 it.each(['scope','workflow','permission','financial','external_dependency','platform'] as const)('blocks critical %s even if model says nonblocking',impact=>expect(isReady({...card,issues:[{id:'gap',kind:'missing',question:'请确认影响',impact,blocking:false,evidenceIds:[]}]},evidence)).toBe(false));
 it('cannot generate without published evidence',()=>expect(isReady(card,[])).toBe(false));
 it('rejects forged citations',()=>expect(()=>validateAnalysis({reply:'已知',card:{...card,existingCapabilities:[{...card.existingCapabilities[0],evidenceIds:['forged']}]}},evidence)).toThrow());
 it('does not promote regional evidence to platform facts',()=>expect(()=>validateAnalysis({reply:'已知',card},[{...evidence[0],scope:'regional'}])).toThrow());
 it('requires explicit acceptance for suggested assumptions',()=>expect(()=>assertConfirmed({...card,assumptions:[{id:'assumption',text:'默认不改变原数据范围',evidenceIds:[]}]},evidence,[],false)).toThrow());
 it('requires explicit platform-change consent',()=>expect(()=>assertConfirmed({...card,platformChanges:['重组跨省权限']},evidence,[],false)).toThrow());
 it('classifies regional and prototype examples conservatively',()=>{expect(classifyEvidenceScope('案例/省公司营销.md','试点')).toBe('regional');expect(classifyEvidenceScope('原型/foo.html','')).toBe('prototype');expect(classifyEvidenceScope('未知手册.md','')).toBe('uncertain');});
 it.each(['uncertain','regional','prototype'] as const)('does not promote %s evidence into template-wide facts',scope=>{
  const candidate={...card,existingCapabilities:[{...card.existingCapabilities[0],scope:'template' as const}]};
  expect(()=>validateAnalysis({reply:'现有模板',card:candidate},[{...evidence[0],scope}])).toThrow();
  expect(isReady(candidate,[{...evidence[0],scope}])).toBe(false);
 });
 it('requires reliable scope support even when isReady is called directly',()=>expect(isReady(card,[{...evidence[0],scope:'uncertain'}])).toBe(false));
 it('accepts explicitly no-page PRD-only changes without inventing UI',()=>expect(isReady({...card,goal:'仅为既有回传接口增加幂等字段',outputKinds:['prd'],roles:[],affectedPages:[],affectedFlows:[]},evidence)).toBe(true));
 it('does not treat unknown-channel business labels as missing information',()=>expect(isReady({...card,goal:'活动报表新增未知渠道统计'},evidence)).toBe(true));
 it('still rejects an actual unknown platform placeholder',()=>expect(isReady({...card,platform:'未知'},evidence)).toBe(false));

});
