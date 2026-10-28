import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReport} from './report.mjs';
const report={summary:'Inventario',findings:[{name:'Node.js',category:'runtime',source:'detect_tools',evidence:'versión local',limitations:[]}],limitations:[]};
test('requires observed names and recognized sources',()=>{
 const observations=new Map([['detect_tools',[{name:'Node.js',version:'24.18.0'}]]]);
 assert.equal(validateReport(report,observations).findings.length,1);
 assert.throws(()=>validateReport(report,new Map()));
 assert.throws(()=>validateReport({...report,findings:[{...report.findings[0],name:'Inventado'}]},observations));
 assert.throws(()=>validateReport({...report,limitations:[42]},observations));
});
