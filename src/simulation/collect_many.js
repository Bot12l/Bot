#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sniper = require('../../sniper.js');

async function main(){
  try{
    const maxCollect = Number(process.argv[2]) || 100;
    const timeoutMs = Number(process.argv[3]) || 300000; // default 5 minutes
    console.error(`Collecting up to ${maxCollect} fresh mints (timeoutMs=${timeoutMs})`);
    const collected = await sniper.collectFreshMints({ maxCollect, timeoutMs });
    if(!Array.isArray(collected)){
      console.error('Collector returned non-array:', collected);
      process.exit(2);
    }
    console.error(`Collected ${collected.length} mints`);
    const out = path.resolve('/tmp/collected_live_mints.json');
    fs.writeFileSync(out, JSON.stringify(collected, null, 2), 'utf8');
    console.error('Wrote collected mints to', out);
    process.exit(0);
  }catch(e){
    console.error('collect_many error', e && e.stack || e);
    process.exit(1);
  }
}

main();
