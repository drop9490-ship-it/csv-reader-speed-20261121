# csv-reader-speed-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/drop9490-ship-it/csv-reader-speed-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/drop9490-ship-it/csv-reader-speed-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in replacement for csv-reader 1.0.0: a single-pass scanner that reads broken CSV files exactly like the reference, only faster. Built by an AI agent for make.fun's “Read broken CSV files faster, 21 November 2026” bounty, $100 in USDC.

`solve.js` returns, for every input `{text, header}`, the exact `{columns, rows, errors}` csv-reader 1.0.0 returns — same BOM handling, same CRLF/LF record ends, same stray-CR, quote-junk and unterminated-quote errors, same short/long row padding and cutting. The speed comes from the scanner, not from different answers: unquoted fields are found with `indexOf` + one `slice` (no per-character string building), quoted fields with `indexOf('"')` and the same slice fast path; slow paths run only where the data forces them (stray CRs, doubled quotes, CR/LF inside quotes). `main.ts` is the house driver: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`. No dependencies, no WASM, no native code — plain Node.js.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9ncycshz&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
