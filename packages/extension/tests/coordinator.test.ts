import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundJobManager, createBackgroundWorkStore } from '../src/job-manager.ts';
import { CompletionDelivery, formatCompletionBatch } from '../src/completion-delivery.ts';
import { detectShortcutConflict, parseBackgroundWorkConfig } from '../src/config.ts';
import { BACKGROUND_WORK_PROTOCOL_VERSION, type BackgroundJobCompletion, type DetachableExecution } from '@davecodes/pi-background-work-sdk';

const tick=()=>new Promise<void>(r=>setImmediate(r));
function fake(id='bg-1') {
 let phase='foreground', resolve!:(v:BackgroundJobCompletion)=>void, cancels=0;
 const completion=new Promise<BackgroundJobCompletion>(r=>resolve=r);
 const execution:DetachableExecution={protocolVersion:BACKGROUND_WORK_PROTOCOL_VERSION,jobId:id,adapterInstanceId:'a1',sessionId:'s1',toolCallId:'t1',toolName:'bash',kind:'shell',label:'sleep',startedAt:10,mutationRisk:'unknown',promote(){if(phase!=='foreground')return{promoted:false,jobId:id};phase='promoted';return{promoted:true,jobId:id}},cancel(){cancels++},inspect(){return{jobId:id,sessionId:'s1',toolCallId:'t1',toolName:'bash',kind:'shell',label:'sleep',startedAt:10,state:phase==='promoted'?'background-running':'foreground-running',mutationRisk:'unknown'}},completion};
 return {execution,finish(status:BackgroundJobCompletion['status']='succeeded'){phase='completed';resolve({jobId:id,status,finishedAt:20,durationMs:10,summary:'done',output:'ok'})},get cancels(){return cancels}};
}

test('natural completion is invisible; promoted completion delivered once',async()=>{const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s);m.setSession({sessionId:'s1'});const a=fake();assert.equal(m.register(a.execution).accepted,true);a.finish();await tick();assert.equal(m.allSnapshots().length,0);assert.equal(s.pendingDeliveries.length,0);const b=fake('bg-2');m.register(b.execution);assert.equal(m.promoteAll().length,1);assert.equal(m.promoteAll().length,0);b.finish();await tick();assert.equal(s.pendingDeliveries.length,1);assert.equal(s.transitions.length,2);m.markQueued(['bg-2']);assert.equal(m.retryQueued('bg-2'),true);m.markQueued(['bg-2']);m.markDelivered(['bg-2']);assert.equal(s.pendingDeliveries.length,0)});
test('rejects cross-session and duplicate owners',()=>{const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s);m.setSession({sessionId:'s1'});const a=fake();m.register(a.execution);assert.equal(m.register({...fake().execution,adapterInstanceId:'a2'}).accepted,false);assert.equal(m.register({...fake('x').execution,sessionId:'s2'}).accepted,false)});
test('shutdown cancellation includes foreground without completion delivery',async()=>{const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s);m.setSession({sessionId:'s1'});const a=fake();m.register(a.execution);const cancelled=m.cancelAll(true);a.finish('cancelled');await cancelled;assert.equal(a.cancels,1);await tick();assert.equal(s.pendingDeliveries.length,0)});
test('config bounds and explicit keybinding overrides',()=>{assert.equal(parseBackgroundWorkConfig({}).enabled,true);assert.equal(parseBackgroundWorkConfig({}).bashTool,'wrap');assert.equal(parseBackgroundWorkConfig({}).subagents,true);assert.equal(parseBackgroundWorkConfig({bashTool:'off',subagents:false}).bashTool,'off');assert.equal(parseBackgroundWorkConfig({subagents:false}).subagents,false);assert.equal(parseBackgroundWorkConfig({}).statusIndicator,true);assert.equal(parseBackgroundWorkConfig({statusIndicator:false}).statusIndicator,false);assert.equal(parseBackgroundWorkConfig({maxOutputLines:-1}).maxOutputLines,2000);assert.equal(parseBackgroundWorkConfig({}).promotionYield,'interrupt');assert.equal(parseBackgroundWorkConfig({promotionYield:'steer'}).promotionYield,'steer');assert.equal(parseBackgroundWorkConfig({promotionYield:'off'}).promotionYield,'off');assert.equal(parseBackgroundWorkConfig({promotionYield:'junk'}).promotionYield,'interrupt');const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-'));const p=path.join(d,'keys.json');fs.writeFileSync(p,JSON.stringify({'tui.editor.cursorLeft':['left']}));assert.equal(detectShortcutConflict('ctrl+b',p),undefined);fs.writeFileSync(p,JSON.stringify({foo:['ctrl+shift+b']}));assert.equal(detectShortcutConflict('ctrl+shift+b',p),'foo')});
test('completion batching is bounded and delivery is exactly once',()=>{const sent:any[]=[];const store={pendingDeliveries:[{jobId:'x',status:'succeeded' as const,finishedAt:2,durationMs:1,summary:'done',output:'a\n'.repeat(100)}],delivered:new Set<string>(),queued:new Set<string>()};const d=new CompletionDelivery({sendMessage:(m,o)=>sent.push([m,o])},store,{debounceMs:0,maxOutputBytes:1024,maxOutputLines:10,completionBehavior:'notify-and-resume',onQueued:ids=>ids.forEach((id:string)=>store.queued.add(id)),onError:e=>{throw e}});d.flush();d.flush();assert.equal(sent.length,1);assert.equal(sent[0][1].deliverAs,'followUp');assert.equal(sent[0][1].triggerTurn,true);assert.ok(formatCompletionBatch(store.pendingDeliveries,{maxOutputBytes:1024,maxOutputLines:10}).content.length<500)});

test('promotion/completion race has one winner across 500 executions',async()=>{for(let i=0;i<500;i++){const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s);m.setSession({sessionId:'s1'});const a=fake(`r-${i}`);m.register(a.execution);if(i%2===0){a.finish();await tick();assert.equal(m.promoteAll().length,0);assert.equal(s.pendingDeliveries.length,0)}else{assert.equal(m.promoteAll().length,1);a.finish();await tick();assert.equal(s.pendingDeliveries.length,1)}}});
test('failed delivery remains pending and can be retried',()=>{let attempts=0;const errors:string[]=[];const completion={jobId:'retry',status:'succeeded' as const,finishedAt:2,durationMs:1,summary:'done'};const store={pendingDeliveries:[completion],delivered:new Set<string>(),queued:new Set<string>()};const options={debounceMs:0,maxOutputBytes:1024,maxOutputLines:10,completionBehavior:'notify-and-resume' as const,onQueued:(ids:string[])=>ids.forEach((id:string)=>store.queued.add(id)),onError:(e:Error)=>errors.push(e.message)};const failing=new CompletionDelivery({sendMessage(){attempts++;throw new Error('offline')}},store,options);failing.flush();assert.equal(store.delivered.size,0);assert.equal(errors[0],'offline');const retry=new CompletionDelivery({sendMessage(){attempts++}},store,options);retry.flush();assert.equal(store.queued.has('retry'),true);assert.equal(attempts,2)});

test('multi-job completion batch bounds total bytes, lines, and metadata',()=>{
 const completions=Array.from({length:6},(_,i)=>({jobId:`job-${i}-${'x'.repeat(200)}`,status:'failed' as const,finishedAt:2,durationMs:1,summary:'s'.repeat(2000),error:'e'.repeat(2000),artifactPath:`/tmp/${'p'.repeat(2000)}`,output:`line-${i}\n`.repeat(100)}));
 const formatted=formatCompletionBatch(completions,{maxOutputBytes:2048,maxOutputLines:12,role:'advisor',groupId:'m'.repeat(1000)});
 assert.ok(Buffer.byteLength(formatted.content)<=2048);
 assert.ok(formatted.content.split('\n').length<=12);
 assert.ok(formatted.jobIds.length>1);
 for(const detail of formatted.details){assert.ok(Buffer.byteLength(detail.jobId)<=80);assert.ok(Buffer.byteLength(detail.summary)<=512);assert.ok(Buffer.byteLength(detail.error??'')<=512);assert.ok(Buffer.byteLength(detail.artifactPath??'')<=1024)}
});

test('same-id non-reload session start resets jobs while reload preserves them',()=>{
 const store=createBackgroundWorkStore(),manager=new BackgroundJobManager(store);manager.setSession({sessionId:'ephemeral-1'});manager.register({...fake('same').execution,sessionId:'ephemeral-1'});
 manager.setSession({sessionId:'ephemeral-1',preserveJobs:true});assert.equal(manager.allSnapshots().length,1);
 manager.setSession({sessionId:'ephemeral-1',preserveJobs:false});assert.equal(manager.allSnapshots().length,0);
});

test('paused completion delivery waits for a later idle schedule',async()=>{
 const sent:any[]=[];const completion={jobId:'idle',status:'succeeded' as const,finishedAt:2,durationMs:1,summary:'done'};const store={pendingDeliveries:[completion],delivered:new Set<string>(),queued:new Set<string>()};
 const delivery=new CompletionDelivery({sendMessage:m=>sent.push(m)},store,{debounceMs:10,maxOutputBytes:1024,maxOutputLines:20,completionBehavior:'notify-and-resume',onQueued:ids=>ids.forEach((id:string)=>store.queued.add(id)),onError:e=>{throw e}});
 delivery.schedule();delivery.pause();await new Promise(r=>setTimeout(r,20));assert.equal(sent.length,0);delivery.schedule();await new Promise(r=>setTimeout(r,20));assert.equal(sent.length,1);
});


test('cancellation deadline bounds never-resolving and rejecting adapters',async()=>{
 const never=fake('never');never.execution.cancel=()=>new Promise<void>(()=>{});
 const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s,{},20);m.setSession({sessionId:'s1'});m.register(never.execution);m.promoteAll();
 const started=Date.now();const result=await m.cancelAll();assert.equal(result.failed.length,1);assert.ok(Date.now()-started<200);
 const reject=fake('reject');reject.execution.cancel=()=>Promise.reject(new Error('cancel rejected'));m.register(reject.execution);m.promoteAll();
 const rejected=await m.cancelAll();assert.match(rejected.failed[0]?.error??'',/cancel rejected/);
});

test('cancelAll runs independent cancellation deadlines concurrently',async()=>{
 const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s,{},30);m.setSession({sessionId:'s1'});
 for(const id of ['one','two','three']){const item=fake(id);item.execution.cancel=()=>new Promise<void>(()=>{});m.register(item.execution)}
 m.promoteAll();const started=Date.now();const result=await m.cancelAll();assert.equal(result.failed.length,3);assert.ok(Date.now()-started<100);
});

test('advisor registration rejects group mismatch and accepted identity governs settlement',async()=>{
 const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s);m.setSession({sessionId:'s1',groupId:'mission-a',role:'advisor'});
 const wrong=fake('wrong');wrong.execution.groupId='mission-b';assert.equal(m.register(wrong.execution).accepted,false);
 const right=fake('right');right.execution.groupId='mission-a';assert.equal(m.register(right.execution).accepted,true);m.promoteAll();right.execution.groupId='mission-b';right.finish();await tick();assert.equal(s.pendingDeliveries.length,1);
});

test('live inspection refreshes diagnostics without allowing identity or state override',()=>{
 const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s);m.setSession({sessionId:'s1'});const item=fake('live');m.register(item.execution);m.promoteAll();
 item.execution.inspect=()=>({...item.execution.inspect(),jobId:'evil',sessionId:'evil',state:'succeeded',latestOutput:'new output'} as any);
 // Replace recursive test closure with a direct live snapshot.
 item.execution.inspect=()=>({jobId:'evil',sessionId:'evil',toolCallId:'evil',toolName:'evil',kind:'shell',label:'evil',startedAt:0,state:'succeeded',mutationRisk:'read-only',latestOutput:'new output'} as any);
 const snapshot=m.allSnapshots()[0]!;assert.equal(snapshot.jobId,'live');assert.equal(snapshot.state,'background-running');assert.equal(snapshot.latestOutput,'new output');
});

test('effective keybinding conflicts include TUI and app defaults with explicit override support',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keys-'));const keys=path.join(dir,'keybindings.json');
 for(const key of ['ctrl+a','ctrl+b','ctrl+c','ctrl+f'])assert.ok(detectShortcutConflict(key,keys));
 fs.writeFileSync(keys,JSON.stringify({'tui.editor.cursorLeft':['left'],'tui.editor.cursorLineStart':['home'],'tui.input.copy':[],'app.clear':[]}));
 assert.equal(detectShortcutConflict('ctrl+b',keys),undefined);assert.equal(detectShortcutConflict('ctrl+a',keys),undefined);
});

test('serialized custom message including details stays within configured byte cap',()=>{
 const completions=Array.from({length:200},(_,i)=>({jobId:`j-${i}-${'x'.repeat(100)}`,status:'failed' as const,finishedAt:2,durationMs:1,summary:'s'.repeat(1000),error:'e'.repeat(1000),artifactPath:'/tmp/'+ 'p'.repeat(1000),output:'o'.repeat(1000)}));
 const formatted=formatCompletionBatch(completions,{maxOutputBytes:50*1024,maxOutputLines:2000,role:'advisor',groupId:'m'});
 const message={customType:'background-work-completion',content:formatted.content,display:true,details:{version:1,role:'advisor',groupId:'m',completions:formatted.details}};
 assert.ok(Buffer.byteLength(JSON.stringify(message))<=50*1024);
});

test('malformed adapter callbacks and completion identity are contained',async()=>{
 const store=createBackgroundWorkStore(),manager=new BackgroundJobManager(store);manager.setSession({sessionId:'s1'});
 const inspectBomb=fake('inspect-bomb');inspectBomb.execution.inspect=()=>{throw new Error('inspect bomb')};assert.equal(manager.register(inspectBomb.execution).accepted,false);
 const getterBomb=fake('getter-bomb');getterBomb.execution.inspect=()=>({get latestOutput(){throw new Error('identity getter bomb')}} as any);assert.doesNotThrow(()=>{assert.equal(manager.register(getterBomb.execution).accepted,false)});
 const unprintable=fake('unprintable-bomb');unprintable.execution.inspect=()=>{throw {toString(){throw new Error('coercion')}}};assert.doesNotThrow(()=>{assert.equal(manager.register(unprintable.execution).accepted,false)});
 const promoteBomb=fake('promote-bomb');promoteBomb.execution.promote=()=>{throw new Error('promote bomb')};assert.equal(manager.register(promoteBomb.execution).accepted,true);assert.doesNotThrow(()=>manager.promoteAll());
 const forged=fake('real-id');manager.register(forged.execution);manager.promoteAll();forged.execution.inspect=()=>({jobId:'forged',sessionId:'evil'} as any);(forged as any).finish();
 // Resolve through a forged completion object by replacing the helper's completion resolver path is covered by direct adapter construction below.
 const completionDone:{resolve?:(value:any)=>void}={};const completion=new Promise<any>(resolve=>completionDone.resolve=resolve);const directBase=fake('direct').execution;let directPromoted=false;const direct:any={...directBase,jobId:'authoritative',toolCallId:'authoritative-tool',completion,promote(){directPromoted=true;return{promoted:true,jobId:'authoritative'}},inspect(){return{jobId:'authoritative',sessionId:'s1',toolCallId:'authoritative-tool',toolName:'bash',kind:'shell',label:'direct',startedAt:1,state:directPromoted?'background-running':'foreground-running',mutationRisk:'unknown'}}};manager.register(direct);manager.promoteAll();completionDone.resolve!({jobId:'forged',status:'succeeded',finishedAt:2,durationMs:1,summary:'ok',output:{unsafe:true}});await tick();
 assert.ok(store.pendingDeliveries.some(item=>item.jobId==='authoritative'));assert.ok(!store.pendingDeliveries.some(item=>item.jobId==='forged'));
});

test('delivery formatting failures are reported instead of escaping flush',()=>{
 const errors:string[]=[];const store={pendingDeliveries:[{jobId:'x',status:'succeeded' as const,finishedAt:2,durationMs:1,summary:'done',output:'ok'}],delivered:new Set<string>(),queued:new Set<string>()};
 const delivery=new CompletionDelivery({sendMessage(){throw new Error('send failure')}},store,{debounceMs:0,maxOutputBytes:1024,maxOutputLines:10,completionBehavior:'notify-and-resume',onQueued(){},onError:error=>errors.push(error.message)});assert.doesNotThrow(()=>delivery.flush());assert.deepEqual(errors,['send failure']);
});

test('registered identity remains authoritative after hostile adapter mutation',async()=>{
 const store=createBackgroundWorkStore(),manager=new BackgroundJobManager(store);manager.setSession({sessionId:'s1'});
 const item=fake('authoritative');assert.equal(manager.register(item.execution).accepted,true);assert.equal(manager.promoteAll().length,1);
 Object.assign(item.execution,{jobId:'forged',sessionId:'forged',groupId:'forged',toolCallId:'forged',adapterInstanceId:'forged'});item.finish();await tick();
 assert.equal(store.executions.size,0);assert.equal(store.snapshots.get('authoritative')?.state,'succeeded');assert.equal(store.pendingDeliveries[0]?.jobId,'authoritative');
});

test('hostile completion coercion is contained and settles failed',async()=>{
 const store=createBackgroundWorkStore(),manager=new BackgroundJobManager(store);manager.setSession({sessionId:'s1'});
 let resolve!:(value:any)=>void;const completion=new Promise<any>(done=>resolve=done);const execution:any={...fake('coercion-bomb').execution,completion};
 assert.equal(manager.register(execution).accepted,true);assert.equal(manager.promoteAll().length,1);
 resolve({jobId:'coercion-bomb',status:'succeeded',finishedAt:2,durationMs:1,summary:{toString(){throw new Error('coercion bomb')}}});await tick();
 assert.equal(store.snapshots.get('coercion-bomb')?.state,'failed');assert.equal(store.pendingDeliveries[0]?.status,'failed');assert.match(store.pendingDeliveries[0]?.error??'',/coercion bomb/);
});

test('hostile live-inspection diagnostic fields cannot poison snapshots or later rendering',()=>{
 const s=createBackgroundWorkStore(),m=new BackgroundJobManager(s);m.setSession({sessionId:'s1'});const item=fake('poison');m.register(item.execution);m.promoteAll();
 const bomb={toString(){throw new Error('render bomb')}};
 item.execution.inspect=()=>({jobId:'poison',sessionId:'s1',toolCallId:'t1',toolName:'bash',kind:'shell',label:'sleep',startedAt:10,state:'background-running',mutationRisk:'unknown',latestOutput:bomb,artifactPath:bomb,error:bomb} as any);
 const snapshot=m.allSnapshots()[0]!;
 // Non-string diagnostics are rejected; template rendering of every field stays safe.
 assert.doesNotThrow(()=>`${snapshot.latestOutput??''}${snapshot.artifactPath??''}${snapshot.error??''}`);
 assert.equal(snapshot.artifactPath,undefined);
});
