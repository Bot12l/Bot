#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sniper = require('../../sniper.js');
const axios = require('axios');

const OUT_JSON = path.join(__dirname, 'live_slot_probe.json');
const OUT_MD = path.join(__dirname, 'live_slot_probe.md');

const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
if(HELIUS_RPC_URLS.length===0) HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/');
let callI = 0;

async function heliusRpc(method, params){
  const url = HELIUS_RPC_URLS[callI % HELIUS_RPC_URLS.length];
  const headers = Object.assign({'Content-Type':'application/json'}, HELIUS_KEYS[callI % Math.max(1, HELIUS_KEYS.length)] ? { 'x-api-key': HELIUS_KEYS[callI % Math.max(1, HELIUS_KEYS.length)] } : {});
  callI = (callI + 1) >>> 0;
  try{
    const r = await axios.post(url, { jsonrpc:'2.0', id:1, method, params }, { headers, timeout: 15000 });
    return r.data && (r.data.result || r.data);
  }catch(e){ return { __error: e && e.message ? e.message : String(e) } }
}

function snippet(logs, n){ if(!Array.isArray(logs)) return ''; return logs.slice(0,n).join('\n').slice(0,800); }

function matchCreateAuthPool(logsLower){
  const hasCreate = /create/.test(logsLower) || /create account/.test(logsLower) || /createidempotent/.test(logsLower) || /initializemint/.test(logsLower);
  const hasAuthority = /authority/.test(logsLower) || /setauthority/.test(logsLower) || /set authority/.test(logsLower);
  const mentionsPool = /pool/.test(logsLower) || /initialize pool/.test(logsLower) || /createpool/.test(logsLower);
  return { hasCreate, hasAuthority, mentionsPool };
}

function matchPoolInit(logsLower){
  const init = /initialize pool/.test(logsLower) || /pool initialized/.test(logsLower) || /pool_creation/.test(logsLower) || /init_pool/.test(logsLower) || /createpool/.test(logsLower) || /initialize_pool/.test(logsLower);
  return { init };
}

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
  try{
    const sigs = await heliusRpc('getSignaturesForAddress', [mint, { limit: 4 }]);
    res.signatures = sigs;
    if(Array.isArray(sigs) && sigs.length>0){
      const s0 = sigs[0];
      res.firstSignature = s0.signature || s0.sig || s0.txHash || null;
      res.firstSlot = s0.slot || null;
    }
  }catch(e){ res.sigError = String(e); }

  const windowSlots = Number(process.env.PROBE_WINDOW || 10);
  const baseSlot = Number(res.firstSlot || 0);
  for(let slot = baseSlot - windowSlots; slot <= baseSlot + windowSlots; slot++){
    if(!slot || slot <= 0) continue;
    try{
      const entries = await scanBlock(slot);
      // mark entries that reference known program account keys
      const knownPrograms = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s','JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4','whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'];
      for(const e of entries){
        try{
          const tx = await heliusRpc('getTransaction', [e.signature, { encoding: 'jsonParsed' }]);
          const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys ? tx.transaction.message.accountKeys : (tx && tx.meta && tx.meta.accountKeys) || [];
          const keysStr = JSON.stringify(keys).toLowerCase();
          e.referencesKnownProgram = knownPrograms.some(k => keysStr.includes(k.toLowerCase()));
        }catch(e){ e.referencesKnownProgram = false; }
      }
      res.slotScans.push({ slot, entries });
    }catch(e){ res.slotScans.push({ slot, error: String(e) }); }
  }

  // detect prev slot create+auth+poolAccount mention and current slot poolInit
  for(const sEntry of res.slotScans){
    const slot = sEntry.slot;
    const curr = sEntry.entries || [];
    const prev = res.slotScans.find(x=>x.slot === slot-1);
    const prevOK = prev && Array.isArray(prev.entries) && prev.entries.some(p => p.createAuth && p.createAuth.hasCreate && p.createAuth.hasAuthority && p.createAuth.mentionsPool);
    const currOK = curr && curr.some(c => c.poolInit && c.poolInit.init);
    if(prevOK && currOK){ res.sequenceDetected = true; res.matched = { prevSlot: slot-1, initSlot: slot, prevEvidence: prev.entries.filter(p=>p.createAuth && p.createAuth.hasCreate), initEvidence: curr.filter(c=>c.poolInit && c.poolInit.init) }; break; }
  }
  return res;
}

async function main(){
  console.error('>> Running live collectFreshMints (maxCollect=1, timeoutMs=60000)');
  let collected;
  try{ collected = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 60000 }); }catch(e){ console.error('collectFreshMints failed', e && e.stack||e); process.exit(1); }
  if(!collected || collected.length===0){ console.error('No fresh mints collected'); process.exit(2); }
  console.error('>> Collected token:', JSON.stringify(collected[0], null, 2));
  const mint = collected[0].tokenAddress || collected[0].mint || collected[0].address;
  const analysis = await analyzeMint(mint);
  fs.writeFileSync(OUT_JSON, JSON.stringify(analysis, null, 2), 'utf8');

  const lines = [`# Live Slot Probe Report`, `Generated: ${new Date().toISOString()}`, `Mint: ${mint}`, ''];
  lines.push(`First signature: ${analysis.firstSignature || 'n/a'} slot: ${analysis.firstSlot || 'n/a'}`);
  lines.push(`Sequence detected: ${analysis.sequenceDetected ? 'YES' : 'NO'}`);
  if(analysis.sequenceDetected){
    lines.push(`Prev slot: ${analysis.matched.prevSlot} init slot: ${analysis.matched.initSlot}`);
    for(const e of analysis.matched.prevEvidence.slice(0,3)) lines.push(`- Prev evidence slot ${e.slot} sig ${e.signature} logs:\n\n    ${e.logs.replace(/\n/g,'\n    ')}`);
  }
  lines.push('');
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  console.log('Wrote', OUT_JSON, OUT_MD);
}

if(require.main === module) main().catch(e=>{ console.error('live_slot_probe error', e && e.stack||e); process.exit(1); });
