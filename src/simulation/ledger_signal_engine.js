#!/usr/bin/env node
/**
 * Lightweight Ledger Signal Engine
 * - short ring buffer (slot window)
 * - ingests minimal events (slot, kind, freshMints, sampleLogs, user, candidateTokens)
 * - produces small bitmask signals per-mint for fast O(1) checks
 */
const DEFAULT_WINDOW_SLOTS = 3;
// bit mapping: place ledger bits outside the existing FSM bit-range to avoid collisions
// FSM uses bits 0..5 (see program_fsm_watcher.js BIT_SLOT_SEQ = 1<<5). Reserve ledger bits starting at 1<<6.
const LEDGER_BIT_BASE_SHIFT = 6;
const BIT_ACCOUNT_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 0); // AccountCreated
const BIT_ATA_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 1);     // ATACreated
const BIT_SAME_AUTH = 1 << (LEDGER_BIT_BASE_SHIFT + 2);       // SameAuthority
const BIT_PROGRAM_INIT = 1 << (LEDGER_BIT_BASE_SHIFT + 3);    // ProgramInit
const BIT_SLOT_DENSE = 1 << (LEDGER_BIT_BASE_SHIFT + 4);      // SlotAligned / density
// New bits per design
const BIT_LP_STRUCT = 1 << (LEDGER_BIT_BASE_SHIFT + 5);      // LP structure (pool/vaults/lp mint)
const BIT_CLEAN_FUNDING = 1 << (LEDGER_BIT_BASE_SHIFT + 6);  // Clean funding pattern (1-2 transfers, same source)
const BIT_SLOT_ALIGNED = 1 << (LEDGER_BIT_BASE_SHIFT + 7);   // Slot-aligned sequence (<=2 slots)
const BIT_CREATOR_EXPOSED = 1 << (LEDGER_BIT_BASE_SHIFT + 8);// Creator funded vault / mint authority exposed

class LedgerSignalEngine {
  constructor(opts = {}){
    this.windowSlots = Number(opts.windowSlots || DEFAULT_WINDOW_SLOTS);
    this.slotBuckets = new Map(); // slot -> { ts, count, mints: Map<mint, flags>, authorities: Map<auth, Set<mint>> }
    this.slotOrder = []; // recent slots in order
    this.densityThreshold = Number(opts.densityThreshold || 3); // events per slot considered dense
    // per-slot transfer records to help funding-pattern heuristics
    // slot -> Array<{ to, from, amount, rawLine }>
    this.slotTransfers = new Map();
  }

  _ensureSlot(slot){
    if(!this.slotBuckets.has(slot)){
      this.slotBuckets.set(slot, { ts: Date.now(), count: 0, mints: new Map(), authorities: new Map() });
      this.slotOrder.push(slot);
      // trim to window
      while(this.slotOrder.length > this.windowSlots){ const rem = this.slotOrder.shift(); this.slotBuckets.delete(rem); }
    }
    return this.slotBuckets.get(slot);
  }

  // ingest an event emitted by sniper / program FSM
  processEvent(ev){
    try{
      const slot = ev && (ev.slot || ev.blockSlot || ev.firstBlock || ev.txBlock || null);
      if(!slot) return; // require explicit slot (managed RPC should provide getSlot())
      const bucket = this._ensureSlot(Number(slot));
      bucket.count = (bucket.count || 0) + 1;
      const fresh = Array.isArray(ev.freshMints) ? ev.freshMints.slice(0,20) : [];
      const auth = ev.user || (ev && ev.signature) || (ev && ev.sourceSignature) || (ev.candidateTokens && ev.candidateTokens[0] && (ev.candidateTokens[0].mintAuthority || ev.candidateTokens[0].authority)) || null;
      const logs = (ev.sampleLogs && Array.isArray(ev.sampleLogs)) ? ev.sampleLogs.join('\n').toLowerCase() : (ev.sampleLogs && typeof ev.sampleLogs === 'string' ? ev.sampleLogs.toLowerCase() : '');
      const kind = ev.kind || (ev && ev.event && ev.event.kind) || '';
      // parse simple transfer lines into slotTransfers for funding heuristics
      try{
        if(logs && logs.includes('transfer')){
          const arr = this.slotTransfers.get(Number(slot)) || [];
          const lines = logs.split('\n');
          for(const ln of lines){
            try{
              if(!ln.includes('transfer')) continue;
              // extract addresses-like tokens (base58 heuristics)
              const parts = ln.split(/\s+/).filter(Boolean);
              let from = null, to = null, amt = null;
              for(const p of parts){
                if(/^[A-Za-z0-9]{32,44}$/.test(p)){
                  if(!from) from = p; else if(!to) to = p;
                }
                // crude amount detection
                if(/^[0-9]+(\.[0-9]+)?$/.test(p)) amt = Number(p);
              }
              arr.push({ raw: ln, from, to, amount: amt });
            }catch(_e){}
          }
          this.slotTransfers.set(Number(slot), arr);
        }
      }catch(_e){}

      for(const m of fresh){
        try{
          const key = String(m);
          const entry = bucket.mints.get(key) || { flags: 0, seenSlots: new Set() };
          // Signal heuristics (minimal parsing, prefer deterministic fields when possible)
          if(kind && String(kind).toLowerCase().includes('initialize')) entry.flags |= BIT_ACCOUNT_CREATED;
          if(logs && (logs.includes('associated') || logs.includes('ata') || logs.includes('associated token'))) entry.flags |= BIT_ATA_CREATED;
          if(logs && (logs.includes('create') || logs.includes('initializemint') || logs.includes('createidempotent'))) entry.flags |= BIT_ACCOUNT_CREATED;
          if(kind && (String(kind).toLowerCase().includes('pool') || String(kind).toLowerCase().includes('init'))) entry.flags |= BIT_PROGRAM_INIT;
          entry.seenSlots.add(Number(slot));
          bucket.mints.set(key, entry);
          // track authorities
          if(auth){
            const a = String(auth);
            const aset = bucket.authorities.get(a) || new Set();
            aset.add(String(m));
            bucket.authorities.set(a, aset);
          }
        }catch(_e){}
      }
      // fast detect slot density
      // nothing else to do here; mask extraction is on-demand
    }catch(e){ /* swallow */ }
  }

  // compute mask for a given mint across the recent window
  getMaskForMint(mint, slot){
    try{
      const key = String(mint);
      let mask = 0;
      // aggregate across window
      for(const s of this.slotOrder){
        const b = this.slotBuckets.get(s);
        if(!b) continue;
        const ent = b.mints.get(key);
        if(ent && ent.flags) mask |= ent.flags;
        // same-authority heuristic: if any authority in this bucket references >1 mint, and includes this mint
        for(const [auth, aset] of b.authorities.entries()){
          if(aset.has(key) && aset.size > 1){ mask |= BIT_SAME_AUTH; break; }
        }
        // density
        if(b.count >= this.densityThreshold) mask |= BIT_SLOT_DENSE;
        // LP-structure heuristic: inspect logs/flags in entry for pool/vault keywords
        try{
          if(ent){
            const sampleLogs = (ent.sampleLogs || '').toLowerCase();
            if(sampleLogs && (sampleLogs.includes('vault') || sampleLogs.includes('pool') || sampleLogs.includes('lp') || sampleLogs.includes('liquidity') || sampleLogs.includes('lp_mint') || sampleLogs.includes('lp mint'))) mask |= BIT_LP_STRUCT;
          }
        }catch(_e){}
        // funding heuristics: look at transfers recorded in this slot that reference this mint
        try{
          const transfers = this.slotTransfers.get(s) || [];
          if(transfers.length>0){
            // count transfers that mention this mint address in raw line or to/from equals mint
            let relevant = transfers.filter(t => (t.to === key || t.from === key || (t.raw && t.raw.includes(key)) || (t.raw && (t.raw.includes('vault') && t.raw.includes(key)) )));
            // if at least 1-2 transfers to same to-address and not from many sources -> clean funding
            if(relevant.length>0){
              // group by to
              const byTo = new Map();
              for(const r of relevant){ const kto = r.to || r.raw || '__unk'; const arr = byTo.get(kto) || []; arr.push(r); byTo.set(kto, arr); }
              for(const [kto, arr] of byTo.entries()){
                const fromSet = new Set(arr.map(x=>x.from||x.raw||'__unk'));
                if(arr.length <= 2 && fromSet.size <= 2){ mask |= BIT_CLEAN_FUNDING; }
                // creator exposed: if any from equals known authority pattern (we'll treat presence of same auth in bucket)
                for(const r of arr){ if(r.from && b.authorities && b.authorities.has(r.from)) mask |= BIT_CREATOR_EXPOSED; }
              }
            }
          }
        }catch(_e){}
      }
      // slot-aligned: check min/max seenSlots across window for this mint
      try{
        let minS = null, maxS = null;
        for(const s of this.slotOrder){ const b = this.slotBuckets.get(s); if(!b) continue; const ent = b.mints.get(key); if(ent && ent.seenSlots && ent.seenSlots.size){ for(const ss of ent.seenSlots){ const n = Number(ss); if(minS===null||n<minS) minS=n; if(maxS===null||n>maxS) maxS=n; } } }
        if(minS!==null && maxS!==null && (maxS - minS) <= 2) mask |= BIT_SLOT_ALIGNED;
      }catch(_e){}
      return mask;
    }catch(e){ return 0; }
  }

  // convenience: boolean strong signal when mask meets bit-count threshold
  isStrongSignal(mint, slot, requiredBits=2){
    const mask = this.getMaskForMint(mint, slot);
    // count set bits
    let cnt = 0; let m = mask;
    while(m){ cnt += (m & 1); m >>>= 1; }
    return cnt >= requiredBits;
  }
}

module.exports = { LedgerSignalEngine, BIT_ACCOUNT_CREATED, BIT_ATA_CREATED, BIT_SAME_AUTH, BIT_PROGRAM_INIT, BIT_SLOT_DENSE, BIT_LP_STRUCT, BIT_CLEAN_FUNDING, BIT_SLOT_ALIGNED, BIT_CREATOR_EXPOSED };
