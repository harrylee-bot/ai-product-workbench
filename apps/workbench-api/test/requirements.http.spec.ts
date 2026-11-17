import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { RequirementsController } from '../src/modules/requirements/requirements.controller.js';
import { RequirementsService } from '../src/modules/requirements/requirements.service.js';
import { WorkbenchAuthGuard } from '../src/modules/identity/workbench-auth.guard.js';
import { ProblemDetailsFilter } from '../src/common/problem-details.filter.js';
const apps:NestExpressApplication[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
async function harness(){
 const snapshot={revision:7,state:'analyzing'};
 const service={list:vi.fn().mockResolvedValue({items:[],nextCursor:null}),retryConfirmation:vi.fn().mockResolvedValue(snapshot),get:vi.fn().mockResolvedValue(snapshot),message:vi.fn().mockResolvedValue(snapshot),confirm:vi.fn().mockResolvedValue(snapshot),action:vi.fn().mockResolvedValue(snapshot)};
 const config={get:(name:string)=>name==='WORKBENCH_AUTH_MODE'?'development':name==='NODE_ENV'?'test':undefined};
 const identity={resolvePrincipal:vi.fn().mockResolvedValue({id:'owner'})};
 const guard=new WorkbenchAuthGuard(config as never,identity as never);
 class TestModule{};Module({controllers:[RequirementsController],providers:[{provide:ConfigService,useValue:config},{provide:IdentityService,useValue:identity},{provide:RequirementsService,useValue:service},{provide:WorkbenchAuthGuard,useValue:guard}]})(TestModule);
 const app=await NestFactory.create<NestExpressApplication>(TestModule,{logger:false,abortOnError:false});apps.push(app);app.setGlobalPrefix('api/v1');app.useGlobalFilters(new ProblemDetailsFilter());await app.listen(0,'127.0.0.1');const address=app.getHttpServer().address();if(!address||typeof address==='string')throw Error('NO_TEST_PORT');return {service,origin:`http://127.0.0.1:${address.port}/api/v1/requirement-sessions/session-1`};
}
describe('Requirement HTTP metadata, validation and authentication boundary (fixture service)',()=>{
 it('requires authentication before session state is disclosed',async()=>{const h=await harness();const r=await fetch(h.origin);expect(r.status).toBe(401);expect(h.service.get).not.toHaveBeenCalled();});
 it('rejects a missing strong ETag without saving a message',async()=>{const h=await harness();const r=await fetch(h.origin+'/messages',{method:'POST',headers:{'x-workbench-dev-subject':'owner','content-type':'application/json','idempotency-key':'message-1234'},body:JSON.stringify({text:'加一个筛选'})});expect(r.status).toBe(428);expect(h.service.message).not.toHaveBeenCalled();});
 it('forwards explicit intent with CAS and returns a private 202 receipt',async()=>{const h=await harness();const r=await fetch(h.origin+'/messages',{method:'POST',headers:{'x-workbench-dev-subject':'owner','content-type':'application/json','idempotency-key':'message-1234','if-match':'"6"'},body:JSON.stringify({text:'按建议直接生成',intent:'confirm_suggestion'})});expect(r.status).toBe(202);expect(r.headers.get('etag')).toBe('"7"');expect(r.headers.get('cache-control')).toBe('private, no-store');expect(h.service.message).toHaveBeenCalledWith('owner','session-1','message-1234',6,{text:'按建议直接生成',intent:'confirm_suggestion'});});
 it('rejects injected or incomplete confirmation data',async()=>{const h=await harness();const r=await fetch(h.origin+'/confirm',{method:'POST',headers:{'x-workbench-dev-subject':'owner','content-type':'application/json','idempotency-key':'confirm-1234','if-match':'"6"'},body:JSON.stringify({summaryVersion:1,modelSaysConfirmed:true})});expect(r.status).toBe(400);expect(h.service.confirm).not.toHaveBeenCalled();});
 it('dispatch retry binds the confirmation, new command key and current ETag',async()=>{const h=await harness();const r=await fetch(h.origin+'/confirmations/confirmation-1/retry',{method:'POST',headers:{'x-workbench-dev-subject':'owner','idempotency-key':'retry-dispatch-1234','if-match':'"6"'}});expect(r.status).toBe(202);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(h.service.retryConfirmation).toHaveBeenCalledWith('owner','session-1','confirmation-1','retry-dispatch-1234',6);});
 it('validates the session page limit and keeps the list private',async()=>{const h=await harness(),url=h.origin.replace('/requirement-sessions/session-1','/threads/thread-1/requirement-sessions');const invalid=await fetch(url+'?limit=101',{headers:{'x-workbench-dev-subject':'owner'}});expect(invalid.status).toBe(400);expect(h.service.list).not.toHaveBeenCalled();const page=await fetch(url+'?limit=2&cursor=opaque',{headers:{'x-workbench-dev-subject':'owner'}});expect(page.status).toBe(200);expect(page.headers.get('cache-control')).toBe('private, no-store');expect(h.service.list).toHaveBeenCalledWith('owner','thread-1','opaque',2);});
});
