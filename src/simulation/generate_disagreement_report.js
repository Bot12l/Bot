#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const samplesPath = path.resolve(__dirname, 'sample_mints_enriched.json');
const metricsPath = '/tmp/fsm_metrics.jsonl';
const outCsv = '/tmp/disagreement_details.csv';
const outJsonl = '/tmp/disagreement_details.jsonl';

if(!fs.existsSync(samplesPath)){
  console.error('samples file not found:', samplesPath); process.exit(2);
}
const samples = JSON.parse(fs.readFileSync(samplesPath,'utf8'));
const metricsMap = new Map();
if(fs.existsSync(metricsPath)){
  const lines = fs.readFileSync(metricsPath,'utf8').trim().split(/\n+/).filter(Boolean);
  for(const l of lines){ try{ const o = JSON.parse(l); if(o.mint) metricsMap.set(o.mint,o); }catch(e){} }
}

const headers = [
  'mint','signature','slot','program','solletCreatedHere','ledgerStrong','mask','maskNames','transferCount','uniqueSenders','uniqueRecipients','transferAmountSum','sampleLogs','rawFull'
];
fs.writeFileSync(outCsv, headers.join(',') + '\n','utf8');
fs.writeFileSync(outJsonl,'','utf8');
let idx = 0;
for(const s of samples){
  idx++;
  const mint = s.mint || s.tokenAddress || '';
  const metric = metricsMap.get(mint) || s.rawFull || {};
  const signature = s.signature || metric.signature || '';
  const slot = s.slot || metric.slot || metric.txBlock || '';
  const program = (metric.program || metric.sourceProgram || '');
  const sol = !!s.solletCreatedHere;
  const led = !!s.ledgerStrong;
  const mask = (metric.mask || 0);
  const maskNames = Array.isArray(metric.maskNames) ? metric.maskNames.join('|') : (metric.maskNames || '');
  // transfer-derived fields saved in metrics (if present)
  const transferCount = (metric.transferCount || metric.transferCount===0) ? metric.transferCount : (metric.transferCount || '');
  const uniqueSenders = (metric.uniqueSenders || metric.uniqueSenders===0) ? metric.uniqueSenders : '';
  const uniqueRecipients = (metric.uniqueRecipients || metric.uniqueRecipients===0) ? metric.uniqueRecipients : '';
  const transferAmountSum = (metric.transferAmountSum || metric.transferAmountSum===0) ? metric.transferAmountSum : '';
  const sampleLogs = (s.rawFull && s.rawFull.sampleLogs) ? JSON.stringify(s.rawFull.sampleLogs).replace(/"/g,'""') : '';
  const rawFull = JSON.stringify(s.rawFull || {}).replace(/"/g,'""');
  const row = [mint, signature, slot, program, sol, led, mask, maskNames, transferCount, uniqueSenders, uniqueRecipients, transferAmountSum, `"${sampleLogs}"`, `"${rawFull}"`];
  fs.appendFileSync(outCsv, row.join(',') + '\n','utf8');
  fs.appendFileSync(outJsonl, JSON.stringify({mint,signature,slot,program,solletCreatedHere:sol,ledgerStrong:led,mask,maskNames,transferCount,uniqueSenders,uniqueRecipients,transferAmountSum,sampleLogs,rawFull: s.rawFull || {}}) + '\n','utf8');
}
console.error('Wrote', idx, 'rows to', outCsv, 'and to', outJsonl);
process.exit(0);
