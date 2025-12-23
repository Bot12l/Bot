import rpcPool from '../src/utils/rpcPool';

console.log('RPC candidates (first 10):', (rpcPool.getRpcCandidates && rpcPool.getRpcCandidates().slice(0,10)) || 'n/a');
if((rpcPool as any).getNextHeliusRpcUrl) console.log('Helius sample 1:', (rpcPool as any).getNextHeliusRpcUrl());
if((rpcPool as any).getNextHeliusRpcUrl) console.log('Helius sample 2:', (rpcPool as any).getNextHeliusRpcUrl());
console.log('Next RPC URL:', rpcPool.getNextRpcUrl());
console.log('Get connection (preferPrivate):', typeof rpcPool.getRpcConnection === 'function');
const conn = (rpcPool as any).getRpcConnection ? (rpcPool as any).getRpcConnection({ preferPrivate: true }) : null;
console.log('Connection endpoint (lastUsed):', rpcPool.getLastUsedUrl());

// Show health helpers if available
if((rpcPool as any).getHealthyCandidates) console.log('Healthy candidates:', (rpcPool as any).getHealthyCandidates().slice(0,5));

console.log('Done.');
