#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENRICHED = path.join(__dirname, 'enriched_collected.json');
const OUT_JSON = path.join(__dirname, 'slot_sequence_report.json');
const OUT_MD = path.join(__dirname, 'slot_sequence_report.md');

const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
if(HELIUS_RPC_URLS.length===0) HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/');
let callIdx = 0;

async function heliusRpc(method, params){
  const url = HELIUS_RPC_URLS[callIdx % HELIUS_RPC_URLS.length];
  const headers = Object.assign({'Content-Type':'application/json'}, HELIUS_KEYS[callIdx % Math.max(1, HELIUS_KEYS.length)] ? { 'x-api-key': HELIUS_KEYS[callIdx % Math.max(1, HELIUS_KEYS.length)] } : {});
  callIdx = (callIdx + 1) >>> 0;
  try{
    const r = await axios.post(url, { jsonrpc:'2.0', id:1, method, params }, { headers, timeout: 12000 });
    return r.data && (r.data.result || r.data);
  }catch(e){ return { __error: e && e.message ? e.message : String(e) } }
}

function snippet(logs, n){
  if(!Array.isArray(logs)) return '';
  return logs.slice(0, n).join('\n').slice(0, 800);
}

function matchCreateAuthPool(logsLower){
  const hasCreate = /create/.test(logsLower) || /create account/.test(logsLower) || /createidempotent/.test(logsLower) || /createmint/.test(logsLower) || /initializemint/.test(logsLower);
  const hasAuthority = /authority/.test(logsLower) || /setauthority/.test(logsLower) || /set authority/.test(logsLower);
  const mentionsPool = /pool/.test(logsLower) || /initialize pool/.test(logsLower) || /initialize_pool/.test(logsLower) || /createpool/.test(logsLower);
  return { hasCreate, hasAuthority, mentionsPool };
}

function matchPoolInit(logsLower){
  const init = /initialize pool/.test(logsLower) || /initialize_pool/.test(logsLower) || /pool initialized/.test(logsLower) || /pool_creation/.test(logsLower) || /init_pool/.test(logsLower) || /createpool/.test(logsLower) || /add_liquidity/.test(logsLower);
  const swap = /swap/.test(logsLower) || /jupiter/.test(logsLower) || /raydium/.test(logsLower);
  return { init, swap };
}

async function analyzeMint(mobj){
  const mint = mobj.mint || mobj;
  const out = { mint, signatures: mobj.signatures || [], evidence: [], sequenceDetected: false };
  // collect parsed tx for signatures
  for(const s of out.signatures.slice(0,8)){
    try{
      const sig = s.signature || s.sig || s.txHash;
      if(!sig) continue;
      const parsed = await heliusRpc('getParsedTransaction', [sig, 'jsonParsed']);
      const slot = s.slot || (parsed && parsed.slot) || null;
      const logs = parsed && parsed.meta && parsed.meta.logMessages ? parsed.meta.logMessages : (parsed && parsed.logMessages) || [];
      const logsLower = Array.isArray(logs) ? logs.join('\n').toLowerCase() : '';
      const createAuth = matchCreateAuthPool(logsLower);
      const poolInit = matchPoolInit(logsLower);
      out.evidence.push({ signature: sig, slot, createAuth, poolInit, logs: snippet(logs, 8) });
    }catch(e){ out.evidence.push({ signature: (s.signature||s.sig||s.txHash||null), error: e && (e.message||String(e)) }); }
  }

  // Build slot map
  const slotMap = new Map();
  for(const ev of out.evidence){
    if(!ev.slot) continue;
    if(!slotMap.has(ev.slot)) slotMap.set(ev.slot, []);
    slotMap.get(ev.slot).push(ev);
  }
  const slots = Array.from(slotMap.keys()).map(Number).sort((a,b)=>a-b);
  for(const s of slots){
    const sStr = String(s);
    const curr = slotMap.get(s);
    const prev = slotMap.get(s-1) || [];
    // Look for prev having create+authority+poolAccount mention and curr having pool initialization
    const prevOK = prev.some(p=> p.createAuth && p.createAuth.hasCreate && p.createAuth.hasAuthority && p.createAuth.mentionsPool);
    const currOK = curr.some(c=> c.poolInit && c.poolInit.init);
    if(prevOK && currOK){
      out.sequenceDetected = true;
      out.matched = { prevSlot: s-1, initSlot: s, prevEvidence: prev.filter(p=>p.createAuth && p.createAuth.hasCreate), initEvidence: curr.filter(c=>c.poolInit && c.poolInit.init) };
      break;
    }
  }
  return out;
}

async function main(){
  let list = null;
  if(fs.existsSync(ENRICHED)){
    try{ list = JSON.parse(fs.readFileSync(ENRICHED,'utf8')); }catch(e){ list = null; }
  }
  if(!list){
    const argv = process.argv.slice(2);
    if(argv.length===0){ console.error('No enriched file and no mints provided.'); process.exit(2); }
    list = argv.map(m=>({ mint: m }));
  }
  const results = [];
  for(const m of list){
    const r = await analyzeMint(m).catch(e=>({ mint: m.mint||m, error: String(e) }));
    results.push(r);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');

  // generate simple markdown report
  const lines = ['# Slot N-1 -> N Sequence Report', '', `Generated: ${new Date().toISOString()}`, ''];
  for(const r of results){
    lines.push(`## Mint: ${r.mint}`);
    lines.push('');
    if(r.sequenceDetected){
      lines.push('- **Sequence detected:** Yes');
      lines.push(`- **Prev slot:** ${r.matched.prevSlot} — evidence samples:`);
      for(const e of r.matched.prevEvidence.slice(0,3)) lines.push(`  - slot ${e.slot} sig ${e.signature} logs: \n\n    ${e.logs.replace(/\n/g,'\n    ')}\n`);
      lines.push(`- **Init slot:** ${r.matched.initSlot} — evidence samples:`);
      for(const e of r.matched.initEvidence.slice(0,3)) lines.push(`  - slot ${e.slot} sig ${e.signature} logs: \n\n    ${e.logs.replace(/\n/g,'\n    ')}\n`);
      lines.push('- **Recommendation:** High-confidence pool initialization observed → consider `allow` for simulated trigger (subject to liquidity checks).');
    }else{
      lines.push('- **Sequence detected:** No');
      lines.push('- **Evidence:**');
      for(const ev of (r.evidence||[]).slice(0,6)){
        lines.push(`  - slot:${ev.slot||'n/a'} sig:${ev.signature||'n/a'} create:${ev.createAuth?ev.createAuth.hasCreate:false} auth:${ev.createAuth?ev.createAuth.hasAuthority:false} poolMention:${ev.createAuth?ev.createAuth.mentionsPool:false} init:${ev.poolInit?ev.poolInit.init:false}`);
      }
      lines.push('- **Recommendation:** Insufficient slot-sequence evidence; require further monitoring or direct parsed tx inspection of neighboring slots.');
    }
    lines.push('');
  }
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  console.log('Wrote', OUT_JSON, OUT_MD);
}

if(require.main === module) main().catch(e=>{ console.error('error', e && e.stack||e); process.exit(1); });
