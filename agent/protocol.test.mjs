import test from 'node:test';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
test('isolated catalog, denied method, cancel, failed analysis recovery', {timeout:30000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'devguard-pi-test-'));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./sidecar.mjs',import.meta.url))],{env:{...process.env,DEVGUARD_PI_DIR:dir},stdio:['pipe','pipe','pipe']});
 const pending=new Map();let id=0;let stderr='';child.stderr.on('data',d=>stderr+=d);
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const frame=JSON.parse(line);pending.get(frame.id)?.(frame);pending.delete(frame.id);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=String(++id);const timer=setTimeout(()=>reject(Error('Protocol timeout')),15000);pending.set(key,f=>{clearTimeout(timer);resolve(f);});child.stdin.write(JSON.stringify({id:key,method,params})+'\n');});
 try{
  const c=await call('catalog');assert.ok(c.result.providers.length);assert.ok(c.result.models.length);assert.deepEqual(c.result.skills.map(s=>s.id).sort(),['packages','tools']);assert.ok(c.result.providers.every(p=>!p.authenticated));
  for (const id of ['tools','packages','project-packages']) {
   const preview=await call('skill_read',{id});assert.equal(preview.result.id,id);assert.ok(preview.result.instructions.includes('---'));
  }
  assert.ok((await call('skill_read',{id:'../../auth.json'})).error);
  assert.ok((await call('skill_write',{id:'tools',text:'changed'})).error);
  assert.ok((await call('exec',{command:'anything'})).error);
  assert.equal((await call('cancel')).result.cancelled,true);
  assert.ok((await call('analyze',{provider:'invalid',model:'invalid',skills:['tools']})).error);
  assert.ok((await call('auth_check',{provider:'invalid',model:'invalid'})).error);
  await call('auth_set',{provider:'openai',apiKey:'test-local-only-not-a-real-key'});
  const saved=(await call('catalog')).result.providers.find(p=>p.id==='openai');
  assert.equal(saved.authenticated,true);assert.equal(saved.credentialType,'api_key');
  await call('auth_logout',{provider:'openai'});
  assert.equal((await call('catalog')).result.providers.find(p=>p.id==='openai').authenticated,false);
  assert.equal(stderr,'');
 }finally{child.stdin.end();child.kill();await rm(dir,{recursive:true,force:true});}
});
