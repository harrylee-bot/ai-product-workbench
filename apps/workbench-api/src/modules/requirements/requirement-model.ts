import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requirementAnalysisSchema } from '@workbench/workbench-contracts';
import { requirementProblem, REQUIREMENT_SYSTEM_PROMPT } from './requirement-policy.js';
export type RequirementModelInput={messages:{role:'user'|'assistant';content:string}[];context:unknown};
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
  const response=await fetch(base.replace(/\/$/,'')+'/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model,messages:[{role:'system',content:REQUIREMENT_SYSTEM_PROMPT+'\nJSON schema:\n'+format},{role:'user',content:JSON.stringify({context:input.context,discussion:input.messages})}],response_format:{type:'json_object'},max_tokens:8000,stream:false,thinking:{type:'disabled'},temperature:0.1})}).catch(error=>{
   if(signal.aborted)throw error;
   throw requirementProblem('REQUIREMENT_MODEL_UNAVAILABLE',503);
  });
  if(!response.ok){await response.body?.cancel();throw requirementProblem('REQUIREMENT_MODEL_UNAVAILABLE',503);}
  const reader=response.body?.getReader();if(!reader)throw requirementProblem('REQUIREMENT_MODEL_OUTPUT_INVALID',503);
  const buffers:Uint8Array[]=[];let bytes=0;
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>128*1024){await reader.cancel();throw requirementProblem('REQUIREMENT_MODEL_OUTPUT_INVALID',503);}buffers.push(part.value);}
  let body;try{body=JSON.parse(Buffer.concat(buffers).toString());}catch{throw requirementProblem('REQUIREMENT_MODEL_OUTPUT_INVALID',503);}
  if(body.model&&body.model!=='deepseek-flash')throw requirementProblem('REQUIREMENT_MODEL_NOT_ALLOWED',503);
  let value;try{value=JSON.parse(body.choices?.[0]?.message?.content);}catch{throw requirementProblem('REQUIREMENT_MODEL_OUTPUT_INVALID',503);}
  const tokens=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0?Number(n):null;
  return {value,inputTokens:tokens(body.usage?.prompt_tokens),outputTokens:tokens(body.usage?.completion_tokens)};
 }
}
