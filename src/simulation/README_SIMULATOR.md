Sniper Slot Simulation
======================

This lightweight simulator provides a slot-aware environment for pre-slot analysis and a zero-decision trigger.

How to run

Node.js is required (no external dependencies).

Run from repository root:

```bash
node src/simulation/sniper_simulator.js [START_SLOT] [TARGET_SLOT_OR_OFFSET]
```

Examples:

- Start at slot 100000 and wait for target slot 100005:
  ```bash
  node src/simulation/sniper_simulator.js 100000 100005
  ```

- Start at slot 100000 and wait  +5 slots:
  ```bash
  node src/simulation/sniper_simulator.js 100000 +5
  ```

Environment variables (optional):

- `SIM_START_SLOT` - set start slot
- `SIM_TARGET` - set target slot or offset
- `SIM_TOKEN` - token name used in the simulated LaunchState

Notes

- This is a pure simulation: no RPCs, no trades, no wallets. It implements the architecture described in the repository issues for temporal pre-slot analysis.
