#!/usr/bin/env node
/**
 * Check ground-truth on-chain token largest accounts for collected raw events.
 * Usage: node check_ground_truth.js [input.jsonl] [--delaySeconds=120] [--out=/tmp/ground_truth.jsonl]
 */
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const argv = require('minimist')(process.argv.slice(2));
const RAW = argv._[0] || process.env.RAW_EVENTS_FILE || '/tmp/raw_program_events.jsonl';
const DELAY_SECONDS = Number(argv.delaySeconds || argv.delay || process.env.GT_DELAY_SECONDS || 0);
const OUT = argv.out || process.env.GT_OUT_FILE || '/tmp/ground_truth_token_largest_accounts.jsonl';

function readLines(file){
  try{ if(!fs.existsSync(file)) return []; return fs.readFileSync(file,'utf8').trim().split(/\n+/).map(l=>JSON.parse(l)).filter(Boolean); }catch(e){ console.error('read error', e && e.message || e); return []; }
}

(async ()=>{
  const events = readLines(RAW);
  if(!events.length){ console.error('No raw events found in', RAW); process.exit(2); }

  // create local connection (avoid requiring TypeScript config module)
  let connection = null;
  try{
    const { Connection } = require('@solana/web3.js');
    const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    connection = new Connection(rpc, 'confirmed');
  }catch(e){ console.error('Could not create connection', e && e.message || e); process.exit(2); }

  const outs = [];
  for(const ev of events){
    const slot = ev && (ev.slot || ev.txBlock || ev.firstBlock || null);
    const fresh = Array.isArray(ev.freshMints) ? ev.freshMints : [];
    for(const mint of fresh){
      if(DELAY_SECONDS > 0){
        console.error(`[GT] waiting ${DELAY_SECONDS}s before checking ${mint}`);
        await new Promise(r=>setTimeout(r, DELAY_SECONDS * 1000));
      }
      console.error(`[GT] checking mint ${mint} slot=${slot}`);
      const record = { mint, slot, checked_at: Date.now(), tokenLargestAccounts: null, owners: null, rawEvent: ev };
      try{
        const la = await connection.getTokenLargestAccounts(new PublicKey(mint));
        record.tokenLargestAccounts = la && la.value ? la.value : la;
        // for each returned account, fetch parsed account info to see owner
        const owners = [];
        if(la && Array.isArray(la.value)){
          for(const v of la.value){
            try{
              const addr = v && (v.address || v.pubkey || (v && v.account && v.account.data && v.account.data.parsed && v.account.data.parsed.info && v.account.data.parsed.info.owner));
              const pk = new PublicKey(v.address || v.pubkey || (v && v.pubkey) || v.address);
              const info = await connection.getParsedAccountInfo(pk).catch(()=>null);
              let owner = null;
              try{ owner = info && info.value && info.value.owner ? info.value.owner : (info && info.value && info.value.data && info.value.data.parsed && info.value.data.parsed.info && info.value.data.parsed.info.owner ? info.value.data.parsed.info.owner : null); }catch(_e){}
              owners.push({ address: String(pk), uiAmount: v.uiAmount || null, amount: v.amount || null, owner });
            }catch(_e){ owners.push({ address: v && (v.address||v.pubkey) || null, uiAmount: v && v.uiAmount || null, error: (_e && _e.message) || String(_e) }); }
          }
        }
        record.owners = owners;
      }catch(e){ record.error = e && (e.message || e.toString()); }
      // append to out file as JSONL
      try{ fs.appendFileSync(OUT, JSON.stringify(record) + "\n", 'utf8'); }catch(e){ console.error('write out error', e && e.message || e); }
      outs.push(record);
      console.error('[GT] wrote record for', mint);
    }
  }
  console.log('Wrote', outs.length, 'records to', OUT);
  process.exit(0);
})();
