const fs = require('fs');
const path = require('path');

const OUT = process.env.FSM_METRICS_FILE || '/tmp/fsm_metrics.jsonl';

function appendMetric(obj){
  try{
    const line = JSON.stringify(obj);
    fs.appendFileSync(OUT, line + '\n', 'utf8');
  }catch(e){ console.error('fsm_metrics_logger append error', e && e.message || e); }
}

function readAll(){
  try{
    if(!fs.existsSync(OUT)) return [];
    const raw = fs.readFileSync(OUT,'utf8').trim();
    if(!raw) return [];
    return raw.split(/\n+/).map(l=>{ try{return JSON.parse(l);}catch(e){return null;} }).filter(Boolean);
  }catch(e){ return []; }
}

function summarize(){
  const a = readAll();
  const out = { count: a.length };
  if(a.length===0) return out;
  // reduce to latest entry per mint
  const byMint = new Map();
  for(const item of a){ if(item && item.mint) byMint.set(item.mint, item); }
  const latest = Array.from(byMint.values());
  out.count = latest.length;
  const lat = latest.map(x=>typeof x.final_reprobe_latency_ms === 'number' ? x.final_reprobe_latency_ms : null).filter(v=>v!==null);
  if(lat.length){
    const sum = lat.reduce((s,v)=>s+v,0);
    const avg = sum/lat.length;
    const sorted = lat.slice().sort((x,y)=>x-y);
    const mid = Math.floor(sorted.length/2);
    const med = (sorted.length%2===1) ? sorted[mid] : ((sorted[mid-1]+sorted[mid])/2);
    out.final_reprobe = { count: lat.length, avg_ms: avg, median_ms: med, min_ms: sorted[0], max_ms: sorted[sorted.length-1] };
  }
  const triggered = latest.filter(x=>x.triggered).length;
  out.triggers = { total: triggered, pct: (latest.length ? (triggered / latest.length) * 100 : 0) };
  return out;
}

module.exports = { appendMetric, readAll, summarize, OUT };
