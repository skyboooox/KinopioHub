#!/usr/bin/env node
// Physical-host feasibility runner. Raw logs are private; this is not a confirmatory study.
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {serialWorker} from './arduino-worker.mjs';

const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('Usage: mesh-study.mjs --config FILE');
const config=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
if(!['F','S','Q'].includes(config.policy)||!Array.isArray(config.hosts)||config.hosts.length!==3)throw Error('Require policy and exactly three hosts');
const runId=`pilot-${config.policy}-${Date.now()}-${randomUUID().slice(0,8)}`;
const out=path.resolve(config.output,runId);await fs.mkdir(out,{recursive:true});
const eventLog=createWriteStream(path.join(out,'controller.jsonl'),{flags:'wx'});
const log=(type,data={})=>{eventLog.write(JSON.stringify({type,wallTime:new Date().toISOString(),wallMs:Date.now(),monoMs:performance.now(),...data})+'\n');console.log(JSON.stringify({type,...data}));};
const rows=[];let serial,fixedBroker,closing=false,commandSequence=0,instrumentationError=null;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function launch(host,remoteCommand,{input}={}){
  const sshArgs=['-o','ConnectTimeout=8','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',host.ssh,remoteCommand];
  let child;
  if(host.ssh){
    if(host.passwordEnv){const secret=process.env[host.passwordEnv];if(!secret)throw Error(`Missing ${host.passwordEnv}`);child=spawn('sshpass',['-d','3','ssh',...sshArgs],{stdio:['pipe','pipe','pipe','pipe']});child.stdio[3].end(secret+'\n');}
    else child=spawn('ssh',sshArgs,{stdio:['pipe','pipe','pipe']});
  }else child=spawn('/bin/sh',['-c',remoteCommand],{stdio:['pipe','pipe','pipe']});
  if(input!==undefined)child.stdin.end(input);
  return child;
}
async function installConfig(host,filename,value){
  const command=`umask 077; cat > ${quote(filename)}`;
  const child=launch(host,command,{input:JSON.stringify(value)});let error='';child.stderr.on('data',d=>error+=d);
  await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Write config ${host.id}: ${error}`)));});
}
function send(row,op){
  const id=++commandSequence;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{row.pending.delete(id);reject(Error(`${row.host.id} ${op} timed out`));},15000);row.pending.set(id,{resolve,reject,timer});row.child.stdin.write(JSON.stringify({id,op})+'\n');});
}
async function until(fn,label,timeout=120000){const end=performance.now()+timeout;while(performance.now()<end){if(instrumentationError)throw Error(instrumentationError);if(fn())return;const dead=rows.find(r=>r.exited);if(dead)throw Error(`${dead.host.id} worker exited before ${label}`);await delay(200);}throw Error(`${label} timed out`);}
function connected(){return rows.every(r=>r.ready&&r.status?.sdk.connection==='connected');}
function converged(){return connected()&&(config.policy==='F'||(rows.every(r=>r.status.sdk.mesh?.members===3)&&new Set(rows.map(r=>r.status.sdk.mesh.leaderId)).size===1&&rows.filter(r=>r.status.sdk.mesh.role==='leader').length===1));}
async function snapshots(){
  const replies=await Promise.all(rows.map(r=>send(r,'snapshot')));
  if(instrumentationError)throw Error(instrumentationError);
  return rows.map((r,index)=>{const snapshot=r.snapshot;
    if(snapshot?.id!==replies[index].commandId||snapshot.runId!==runId||snapshot.sourceId!==r.host.id||snapshot.values?.length!==64)throw Error('Missing or mismatched snapshot');
    return {id:r.host.id,snapshot};
  });
}
async function close(){
  if(closing)return;closing=true;
  if(serial){try{await serial.call('disconnect');}catch{}serial.close();}
  await Promise.allSettled(rows.filter(r=>!r.exited).map(r=>send(r,'close')));
  for(const row of rows){row.child.stdin.end();await Promise.race([row.ended,delay(6000)]);if(!row.exited)row.child.kill('SIGTERM');row.stream.end();row.errors.end();}
  await fixedBroker?.close();eventLog.end();
}
process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
const expectedSourceHashes={};
const localHost=config.hosts.find(h=>!h.ssh);
const localSdk=config.policy==='F'?localHost.sdkBase:localHost.sdkPolicy[config.policy];
for(const [name,file] of Object.entries({node:'src/node.mjs',meshElection:'src/mesh-election.mjs',meshNode:'src/mesh-node.mjs',meshBroker:'src/mesh-broker.mjs',hub:'src/hub.mjs',packageLock:'package-lock.json'}))expectedSourceHashes[name]=hash(await fs.readFile(path.join(localSdk,file)));
expectedSourceHashes.worker=hash(await fs.readFile(new URL('./mesh-study-worker.mjs',import.meta.url)));
const result={expectedSourceHashes,schema:'kinopio-physical-mesh-pilot/v1',runId,policy:config.policy,startedAt:new Date().toISOString(),kind:'instrumentation-pilot',checks:[],limitations:['One short run, not an independent repeated policy comparison','Background workloads and multiple subnets are not controlled','ESP32 serial reads are functional checks, not API observation latency','Resource samples exclude some management/transient costs and do not prove total-cost superiority'],configuration:config};
try{
  let servers=[];
  if(config.policy==='F'){
    const local=config.hosts.find(h=>!h.ssh);if(!local?.advertiseAddress)throw Error('F requires a local host advertiseAddress');
    const {startManagedBroker}=await import(pathToFileURL(path.join(local.sdkBase,'src/mesh-broker.mjs')));
    fixedBroker=await startManagedBroker({host:'0.0.0.0',binary:local.binary});servers=[`nats://${local.advertiseAddress}:${fixedBroker.port}`];log('fixedBroker',{pid:fixedBroker.pid,servers});
  }
  await fs.mkdir(path.join(out,'harness'));
  for(const file of ['mesh-study.mjs','mesh-study-worker.mjs','mesh-policy-adapter.mjs']){const bytes=await fs.readFile(new URL(file,import.meta.url));await fs.writeFile(path.join(out,'harness',file),bytes);(result.harnessHashes??={})[file]=hash(bytes);}
  await fs.writeFile(path.join(out,'configuration.json'),JSON.stringify({...config,runId,servers},null,2));
  for(const host of config.hosts){
    const sdkDir=config.policy==='F'?host.sdkBase:host.sdkPolicy[config.policy];
    const workerConfig={sdkPath:path.join(sdkDir,'src/node.mjs'),runId,sourceId:host.id,sourceIds:config.hosts.map(h=>h.id),policy:config.policy,namespace:runId,group:runId,meshBinary:host.binary,servers,keys:64,payloadBytes:64,rateHz:5};
    const file=path.join(host.directory,`${runId}-${host.id}.json`);await installConfig(host,file,workerConfig);
    const child=launch(host,`exec ${quote(host.node)} ${quote(host.worker)} --config ${quote(file)}`);
    const row={host,child,pending:new Map(),status:null,statusReceivedAt:0,observedSequences:new Map(),snapshot:null,exited:false,stream:createWriteStream(path.join(out,`${host.id}.jsonl`)),errors:createWriteStream(path.join(out,`${host.id}.stderr`))};
    row.ended=new Promise(resolve=>child.on('exit',(code,signal)=>{row.exited=true;row.exitCode=code;row.exitSignal=signal;log('workerExit',{host:host.id,code,signal});for(const pending of row.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Worker exited'));}row.pending.clear();resolve();}));
    child.on('error',error=>log('spawnError',{host:host.id,error:error.message}));child.stderr.pipe(row.errors);
    const lines=createInterface({input:child.stdout});lines.on('line',line=>{row.stream.write(line+'\n');let e;try{e=JSON.parse(line);}catch{return;}
      if(e.type==='ready'){row.ready=e;const p=e.runtime?.provenance;if(Object.entries(expectedSourceHashes).some(([name,expected])=>p?.files?.[name]?.sha256!==expected)||p?.meshBinary?.sha256!==host.binarySha256||e.runtime.node!=='v24.11.0')instrumentationError=`Provenance mismatch on ${host.id}`;}
      if(e.type==='status'){row.status=e;row.statusReceivedAt=performance.now();if(String(JSON.stringify(e.sdk.currentError)).includes('Unranked'))instrumentationError='Unranked policy host';}
      if(e.type==='observation')row.observedSequences.set(e.sourceId,Math.max(row.observedSequences.get(e.sourceId)??0,e.seq));
      if(e.type==='snapshot')row.snapshot=e;
      if(e.type==='closed')row.closedEvent=e;
      if(e.type==='error'||e.outputEventsDropped||e.outputEventsDroppedTotal){instrumentationError=`Invalid worker evidence from ${host.id}`;log('workerError',{host:host.id,event:e});}
      if(e.type==='command'&&row.pending.has(e.id)){const pending=row.pending.get(e.id);row.pending.delete(e.id);clearTimeout(pending.timer);e.ok?pending.resolve({...e.result,commandId:e.id}):pending.reject(Error(e.error?.message??'Worker command failed'));}
    });rows.push(row);
  }
  log('workersStarted',{runId,output:out});
  await until(converged,'initial three-host connection/election');result.checks.push('three-host-connectivity');log('connected',{hosts:rows.map(r=>({id:r.host.id,sdk:r.status.sdk}))});
  await Promise.all(rows.map(r=>send(r,'start')));log('writesStarted');
  if(config.serial){
    serial=serialWorker(config.serial,config.python??'python3');const wifi=await serial.call('wifi');log('espWifi',{wifi});
    await serial.call('configure',{namespace:runId,group:runId,server:config.policy==='F'&&config.espFixedAddress?`nats://${config.espFixedAddress}:${fixedBroker.port}`:servers[0]??''});
    const deadline=performance.now()+60000;let esp;
    while(performance.now()<deadline){esp=await serial.call('status');if(esp.connection==='connected')break;await delay(500);}
    log('espConnection',{status:esp});if(esp?.connection!=='connected')throw Error('ESP32 connection timed out');
    let read;const readDeadline=performance.now()+30000;
    do{read=await serial.call('get',{name:'key-00'});if(read.value?.run===runId)break;await delay(300);}while(performance.now()<readDeadline);
    log('espRead',{read});
    if(read.value?.run!==runId)throw Error('ESP32 did not obtain current desktop state');
    const probe={run:runId,source:'esp32',probe:true};if(!await serial.call('set',{name:'esp-probe',value:probe}))throw Error('ESP32 write rejected');
    await serial.call('flush');await delay(2000);await snapshots();await delay(3000);const received=await snapshots();
    log('espProbeSnapshots',{received:received.map(r=>({id:r.id,espProbe:r.snapshot.espProbe}))});
    if(!received.every(r=>r.snapshot.espProbe?.value?.run===runId))throw Error('ESP32 probe not observed by every desktop SDK');
    result.checks.push('esp32-bidirectional-all-hosts');
  }
  await delay(config.steadyMs??30000);const before=await snapshots();log('beforeFault',{status:before.map(r=>({id:r.id,sdk:r.snapshot.sdk,counters:r.snapshot.counters}))});
  if(!before.every(r=>r.snapshot.values.every(v=>v.value?.run===runId)))throw Error('Not all 64 keys reached all SDKs');result.checks.push('64-record-three-host-exchange');
  if(config.fault==='broker-kill'){
    if(config.policy==='F')throw Error('Fixed broker crash comparison requires declared F-R supervisor arm');
    const leader=rows.find(r=>r.status?.sdk.mesh.role==='leader');if(!leader)throw Error('No unique broker owner');
    const fault=await send(leader,'killBroker');log('brokerKilled',{host:leader.host.id,...fault});result.fault={host:leader.host.id,...fault};
    const afterFault=await snapshots(),faultAt=performance.now();
    const thresholds=new Map(afterFault.map(r=>[r.id,r.snapshot.counters.writeAttempts]));
    let stableSince=null,stableLeader=null;
    await until(()=>{
      const leader=rows[0].status?.sdk.mesh?.leaderId;
      const fresh=rows.every(r=>r.statusReceivedAt>faultAt&&performance.now()-r.statusReceivedAt<4000);
      const newData=rows.every(r=>config.hosts.filter(h=>h.id!==r.host.id).every(h=>(r.observedSequences.get(h.id)??0)>thresholds.get(h.id)));
      if(!fresh||!converged()||!newData||leader!==stableLeader){stableSince=null;stableLeader=leader;}
      if(fresh&&converged()&&newData){stableSince??=performance.now();return performance.now()-stableSince>=60000;}
      return false;
    },'fresh post-crash observations and 60-second stable broker',150000);
    log('reconnected',{thresholds:Object.fromEntries(thresholds)});result.checks.push('broker-only-crash-fresh-data-and-60s-stability');
    if(serial){const status=await serial.call('status'),read=await serial.call('get',{name:'key-00'});log('espAfterFault',{status,read});if(status.connection!=='connected'||read.value?.run!==runId||read.value.seq<=thresholds.get(config.hosts[0].id))throw Error('ESP32 did not observe a post-fault value');result.checks.push('esp32-post-fault-current-value');}

  }
  await Promise.all(rows.map(r=>send(r,'stop')));log('writesStopped');await delay(config.quiescentMs??20000);
  const final=await snapshots();
  const signatures=final.map(r=>JSON.stringify(r.snapshot.values.map(v=>({key:v.key,value:v.value,version:v.meta.version,exists:v.meta.exists}))));
  if(instrumentationError)throw Error(instrumentationError);
  result.finalAgreement=new Set(signatures).size===1;result.finalCounters=final.map(r=>({id:r.id,...r.snapshot.counters}));
  if(!result.finalAgreement)throw Error('Quiescent records/versions do not agree');result.checks.push('quiescent-record-version-agreement');result.outcome='passed';log('passed',{checks:result.checks});
}catch(error){result.outcome='failed';result.error=error.message;log('failed',{error:error.message});process.exitCode=1;}
finally{await close();result.finishedAt=new Date().toISOString();result.cleanup=rows.map(r=>({id:r.host.id,exited:r.exited,exitCode:r.exitCode,exitSignal:r.exitSignal,closedEvent:r.closedEvent??null}));if(instrumentationError||result.cleanup.some(r=>!r.exited||r.exitCode!==0||!r.closedEvent)){result.outcome='failed';result.error??=instrumentationError??'Worker cleanup was not verified';process.exitCode=1;}await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:path.join(out,'result.json'),outcome:result.outcome}));}
