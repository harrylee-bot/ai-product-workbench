import {expect,it,vi} from 'vitest';
import {findStudioRunPlan} from './prototype-run-plan';
const run={id:'run-wanted',projectId:'project-one'};
it('resolves the exact Run binding rather than choosing the latest plan',async()=>{
 const api={listPlans:vi.fn(async()=>[{id:'newer'},{id:'wanted'}]),getProgress:vi.fn(async(_project:string,id:string)=>({projectId:run.projectId,planId:id,run:{id:id==='wanted'?run.id:'unrelated'}}))};
 expect(await findStudioRunPlan(api as any,run)).toBe('wanted');expect(api.getProgress).toHaveBeenCalledTimes(2);
});
it('keeps an unmatched or denied Run unresolved and never invokes a generic retry',async()=>{
 const api={listPlans:vi.fn(async()=>[{id:'other'}]),getProgress:vi.fn(async()=>({projectId:run.projectId,planId:'other',run:{id:'unrelated'}}))};
 await expect(findStudioRunPlan(api as any,run)).rejects.toThrow('准确关联');
 api.getProgress.mockRejectedValue(new Error('403 denied'));await expect(findStudioRunPlan(api as any,run)).rejects.toThrow('403 denied');
});
