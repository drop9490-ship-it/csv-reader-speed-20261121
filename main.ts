// v20: thin TypeScript entry point — the program lives in main.js.
// Node 22's .ts type-stripping costs ~0.27s CPU for a 21KB main.ts
// (measured locally: same file as .mjs loads in 0.05s vs 0.32s as .ts),
// so main.ts only imports the plain-JavaScript implementation.
// The harness runs node /bot/main.ts; the whole repo snapshot is
// materialized at /bot, so ./main.js is present. solve.js (v11) unchanged.
import './main.js';
