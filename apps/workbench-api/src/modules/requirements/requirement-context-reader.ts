import { Inject,Injectable } from '@nestjs/common';
import { canonicalJson, prototypeDocumentSchema, type PrototypeDocument, type PrototypeInputSnapshot, type StartRunRequest } from '@workbench/workbench-contracts';
import { WorkbenchDbService } from '../../platform/database/workbench-db.service.js';
import { READY_BLOB_STORAGE_PORT,type ReadyBlobStoragePort } from '../../platform/object-storage/object-storage.port.js';
import { readReadyObject } from '../../platform/object-storage/read-ready-object.js';
import { readyObjectIntegrityRecorder } from '../../platform/object-storage/ready-object-integrity.js';
import { requirementProblem } from './requirement-policy.js';

// Generated screens commonly repeat their complete style and layout on every
// node. Keep the original node order, interactions, content and design values.
// The generation worker still reads the original immutable ArtifactVersion.
function indexValues<T extends Record<string, unknown>>(values: T[]) {
 const entries: T[] = [];
 const indices = new Map<string, number>();
 const references = values.map(value => {
  const key = canonicalJson(value);
  let index = indices.get(key);
  if (index === undefined) {
   index = entries.length;
   entries.push(value);
   indices.set(key, index);
  }
  return index;
 });
 const defaults: Record<string, unknown> = { ...entries[0] };
 const defaultKeys = new Map<string, string>();
 for (const [key,value] of Object.entries(defaults)) {
  if (entries.every(entry => Object.hasOwn(entry,key))) defaultKeys.set(key,canonicalJson(value));
  else delete defaults[key];
 }
 const overrides = entries.map(entry => Object.fromEntries(
  Object.entries(entry).filter(([key,value]) => canonicalJson(value) !== defaultKeys.get(key)),
 ));
 return { table: { defaults, overrides }, references };
}

function compactPrototype(document: PrototypeDocument) {
 const layouts = indexValues(document.nodes.map(node => node.layout));
 const styles = indexValues(document.nodes.map(node => node.style));
 return {
  ...document, layouts: layouts.table, styles: styles.table,
  nodes: document.nodes.map(({layout, style, ...node}, index) => ({
   ...node, layoutIndex: layouts.references[index], styleIndex: styles.references[index],
  })),
 };
}

@Injectable()
export class RequirementContextReader {
 constructor(private readonly db:WorkbenchDbService,@Inject(READY_BLOB_STORAGE_PORT) private readonly storage:ReadyBlobStoragePort){}
 async read(projectId:string,snapshot:PrototypeInputSnapshot,request:StartRunRequest,signal:AbortSignal){
  let remaining=60000;
  const readings=[];
  for(const source of snapshot.sources)for(const frozen of source.snapshot.blobs){
   const row=await this.db.importSourceBlob.findFirst({where:{importSourceId:source.sourceId,blobId:frozen.blobId,source:{projectId}},include:{blob:true,fileAsset:{include:{currentExtraction:{include:{outputs:{include:{blob:true}}}}}}}});
   if(!row||row.sha256!==frozen.sha256||row.blob.status!=='ready'||row.blob.deletedAt)throw requirementProblem('REQUIREMENT_SOURCE_CHANGED');
   const extraction=row.fileAsset?.currentExtraction;
   const output=extraction?.status==='ready'?extraction.outputs.find(x=>x.kind==='text')??extraction.outputs.find(x=>x.kind==='markdown'):null;
   const originalText=/^(text\/|application\/(json|xml))/i.test(row.blob.mediaType);
   const blob=originalText?row.blob:output?.blob;
   if(!blob||blob.status!=='ready'||blob.deletedAt)throw requirementProblem('REQUIREMENT_SOURCE_TEXT_UNAVAILABLE');
   if(blob.byteSize>BigInt(remaining))throw requirementProblem('REQUIREMENT_SOURCE_CONTEXT_LIMIT',413);
   const content=await readReadyObject(this.storage,{storageKey:blob.storageKey,sha256:blob.sha256,byteSize:Number(blob.byteSize),mediaType:blob.mediaType},undefined,undefined,{signal,recordIntegrityFailure:readyObjectIntegrityRecorder(this.db)});
   if(content.notModified)throw requirementProblem('REQUIREMENT_SOURCE_CHANGED');
   const buffers=[];for await(const part of content.body)buffers.push(Buffer.from(part));const bytes=Buffer.concat(buffers);remaining-=bytes.length;
   let text:string;
   try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw requirementProblem('REQUIREMENT_SOURCE_TEXT_UNAVAILABLE');}
   readings.push({sourceId:source.sourceId,originalBlobId:row.blob.id,blobId:blob.id,text,sha256:blob.sha256,extraction:originalText?null:{id:extraction!.id,kind:output!.kind,position:output!.position,content:{storageKey:blob.storageKey,sha256:blob.sha256,byteSize:Number(blob.byteSize),mediaType:blob.mediaType}}});
  }
  const artifactTargets=[];
  for(const target of request.artifactTargets){
   const version=await this.db.artifactVersion.findFirst({where:{id:target.artifactVersionId,artifactId:target.artifactId,projectId,status:'ready'},select:{id:true,checksum:true,content:true,contentBlobId:true}});
   if(!version||version.contentBlobId)throw requirementProblem('REQUIREMENT_SOURCE_TEXT_UNAVAILABLE');
   const size=JSON.stringify(version.content).length;
   if(size<=remaining){remaining-=size;artifactTargets.push(version);continue;}
   const prototype=prototypeDocumentSchema.safeParse(version.content);
   if(!prototype.success)throw requirementProblem('REQUIREMENT_CONTEXT_LIMIT',429);
   const content=compactPrototype(prototype.data);
   const compactSize=JSON.stringify(content).length;
   if(compactSize>remaining)throw requirementProblem('REQUIREMENT_CONTEXT_LIMIT',429);
   remaining-=compactSize;
   artifactTargets.push({...version,content,contentEncoding:'For each node, combine layouts.defaults with layouts.overrides[layoutIndex], and styles.defaults with styles.overrides[styleIndex]. Overrides take precedence.'});
  }
  return {readings,artifactTargets};
 }
}
