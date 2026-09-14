import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {serialWorker} from './arduino-worker.mjs';
const device=serialWorker();
const checks=[];
const pass=s=>{checks.push(s);console.log('PASS '+s)};
try {
 await delay(1500);
 const wifi=await device.call('wifi');
 await device.call('configure',{namespace:'esp32-offline-acceptance',server:'nats://127.0.0.1:4222'});
 const initial=await device.call('status');
 assert.equal((await device.call('get')).exists,false);
 pass('Fresh Hub has no variable');
 for(const value of [null,false,0,1.2345678901234567,5e-324,1e-7,{'a\u0000b':['汉字😀',null,1.2345678901234567]}]) {
   assert.equal(await device.call('set',{value}),true);
   const got=await device.call('get');assert.equal(got.exists,true);assert.deepEqual(got.value,value);
 }
 pass('Offline JSON, null, Unicode, embedded NUL key and exact binary64');
 assert.equal(await device.call('delete'),true);assert.equal((await device.call('get')).exists,false);
 pass('Deletion differs from present null');
 const before=await device.call('status');
 for(let value=0;value<500;value++) assert.equal(await device.call('set',{value}),true);
 assert.equal((await device.call('get')).value,499);
 const after=await device.call('status');
 assert.equal(after.pendingVariables,1);
 assert.equal(after.variables,1);
 pass('500 overwrites retain one current record and pending value');
 await assert.rejects(device.call('flush',{timeoutMs:50}));
 pass('Offline flush does not falsely succeed');
 const handles=await device.call('handles');
 assert.deepEqual(handles,{initialSet:true,expiredExists:false,expiredSet:false,expiredCopySet:false,callbackInvoked:true,callbackClosed:true});
 pass('Expired handles stay safe and callback can close Hub');
 await device.call('configure',{namespace:'esp32-budget',server:'nats://127.0.0.1:4222',maxMemoryBytes:8192});
 let stored=0;
 for(let index=0;index<128;index++) {
  if(!await device.call('set',{name:'budget-'+index,value:Array(40).fill(index)})) break;
  stored++;
 }
 assert.ok(stored>0 && stored<128);
 assert.deepEqual((await device.call('get',{name:'budget-0'})).value,Array(40).fill(0));
 const limited=await device.call('status');
 assert.ok(limited.resources.freeHeap>32768);
 pass('Actual JSON allocation budget rejects growth while preserving prior values');
 await device.call('reboot');await delay(3500);
 await device.call('configure',{namespace:'esp32-offline-acceptance',server:'nats://127.0.0.1:4222'});
 assert.equal((await device.call('get')).exists,false);
 assert.notEqual((await device.call('status')).instanceId,initial.instanceId);
 pass('Physical restart clears RAM and rotates instance identity');
 const report={date:new Date().toISOString(),wifi,checks,before,after,budget:{stored,status:limited}};
 if (process.env.KINOPIO_REPORT_FILE) writeFileSync(process.env.KINOPIO_REPORT_FILE, JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
} finally {device.close()}
