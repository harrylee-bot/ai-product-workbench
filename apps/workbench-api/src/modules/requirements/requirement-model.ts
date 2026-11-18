import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requirementAnalysisSchema } from '@workbench/workbench-contracts';
import { RequirementModelOutputError, requirementProblem, REQUIREMENT_SYSTEM_PROMPT, type RequirementCitationCorrection } from './requirement-policy.js';
export type RequirementModelInput={messages:{role:'user'|'assistant';content:string}[];context:unknown;citationCorrection?:RequirementCitationCorrection};
const citationCorrections:Record<RequirementCitationCorrection,string>={
 claim_shape:'重新按 schema 输出。existingCapabilities 的每条能力需有描述、明确来源范围和至少一个证据短 ID；省略无法以已授权证据支持的能力。',
 evidence_id:'重新按 schema 输出。检查每个 evidenceIds，只能使用当前 evidence 中可逐字复制的短 ID。不要使用其他条目、文件名或项目附件 ID。',
 evidence_scope:'重新按 schema 输出。检查每条既有能力，把支持这条能力的 evidence 的短 ID 和 scope 原样配对。缩小相应能力描述或省略无足够证据的能力。不要提升来源的适用范围。',
};
@Injectable()
export class RequirementModel {
 constructor(private readonly config:ConfigService){}
 async analyze(input:RequirementModelInput,signal:AbortSignal){
  const key=this.config.get<string>('WORKBENCH_REQUIREMENTS_API_KEY');
  const base=this.config.get<string>('WORKBENCH_REQUIREMENTS_BASE_URL');
  const configured=this.config.get<string>('WORKBENCH_REQUIREMENTS_MODEL')??'deepseek-flash';
  // The approved Flash family is labeled 4.1 by the product; the existing
  // provider contract and model catalog use deepseek-flash on the wire.
  const model=configured==='deepseek-4.1-flash'?'deepseek-flash':configured;
  if(!key||!base)throw requirementProblem('REQUIREMENT_MODEL_UNAVAILABLE',503);
  // No provider discovery, alternate model or automatic fallback.
  if(model!=='deepseek-flash')throw requirementProblem('REQUIREMENT_MODEL_NOT_ALLOWED',503);
  const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw requirementProblem('REQUIREMENT_MODEL_UNAVAILABLE',503);
  const format=JSON.stringify(requirementAnalysisSchema.toJSONSchema());
  const correction=input.citationCorrection?citationCorrections[input.citationCorrection]+'\n':'';
  const response=await fetch(base.replace(/\/$/,'')+'/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model,messages:[{role:'system',content:REQUIREMENT_SYSTEM_PROMPT+'\n'+correction+'JSON schema:\n'+format},{role:'user',content:JSON.stringify({context:input.context,discussion:input.messages})}],response_format:{type:'json_object'},max_tokens:8000,stream:false,thinking:{type:'disabled'},temperature:0.1})}).catch(error=>{
   if(signal.aborted)throw error;
   throw requirementProblem('REQUIREMENT_MODEL_UNAVAILABLE',503);
  });
  if(!response.ok){await response.body?.cancel();throw requirementProblem('REQUIREMENT_MODEL_UNAVAILABLE',503);}
  const reader=response.body?.getReader();if(!reader)throw new RequirementModelOutputError('response_body');
  const buffers:Uint8Array[]=[];let bytes=0;
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>128*1024){await reader.cancel();throw new RequirementModelOutputError('response_size');}buffers.push(part.value);}
  let body;try{body=JSON.parse(Buffer.concat(buffers).toString());}catch{throw new RequirementModelOutputError('provider_envelope');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new RequirementModelOutputError('provider_envelope');
  if(body.model&&body.model!=='deepseek-flash')throw requirementProblem('REQUIREMENT_MODEL_NOT_ALLOWED',503);
  const choice=body.choices?.[0];
  let value;try{value=JSON.parse(choice?.message?.content);}catch{
   throw new RequirementModelOutputError(choice?.finish_reason==='length'?'completion_truncated':'completion_json');
  }
  const tokens=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0?Number(n):null;
  return {value,inputTokens:tokens(body.usage?.prompt_tokens),outputTokens:tokens(body.usage?.completion_tokens)};
 }
}
