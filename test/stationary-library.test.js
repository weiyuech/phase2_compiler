import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StationaryLibrary } from '../src/task/stationary-library.js'
function setup(t) { const dir=mkdtempSync(join(tmpdir(),'stationary-library-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return {dir,lib:new StationaryLibrary(join(dir,'library'))} }
test('rename and restart preserve recording ownership and original bytes; other groups and profiles cannot select it',t=>{
 const {dir,lib}=setup(t); const a=lib.snapshot().groups[0], b=lib.createGroup('定点2'); const file=join(dir,'round.mp3'); const bytes=Buffer.from('whole-round-test-bytes'); writeFileSync(file,bytes);
 lib.updateGroup(a.id,{text:'第一句。第二句。'}); const rec=lib.addRecording(a.id,{file,text:'第一句。第二句。',iteration:1});
 lib.updateGroup(a.id,{name:'试吃区'}); const reopened=new StationaryLibrary(lib.directory); const saved=reopened.snapshot().groups.find(g=>g.id===a.id);
 assert.equal(saved.name,'试吃区'); assert.equal(saved.text,'第一句。第二句。'); assert.equal(saved.recordings.length,1); assert.deepEqual(readFileSync(reopened.recordingPath(a.id,rec.id)),bytes);
 assert.throws(()=>reopened.playlist(b.id,[rec.id])); assert.throws(()=>reopened.recordingPath(a.id,'../../secret'));
 const other=new StationaryLibrary(join(dir,'machine2')); other.snapshot(); assert.throws(()=>other.recordingPath(a.id,rec.id));
 assert.equal(reopened.playlist(a.id,[rec.id])[0].id,rec.id);
});
test('twelfth group succeeds, thirteenth fails without damaging persisted groups',t=>{
 const {lib}=setup(t); lib.snapshot(); for(let i=2;i<=12;i++)lib.createGroup('定点'+i); assert.throws(()=>lib.createGroup('定点13'),/12/); assert.equal(new StationaryLibrary(lib.directory).snapshot().groups.length,12);
});
test('corrupt index is reported and never silently replaced with an empty library',t=>{
 const {lib}=setup(t);lib.snapshot();writeFileSync(lib.index,'{broken');assert.throws(()=>lib.snapshot());assert.equal(readFileSync(lib.index,'utf8'),'{broken');
});
test('playback preferences persist per group and cannot reference another group recording',t=>{
 const {dir,lib}=setup(t), a=lib.snapshot().groups[0],b=lib.createGroup('定点2'); const f=join(dir,'a.mp3');writeFileSync(f,'audio');const rec=lib.addRecording(a.id,{file:f,text:'a',iteration:1});
 lib.updateGroup(a.id,{mode:'mp3',shuffle:true,loop:true,recordingIds:[rec.id]});
 const fresh=new StationaryLibrary(lib.directory).snapshot().groups;
 assert.equal(fresh[0].mode,'mp3');assert.equal(fresh[0].shuffle,true);assert.deepEqual(fresh[0].recordingIds,[rec.id]);assert.equal(fresh[1].mode,'tts');
 assert.throws(()=>lib.updateGroup(b.id,{recordingIds:[rec.id]}));
});
