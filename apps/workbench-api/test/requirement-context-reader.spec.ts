import { describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { RequirementContextReader } from '../src/modules/requirements/requirement-context-reader.js';
import { prototypeDocumentFixture, prototypeTextNodeFixture } from '../../../packages/workbench-contracts/test/prototype-fixture.js';
const sha=createHash('sha256').update('abc').digest('hex');
const blob={id:'blob-1',status:'ready',deletedAt:null,storageKey:'ready/owned',mediaType:'text/plain',byteSize:3n,sha256:sha};
const row={sha256:sha,blob,fileAsset:null};
const snapshot={sources:[{sourceId:'source-1',snapshot:{blobs:[{blobId:'blob-1',sha256:sha}]}}]};
const request={artifactTargets:[]};
function harness(value:any=row,body:string|Buffer='abc'){
 const db={importSourceBlob:{findFirst:vi.fn().mockResolvedValue(value)}};
 const storage={getObject:vi.fn().mockImplementation(async()=>({body:Readable.from([Buffer.from(body)]),byteSize:3,mediaType:'text/plain',contentRange:null}))};
 return {db,storage,reader:new RequirementContextReader(db as never,storage)};
}
describe('Requirement source contents use verified immutable bytes',()=>{
 it('represents a large, fixed prototype losslessly inside the discussion budget',async()=>{
  const content=prototypeDocumentFixture();
  const root=content.nodes[0]!;
  if(root.kind!=='frame')throw new Error('Fixture screen root must be a frame');
  for(let index=0;index<75;index++){
   const node=prototypeTextNodeFixture(`note-${index}`,root.screenId,root.id,`渠道说明 ${index}`);
   root.childIds.push(node.id);content.nodes.push(node);
  }
  expect(JSON.stringify(content).length).toBeGreaterThan(60000);
  const version={id:'fixed-version',content,checksum:'a'.repeat(64),contentBlobId:null};
  const reader=new RequirementContextReader({artifactVersion:{findFirst:vi.fn().mockResolvedValue(version)}} as never,{} as never);
  const view=await reader.read('project-1',{sources:[]} as never,{artifactTargets:[{artifactId:'frozen-artifact',artifactVersionId:version.id,screenIds:[]}]} as never,new AbortController().signal);
  const [target]=view.artifactTargets;
  expect(target).toMatchObject({id:version.id,checksum:version.checksum,contentEncoding:expect.any(String)});
  const packed=target!.content as any;
  expect(JSON.stringify(packed).length).toBeLessThan(60000);
  const {layouts,styles,nodes,...document}=packed;
  const originalNodes=nodes.map(({layoutIndex,styleIndex,...node}:any)=>({
   ...node,layout:{...layouts.defaults,...layouts.overrides[layoutIndex]},style:{...styles.defaults,...styles.overrides[styleIndex]},
  }));
  expect({...document,nodes:originalNodes}).toEqual(content);
 });
 it('reads the scoped snapshot with hash verification and records exact identity',async()=>{const h=harness();const value=await h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal);expect(value.readings[0]).toMatchObject({sourceId:'source-1',originalBlobId:'blob-1',sha256:sha,text:'abc',extraction:null});expect(h.db.importSourceBlob.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({source:{projectId:'project-1'}})}));});
 it('does not send corrupted source bytes to the model',async()=>{const h=harness(row,'xyz');await expect(h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal)).rejects.toBeDefined();});
 it('does not silently skip an unreadable binary source without extraction',async()=>{const h=harness({...row,blob:{...blob,mediaType:'application/pdf'}});await expect(h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal)).rejects.toMatchObject({status:409,response:{code:'REQUIREMENT_SOURCE_TEXT_UNAVAILABLE'}});expect(h.storage.getObject).not.toHaveBeenCalled();});
 it('rejects an oversized source before opening its object',async()=>{
  const h=harness({...row,blob:{...blob,byteSize:60001n}});
  await expect(h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal))
   .rejects.toMatchObject({status:413,response:{code:'REQUIREMENT_SOURCE_CONTEXT_LIMIT'}});
  expect(h.storage.getObject).not.toHaveBeenCalled();
 });
 it('reports verified text with invalid UTF-8 as unreadable',async()=>{
  const bytes=Buffer.from([0xff,0xff,0xff]);
  const checksum=createHash('sha256').update(bytes).digest('hex');
  const invalid=harness({...row,sha256:checksum,blob:{...blob,sha256:checksum}},bytes);
  const source={sources:[{sourceId:'source-1',snapshot:{blobs:[{blobId:'blob-1',sha256:checksum}]}}]};
  await expect(invalid.reader.read('project-1',source as never,request as never,new AbortController().signal))
   .rejects.toMatchObject({status:409,response:{code:'REQUIREMENT_SOURCE_TEXT_UNAVAILABLE'}});
 });
 it('rejects missing or foreign source metadata before content access',async()=>{const h=harness(null);await expect(h.reader.read('project-1',snapshot as never,request as never,new AbortController().signal)).rejects.toMatchObject({status:409});expect(h.storage.getObject).not.toHaveBeenCalled();});
});
