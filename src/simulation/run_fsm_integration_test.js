#!/usr/bin/env node
(async ()=>{
  try{
    const sniper = require('../../sniper.js');
    const { ProgramFSM } = require('./program_fsm_watcher');
    const p = new ProgramFSM({ programs: [] });
    p.on('state', s=>{ console.error('[FSM EVENT state]', JSON.stringify(s)); });
    p.on('trigger', t=>{ console.error('[FSM EVENT trigger]', JSON.stringify(t)); });

    let arg = process.argv[2] || null;
    let mintAddr = null;
    let tok = null;
    if(arg && arg.endsWith('.json')){
      // treat arg as path to JSON file produced by collectors; accept array or object
      try{
        const j = require('path').resolve(arg);
        const raw = require('fs').readFileSync(j,'utf8');
        const data = JSON.parse(raw);
        if(Array.isArray(data) && data.length>0){ tok = data[0]; mintAddr = tok.tokenAddress || tok.mint || tok.address; }
        else if(data && typeof data === 'object' && (data.mint || data.tokenAddress || data.address)){
          tok = data; mintAddr = data.tokenAddress || data.mint || data.address;
        }
      }catch(e){ console.error('Failed to read JSON arg', e && e.message || e); }
    }
    if(!mintAddr) {
      mintAddr = arg || null;
    }
    if(!mintAddr){
      console.error('collecting...');
      const res = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 60000 });
      console.error('collected', JSON.stringify(res, null, 2));
      if(!Array.isArray(res) || res.length === 0){ console.error('no collected'); process.exit(2); }
      tok = res[0];
      mintAddr = tok.tokenAddress || tok.mint || tok.address;
    } else {
      console.error('Using provided mint address from argv:', mintAddr);
    }
    // Ensure event contains a slot/txBlock so ledger engine can bucket the event
    let inferredSlot = null;
    try{
      inferredSlot = tok && (tok.txBlock || tok.firstBlock || (tok.raw && (tok.raw.txBlock || tok.raw.firstBlock)));
      if(!inferredSlot){
        // attempt to get a current slot from configured connection or rpcPool
        try{
          const cfg = require('../config');
          const conn = (cfg && cfg.connection) ? cfg.connection : null;
          if(conn && typeof conn.getSlot === 'function'){
            inferredSlot = await conn.getSlot();
          }
        }catch(_e){
          try{ const rpcPool = require('../utils/rpcPool'); const conn = rpcPool && rpcPool.getRpcConnection ? rpcPool.getRpcConnection({ preferPrivate: true }) : null; if(conn && typeof conn.getSlot === 'function') inferredSlot = await conn.getSlot(); }catch(__){}
        }
      }
    }catch(_e){}

    const ev = {
      time: new Date().toISOString(),
      program: tok ? (tok.sourceProgram || tok.program || null) : null,
      signature: tok ? (tok.sourceSignature || tok.signature || null) : null,
      kind: tok ? (tok.kind || 'initialize') : 'initialize',
      freshMints: [ mintAddr ],
      sampleLogs: tok ? (tok.sampleLogs || []) : [],
      txBlock: inferredSlot || null
    };
    console.error('emitting programEvent', JSON.stringify(ev));
    sniper.notifier.emit('programEvent', ev);
    // wait for async probes to run
    await new Promise(r=>setTimeout(r, 3000));
    const stateObj = p.states.get(mintAddr) || null;
    console.error('p.states entry:', JSON.stringify(stateObj, null, 2));
    console.error('ledgerMask (raw):', stateObj && stateObj.ledgerMask ? stateObj.ledgerMask : null);
    process.exit(0);
  }catch(e){ console.error('test error', e && e.stack || e); process.exit(1); }
})();
