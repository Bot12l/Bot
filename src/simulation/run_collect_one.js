#!/usr/bin/env node
require('dotenv').config();
const sniper = require('../../sniper.js');

async function main(){
  console.error('>> RUN: collectFreshMints maxCollect=1 timeoutMs=60000');
  try{
    const collected = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 60000 });
    if(!collected || collected.length===0){
      console.error('No fresh mints found within timeout');
      process.exit(2);
    }
    console.error('>> Collected full token object:');
    console.log(JSON.stringify(collected[0], null, 2));
    process.exit(0);
  }catch(e){
    console.error('collectFreshMints failed', e && (e.stack||e));
    process.exit(1);
  }
}

if(require.main === module) main();
