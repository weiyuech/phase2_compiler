import test from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate as tick} from 'node:timers/promises'
import {StationarySpeech} from '../src/task/stationary-speech.js'
const wait=async fn=>{for(let i=0;i<100&&!fn();i++)await tick();assert.ok(fn())}
test('MP3 shuffle visits each selected whole file once per round and stop cancels without synthesizing',async()=>{
 const calls=[];const records=[{id:'a',path:'/a.mp3',title:'A'},{id:'b',path:'/b.mp3',title:'B'}];
 const library={snapshot:()=>({groups:[{id:'g',text:'text'}]}),playlist:()=>records,updateGroup:()=>{}};
 const tts={speakFile:(path,opts)=>new Promise(resolve=>{calls.push({path,resolve});opts.onAudioStart();opts.signal.addEventListener('abort',()=>resolve({aborted:true}),{once:true})})};
 const s=new StationarySpeech({tts,library,llm:{rewriteStationary(){throw Error('MP3 must not call LLM')}}});
 s.start({groupId:'g',mode:'mp3',recordingIds:['a','b'],loop:true,shuffle:true});await wait(()=>calls.length===1);calls[0].resolve({ok:true});await wait(()=>calls.length===2);assert.deepEqual(new Set(calls.map(x=>x.path)),new Set(['/a.mp3','/b.mp3']));s.stop();await s.finished;assert.equal(s.active,false);assert.equal(calls.length,2);
});
test('next rewrite and TTS preparation happen during current playback and prepared source is reused',async()=>{
 const plays=[],prepares=[];let released=0;
 const tts={prepareText:async text=>{prepares.push(text);return {text,release(){released++}}},speakPreparedText:async(source,opts)=>tts.speak(source.text,opts),speak:(text,opts)=>new Promise(resolve=>{plays.push({text,resolve});opts.onAudioStart();opts.signal.addEventListener('abort',()=>resolve({aborted:true}),{once:true})})};
 const s=new StationarySpeech({tts,llm:{rewriteStationary:async(_,{iteration})=>({text:'round'+iteration})},loopGapMs:0});s.start({text:'original',loop:true});await wait(()=>prepares.length===1);assert.equal(plays.length,1);assert.equal(prepares[0],'round2');plays[0].resolve({ok:true});await wait(()=>plays.length===2);assert.equal(plays[1].text,'round2');s.stop();await s.finished;assert.ok(released>=1);assert.equal(s.active,false);
});
