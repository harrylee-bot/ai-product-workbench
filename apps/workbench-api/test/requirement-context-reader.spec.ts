import { describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { RequirementContextReader } from '../src/modules/requirements/requirement-context-reader.js';
const sha=createHash('sha256').update('abc').digest('hex');
const blob={id:'blob-1',status:'ready',deletedAt:null,storageKey:'ready/owned',mediaType:'text/plain',byteSize:3n,sha256:sha};
const row={sha256:sha,blob,fileAsset:null};
const snapshot={sources:[{sourceId:'source-1',snapshot:{blobs:[{blobId:'blob-1',sha256:sha}]}}]};
const request={artifactTargets:[]};
function harness(value:any=row,body='abc'){
 const db={importSourceBlob:{findFirst:vi.fn().mockResolvedValue(value)}};
 const storage={getObject:vi.fn().mockImplementation(async()=>({body:Readable.from([Buffer.from(body)]),byteSize:3,mediaType:'text/plain',contentRange:null}))};
 return {db,storage,reader:new RequirementContextReader(db as never,storage)};
}
describe('Requirement source contents use verified immutable bytes',()=>{
 it('reads the scoped snapshot with hash verification and records exact identity',async()=>{const h=harness();const value=await h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal);expect(value.readings[0]).toMatchObject({sourceId:'source-1',originalBlobId:'blob-1',sha256:sha,text:'abc',extraction:null});expect(h.db.importSourceBlob.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({source:{projectId:'project-1'}})}));});
 it('does not send corrupted source bytes to the model',async()=>{const h=harness(row,'xyz');await expect(h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal)).rejects.toBeDefined();});
 it('does not silently skip an unreadable binary source without extraction',async()=>{const h=harness({...row,blob:{...blob,mediaType:'application/pdf'}});await expect(h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal)).rejects.toMatchObject({status:409});expect(h.storage.getObject).not.toHaveBeenCalled();});
 it('rejects missing or foreign source metadata before content access',async()=>{const h=harness(null);await expect(h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal)).rejects.toMatchObject({status:409});expect(h.storage.getObject).not.toHaveBeenCalled();});
});
