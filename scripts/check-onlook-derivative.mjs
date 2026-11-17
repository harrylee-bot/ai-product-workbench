import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),vendor=new URL('third_party/onlook/',root);
const manifest=JSON.parse(await readFile(new URL('manifest.json',vendor),'utf8'));
assert.match(manifest.commit,/^[a-f0-9]{40}$/);
assert.match(await readFile(new URL('LICENSE.md',vendor),'utf8'),/Apache License/);
for(const file of manifest.files){
 const bytes=await readFile(new URL(`upstream/${file.path}`,vendor));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,`Upstream file drift: ${file.path}`);
}
for(const file of manifest.derivatives){
 assert(manifest.files.some(original=>original.path===file.source),`Unpinned source: ${file.source}`);
 const source=await readFile(new URL(file.target,root),'utf8');
 assert(source.includes(manifest.commit)&&source.includes('Apache-2.0'),`Missing attribution: ${file.target}`);
}
console.log(`Onlook ${manifest.commit}: ${manifest.files.length} pinned source files, ${manifest.derivatives.length} attributed derivatives verified.`);

const swarmVendor = new URL('third_party/react-swarm-rebuild/', root);
const swarm = JSON.parse(await readFile(new URL('manifest.json', swarmVendor), 'utf8'));
assert.match(swarm.commit, /^[a-f0-9]{40}$/);
assert.match(await readFile(new URL('LICENSE', swarmVendor), 'utf8'), /MIT License/);
for (const file of swarm.files) {
 const bytes = await readFile(new URL(`upstream/${file.path}`, swarmVendor));
 assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Swarm original drift: ${file.path}`);
}
for (const file of swarm.derivatives) {
 assert(swarm.files.some(original => original.path === file.source), `Unpinned Swarm source: ${file.source}`);
 const source = await readFile(new URL(file.target, root), 'utf8');
 assert(source.includes(swarm.commit) && source.includes('(MIT)'), `Missing Swarm attribution: ${file.target}`);
}
console.log(`React Swarm Rebuild ${swarm.commit}: ${swarm.files.length} pinned originals, ${swarm.derivatives.length} attributed derivatives verified.`);
