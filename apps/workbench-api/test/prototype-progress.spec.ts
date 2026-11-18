import { describe, expect, it, vi } from "vitest";
import { PrototypeV2Service } from "../src/modules/prototypes/prototype-v2.service.js";
function setup(role: string | null = 'viewer') {
 const tx = { prototypePlan:{findFirst:vi.fn().mockResolvedValue({id:'plan',projectId:'project',generationRequest:null,runtimeRunId:null,reusedRunId:null,status:'approved',contentVersion:1,rootPlanId:null})},prototypeRevision:{findFirst:vi.fn().mockResolvedValue(null)},run:{findFirst:vi.fn().mockResolvedValue(null)},$queryRaw:vi.fn() };
 const db = {projectMember:{findFirst:vi.fn().mockResolvedValue(role?{role}:null)},$transaction:vi.fn((work:Function)=>work(tx))};
 const service=new PrototypeV2Service(db as never,{configured:false} as never,{} as never,{} as never);
 return {service,tx,db};
}
describe('prototype progress authorization and explicit binding',()=>{
 it('rejects a plan without its confirmed Run binding',async()=>{const {service,tx}=setup();await expect(service.getProgress({id:'user'} as never,'project','plan')).rejects.toMatchObject({status:404});expect(tx.run.findFirst).not.toHaveBeenCalled();});
 it('rejects nonmembers before reading the plan or runtime',async()=>{const {service,tx}=setup(null);await expect(service.getProgress({id:'outsider'} as never,'project','plan')).rejects.toMatchObject({status:403});expect(tx.prototypePlan.findFirst).not.toHaveBeenCalled();});
 it('scopes both Plan and Run to the authorized project',async()=>{const {service,tx}=setup();tx.prototypePlan.findFirst.mockResolvedValueOnce({...await tx.prototypePlan.findFirst(),runtimeRunId:'other-run'});await expect(service.getProgress({id:'user'} as never,'project','plan')).rejects.toMatchObject({status:404});expect(tx.run.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:'other-run',projectId:'project'}}));expect(tx.$queryRaw).not.toHaveBeenCalled();});
});
