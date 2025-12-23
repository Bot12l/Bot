#!/usr/bin/env node
/**
 * Unit test for live_slot_probe logic using mocked heliusRpc
 */
const util = require('util');

// Minimal mocked heliusRpc that returns synthetic data
async function heliusRpc(method, params){
  if(method === 'getSignaturesForAddress'){
    const mint = params[0];
    return [ { signature: 'SIG1', slot: 1000, blockTime: 1234567 } ];
  }
  if(method === 'getBlock'){
    const slot = params[0];
    return { transactions: [ {
      transaction: { signatures: ['SIG1'], message: { accountKeys: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] } },
      meta: { logMessages: ['instruction: initializemint','some other log'] }
    } ] };
  }
  if(method === 'getTransaction'){
    const sig = params[0];
    return { transaction: { message: { accountKeys: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] } }, meta: { logMessages: ['initialize mint'] } };
  }
  return null;
}

function snippet(logs, n){ if(!Array.isArray(logs)) return ''; return logs.slice(0,n).join('\n').slice(0,800); }

function matchCreateAuthPool(logsLower){
  const hasCreate = /create/.test(logsLower) || /create account/.test(logsLower) || /createidempotent/.test(logsLower) || /initializemint/.test(logsLower);
  const hasAuthority = /authority/.test(logsLower) || /setauthority/.test(logsLower) || /set authority/.test(logsLower);
  const mentionsPool = /pool/.test(logsLower) || /initialize pool/.test(logsLower) || /createpool/.test(logsLower);
  return { hasCreate, hasAuthority, mentionsPool };
}

function matchPoolInit(logsLower){ const init = /initialize pool/.test(logsLower) || /pool initialized/.test(logsLower) || /pool_creation/.test(logsLower) || /init_pool/.test(logsLower) || /createpool/.test(logsLower) || /initialize_pool/.test(logsLower); return { init }; }

async function scanBlock(slot){
  const b = await heliusRpc('getBlock', [slot]);
  if(!b || !b.transactions) return [];
  const found = [];
  for(const tx of b.transactions){
    const meta = tx.meta || tx.transaction && tx.transaction.meta || {};
    const logs = meta.logMessages || tx.meta && tx.meta.logMessages || tx.logMessages || [];
    const logsLower = Array.isArray(logs) ? logs.join('\n').toLowerCase() : '';
    const createAuth = matchCreateAuthPool(logsLower);
    const poolInit = matchPoolInit(logsLower);
    found.push({ slot, signature: (tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0]) || (tx.signature||null), logs: snippet(logs,6), createAuth, poolInit });
  }
  return found;
}

async function analyzeMint(mint){
  const res = { mint, firstSignature: null, firstSlot: null, slotScans: [], sequenceDetected: false };
  const sigs = await heliusRpc('getSignaturesForAddress', [mint, { limit: 4 }]);
  res.signatures = sigs;
  if(Array.isArray(sigs) && sigs.length>0){ const s0 = sigs[0]; res.firstSignature = s0.signature || s0.sig || s0.txHash || null; res.firstSlot = s0.slot || null; }
  const windowSlots = 3;
  const baseSlot = Number(res.firstSlot || 0);
  for(let slot = baseSlot - windowSlots; slot <= baseSlot + windowSlots; slot++){
    if(!slot || slot <= 0) continue;
    try{ const entries = await scanBlock(slot); res.slotScans.push({ slot, entries }); }catch(e){ res.slotScans.push({ slot, error: String(e) }); }
  }
  for(const sEntry of res.slotScans){ const slot = sEntry.slot; const curr = sEntry.entries || []; const prev = res.slotScans.find(x=>x.slot === slot-1); const prevOK = prev && Array.isArray(prev.entries) && prev.entries.some(p => p.createAuth && p.createAuth.hasCreate && p.createAuth.hasAuthority && p.createAuth.mentionsPool); const currOK = curr && curr.some(c => c.poolInit && c.poolInit.init); if(prevOK && currOK){ res.sequenceDetected = true; res.matched = { prevSlot: slot-1, initSlot: slot, prevEvidence: prev.entries.filter(p=>p.createAuth && p.createAuth.hasCreate), initEvidence: curr.filter(c=>c.poolInit && c.poolInit.init) }; break; }
  }
  return res;
}

(async ()=>{
  try{
    const mint = 'FAKE_MINT';
    const r = await analyzeMint(mint);
    console.log('analyzeMint result:', util.inspect(r, { depth: 4 }));
    process.exit(0);
  }catch(e){ console.error('test error', e && e.stack || e); process.exit(1); }
})();
