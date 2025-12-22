#!/usr/bin/env node
/**
 * Runner: starts sniper listener in-process, hooks ProgramMonitor, runs 60s, prints report
 */
const { ProgramMonitor } = require('./program_monitor');
const sniper = require('../../sniper.js');

async function main(){
  console.error('>> Starting in-process listener + program monitor (60s)');
  const monitor = new ProgramMonitor({ windowMs: 30000, maxHistory: 12 });
  monitor.on('prediction', p => {
    try{ console.error('[PREDICTION]', JSON.stringify(p)); }catch(e){}
  });

  // Start the listener (non-blocking)
  try{
    sniper.startSequentialListener().catch(e=>{ console.error('listener error', e); });
  }catch(e){ console.error('startSequentialListener threw', e); }

  // run for 60s then SIGINT
  await new Promise(r=> setTimeout(r, 60_000));
  console.error('>> 60s elapsed, sending SIGINT to stop listener');
  try{ process.kill(process.pid, 'SIGINT'); }catch(e){}
  // wait a short while for clean shutdown
  await new Promise(r=> setTimeout(r, 1200));

  // print final summary
  try{
    const summary = monitor.summary();
    console.error('>> Monitor summary:', JSON.stringify(summary, null, 2));
  }catch(e){ console.error('summary error', e); }
  process.exit(0);
}

if(require.main === module) main().catch(e=>{ console.error('runner failed', e); process.exit(1); });
