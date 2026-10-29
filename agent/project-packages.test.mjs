import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProjectPackages} from './project-packages.mjs';
const input={name:'sample',path:'/selected',manifest:{dependencies:{alpha:'^1.0.0'},devDependencies:{beta:'~2.0.0'}},lock:{lockfileVersion:3,packages:{'':{dependencies:{alpha:'^1.0.0'},devDependencies:{beta:'~2.0.0'}},'node_modules/alpha':{version:'1.2.0'},'node_modules/beta':{version:'2.0.4'}}},lockfile:'package-lock.json',warnings:[]};
const rows=[{name:'alpha',kind:'production',declared:'^1.0.0',resolved:'1.2.0'},{name:'beta',kind:'development',declared:'~2.0.0',resolved:'2.0.4'}];
test('agent output keeps the existing project table contract and exact evidence',()=>{
 const out=validateProjectPackages({dependencies:rows,name:'invented',path:'/elsewhere'},input);
 assert.equal(out.name,'sample');assert.equal(out.path,'/selected');assert.deepEqual(out.dependencies,rows);
 assert.throws(()=>validateProjectPackages({dependencies:rows.slice(1)},input));
 assert.throws(()=>validateProjectPackages({dependencies:[rows[0],rows[0]]},input));
 assert.throws(()=>validateProjectPackages({dependencies:[{...rows[0],resolved:'99.0.0'},rows[1]]},input));
 assert.throws(()=>validateProjectPackages({dependencies:[{...rows[0],name:'unknown'},rows[1]]},input));
});
test('missing, stale and linked lock entries never invent a resolved version',()=>{
 const missing={...input,lock:null,lockfile:null};
 assert.ok(validateProjectPackages({dependencies:rows.map(r=>({...r,resolved:null}))},missing).dependencies.every(r=>r.resolved===null));
 const stale=structuredClone(input);stale.lock.packages[''].dependencies.alpha='^4.0.0';stale.lock.packages['node_modules/beta'].link=true;
 const out=validateProjectPackages({dependencies:rows.map(r=>({...r,resolved:null}))},stale);
 assert.ok(out.warnings.length);assert.ok(out.dependencies.every(r=>r.resolved===null));
 assert.throws(()=>validateProjectPackages({dependencies:rows},stale));
});
