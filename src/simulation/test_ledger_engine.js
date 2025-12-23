const { LedgerSignalEngine, BIT_ACCOUNT_CREATED, BIT_ATA_CREATED, BIT_SAME_AUTH, BIT_PROGRAM_INIT, BIT_SLOT_DENSE, BIT_LP_STRUCT, BIT_CLEAN_FUNDING, BIT_SLOT_ALIGNED, BIT_CREATOR_EXPOSED } = require('./ledger_signal_engine');

function decodeMask(mask){
  const names = [];
  const MAP = {
    [BIT_ACCOUNT_CREATED]: 'AccountCreated',
    [BIT_ATA_CREATED]: 'ATACreated',
    [BIT_SAME_AUTH]: 'SameAuthority',
    [BIT_PROGRAM_INIT]: 'ProgramInit',
    [BIT_SLOT_DENSE]: 'SlotDensity',
    [BIT_LP_STRUCT]: 'LPStruct',
    [BIT_CLEAN_FUNDING]: 'CleanFunding',
    [BIT_SLOT_ALIGNED]: 'SlotAligned',
    [BIT_CREATOR_EXPOSED]: 'CreatorExposed',
  };
  for(const k of Object.keys(MAP)){
    const kk = Number(k);
    if(mask & kk) names.push(MAP[kk]);
  }
  return names;
}

(async ()=>{
  const eng = new LedgerSignalEngine({ windowSlots: 3, densityThreshold: 1 });

  const ev = {
    slot: 100,
    kind: 'initialize',
    freshMints: ['Mint1','Mint2'],
    sampleLogs: ['associated token account created', 'some transfer happened'],
    user: 'FromAddr1',
    candidateTokens: [{ mintAuthority: 'FromAddr1' }],
    transaction: {
      message: {
        instructions: [
          { parsed: { type: 'initializeAccount', info: { account: 'Mint1', payer: 'FromAddr1' } }, program: 'system' }
        ]
      }
    },
    meta: {
      innerInstructions: [
        {
          instructions: [
            { parsed: { type: 'transfer', info: { source: 'FromAddr1', destination: 'VaultAddr', amount: '100', mint: 'Mint1' } }, program: 'spl-token' },
            { parsed: { type: 'transfer', info: { source: 'FromAddr1', destination: 'Mint1', amount: '10', mint: 'Mint1' } }, program: 'spl-token' }
          ]
        }
      ]
    }
  };

  console.log('--- feeding event ---');
  eng.processEvent(ev);

  // small delay to let processEvent inner logic run (though it's synchronous for our parsing path)
  await new Promise(r=>setTimeout(r,50));

  const transfers = eng.slotTransfers.get(100) || [];
  console.log('slotTransfers[100]=', JSON.stringify(transfers, null, 2));

  const mask1 = eng.getMaskForMint('Mint1', 100);
  console.log('mask for Mint1 (bits):', mask1, 'names:', decodeMask(mask1));

  const mask2 = eng.getMaskForMint('Mint2', 100);
  console.log('mask for Mint2 (bits):', mask2, 'names:', decodeMask(mask2));

  console.log('isStrongSignal Mint1 (>=2 bits)?', eng.isStrongSignal('Mint1', 100, 2));

})();
