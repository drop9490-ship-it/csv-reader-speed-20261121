// csv-reader-speed v16 — byte-level JSON-to-JSON CSV transducer.
//
// Architecture (fundamentally different from v5–v15, which all optimized
// run() over an already-parsed input):
//   * The grader times the WHOLE program (node /bot/main.ts) net of a
//     null-entry control: JSON.parse(cases.json) + run() + JSON.stringify
//     (answers). Locally those fixed costs dwarf run(): parse ~0.087s,
//     stringify ~0.19s, run(v11) ~0.05s per pass. The dev leaderboard
//     confirms it: our v7 entry sits at 1,780,000 µs (rank 3044/3579)
//     while byte-transducer entries sit at 10k–110k µs (top 10).
//   * So main.ts no longer JSON.parses the input nor JSON.stringifies the
//     output. It reads cases.json as raw UTF-8 bytes, finds each case's
//     "text" JSON-string span, parses the CSV directly over the ESCAPED
//     bytes, and emits answers.json bytes directly.
//   * Why this is exact: the CSV text inside cases.json is JSON-escaped,
//     and a field value's JSON escaping is a function of its characters
//     alone — so for a field with no CSV transformation, the output bytes
//     are the input bytes VERBATIM (\" stays \", \n stays \n, raw UTF-8
//     stays raw UTF-8). Only two transformations split a span: doubled
//     quotes "" -> " (output \") and CR/CRLF inside quotes -> LF
//     (output \n). UTF-8 is self-synchronising: no multi-byte byte equals
//     an ASCII delimiter, so byte scanning needs NO charCodeAt
//     verification (v11's verification bucket disappears entirely).
//   * solve.js (v11) is kept untouched as the entry's run() and as the
//     fallback: any case whose bytes the fast path cannot handle
//     (\u escapes, raw control bytes, unexpected structure) falls back
//     to JSON.parse + run() + JSON.stringify for that case alone.
//     Structural failure of the whole file falls back to the old
//     main.ts behaviour for every case.
//
// Rules respected: JavaScript/TypeScript source only, no WASM, no native
// addon, no eval, no cache between cases (each case is parsed alone from
// its own span; the only shared state is the output buffer cursor, which
// holds no case data), dependency-free solve.js unchanged.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Thrown (by identity) when a case's bytes need the slow fallback.
const NEED_FALLBACK = {};

// Shared slow-path result object (same shape as v11's SLOW_OUT).
const SLOW_OUT = { value: '', ended: 0, next: 0, lineBump: 0, added: 0 };

// Decode one JSON-string-content span [a, b) of raw bytes into a JS string.
// The span is the inside of a JSON string literal, so wrapping it in quotes
// and JSON.parse-ing is exact (escapes, UTF-8, lone surrogates included).
function spanToString(raw, a, b) {
  return JSON.parse('"' + raw.toString('utf8', a, b) + '"');
}

// JSON-escape a JS string value into the output buffer (slow paths only:
// unterminated / quote-junk / stray-cr field values and cut long-row
// fields). Returns the new output length.
function writeJsonString(ob, ol, v) {
  let s = '"';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 34) s += '\\"';
    else if (c === 92) s += '\\\\';
    else if (c === 10) s += '\\n';
    else if (c === 13) s += '\\r';
    else if (c === 9) s += '\\t';
    else if (c === 8) s += '\\b';
    else if (c === 12) s += '\\f';
    else if (c < 32) s += '\\u' + c.toString(16).padStart(4, '0');
    else s += v[i];
  }
  s += '"';
  return ol + ob.write(s, ol, 'utf8');
}

// Generic slow scan over escaped bytes (rare paths only: unterminated
// quote, quote junk, stray CR). Port of v11's slowScan, with virtual
// characters: raw byte 44 is a comma; raw 92 starts a 2-byte escape
// (34 quote, 110 LF, 114 CR, others ordinary); raw n is the span end.
// Builds the value as a JS string. Parameters mirror v11.
function slowScan(raw, n, errParts, recordLine, recordRow, prefix, start, seg, added) {
  let vstart = start;
  let i = start;
  while (true) {
    let j = i;
    let c = 0;
    let hit = false;
    while (j < n) {
      const b = raw[j];
      if (b === 44) { c = 44; hit = true; break; }
      if (b === 92) {
        const t = raw[j + 1];
        if (t === 34 || t === 116 || t === 98 || t === 102 || t === 47 || t === 92) { j += 2; continue; }
        if (t === 117) throw NEED_FALLBACK;
        if (t === 110) { c = 10; hit = true; break; }
        if (t === 114) { c = 13; hit = true; break; }
        throw NEED_FALLBACK;
      }
      if (b < 32) throw NEED_FALLBACK;
      j += 1;
    }
    const tail = spanToString(raw, vstart, j);
    added += j - vstart;
    const v = seg === null ? (prefix === null ? tail : prefix + tail) : (prefix === null ? seg.join('') + tail : prefix + seg.join('') + tail);
    if (!hit) { SLOW_OUT.value = v; SLOW_OUT.ended = END; SLOW_OUT.next = n; SLOW_OUT.lineBump = 0; SLOW_OUT.added = added; return SLOW_OUT; }
    if (c === 44) { SLOW_OUT.value = v; SLOW_OUT.ended = COMMA; SLOW_OUT.next = j + 1; SLOW_OUT.lineBump = 0; SLOW_OUT.added = added; return SLOW_OUT; }
    if (c === 10) { SLOW_OUT.value = v; SLOW_OUT.ended = LINE_BREAK; SLOW_OUT.next = j + 2; SLOW_OUT.lineBump = 1; SLOW_OUT.added = added; return SLOW_OUT; }
    if (raw[j + 2] === 92 && raw[j + 3] === 110) { SLOW_OUT.value = v; SLOW_OUT.ended = LINE_BREAK; SLOW_OUT.next = j + 4; SLOW_OUT.lineBump = 1; SLOW_OUT.added = added; return SLOW_OUT; }
    errParts.push(JSON.stringify({ code: 'stray_cr', line: recordLine, row: recordRow }));
    if (seg === null) seg = [tail];
    else seg.push(tail);
    i = j + 2;
    vstart = j + 2;
  }
}



// Grow the output buffer, preserving `used` bytes. Top-level (no closure).
function growBuf(ob, used, need) {
  let nl = ob.length * 2;
  while (nl < need) nl *= 2;
  const nb = Buffer.allocUnsafe(nl);
  ob.copy(nb, 0, 0, used);
  return nb;
}

// Materialize a spanned field value (pieces + literal joins) as a JS string.
// Rare paths only (quote junk prefix, cut long-row fields).
function materializeSpans(raw, spans, lits) {
  let out = '';
  for (let k = 0; k < spans.length; k += 2) {
    out += spanToString(raw, spans[k], spans[k + 1]);
    if (k + 2 < spans.length) out += (lits[k] === 92 && lits[k + 1] === 34) ? '"' : '\n';
  }
  return out;
}

// Parse one case's escaped-text span [s0, e) and return its answer JSON as
// a Buffer. Faithful port of v11's run() over raw JSON bytes: positions are
// raw indices, virtual characters are raw byte 44 (comma) or a 2-byte
// escape starting with raw byte 92 (34 quote, 110 LF, 114 CR, others
// ordinary). Field values are emitted as raw spans (verbatim JSON) unless
// a slow path materializes them as JS strings.

const UQ = { j: 0, c: 0, hit: false };
function scanUnquoted(raw, n, start) {
  let j = start;
  let b = 0;
  let t = 0;
  let c = 0;
  let hit = false;
  while (j < n) {
    b = raw[j];
    if (b === 44) { c = 44; hit = true; break; }
    else if (b === 92) {
      t = raw[j + 1];
      if (t === 34 || t === 116 || t === 98 || t === 102 || t === 47 || t === 92) { j = j + 2; continue; }
      if (t === 117) throw NEED_FALLBACK;
      if (t === 110) { c = 10; hit = true; break; }
      if (t === 114) { c = 13; hit = true; break; }
      throw NEED_FALLBACK;
    }
    j += 1;
  }
  UQ.j = j; UQ.c = c; UQ.hit = hit;
}

const Q = { close: -1, qhit: false, segStart: 0, breaks: 0, pieces: null, lits: null };
function scanQuoted(raw, n, start) {
  let s = start;
  let segStart = start;
  let breaks = 0;
  let close = -1;
  let qhit = false;
  let pieces = null;
  let lits = null;
  let b = 0;
  let t = 0;
  while (s < n) {
    b = raw[s];
    if (b === 92) {
      t = raw[s + 1];
      if (t === 34) {
        if (raw[s + 2] === 92 && raw[s + 3] === 34) {
          if (pieces === null) { pieces = []; lits = []; }
          pieces.push(segStart, s); lits.push(92, 34);
          s = s + 4; segStart = s; continue;
        }
        close = s; qhit = true; break;
      }
      if (t === 110) { breaks += 1; s = s + 2; continue; }
      if (t === 114) {
        if (pieces === null) { pieces = []; lits = []; }
        pieces.push(segStart, s); lits.push(92, 110);
        breaks += 1;
        if (raw[s + 2] === 92 && raw[s + 3] === 110) { s = s + 4; } else { s = s + 2; }
        segStart = s; continue;
      }
      if (t === 117) throw NEED_FALLBACK;
      if (t === 116 || t === 98 || t === 102 || t === 47 || t === 92) { s = s + 2; continue; }
      throw NEED_FALLBACK;
    }
    s += 1;
  }
  Q.close = close; Q.qhit = qhit; Q.segStart = segStart; Q.breaks = breaks;
  Q.pieces = pieces; Q.lits = lits;
}

function parseCase(raw, s0, e, header) {
  const n = e;
  let ob = Buffer.allocUnsafe(Math.max(1024, (e - s0) + 131072));
  let ol = 0;
  let pos = s0;
  let line = 1;
  if (raw[pos] === 0xEF && raw[pos + 1] === 0xBB && raw[pos + 2] === 0xBF) pos += 3;
  const errParts = [];
  let width = -1;
  let rowsEmitted = 0;
  let phase = 0; // 0 = columns (header only), 1 = rows
  let b = 0;
  let t = 0;
  if (header) { ol += ob.write('{"columns":[', ol, 'ascii'); }
  else { ol += ob.write('{"columns":null,"rows":[', ol, 'ascii'); phase = 1; }

  while (true) {
    while (pos < n) {
      if (raw[pos] === 92 && raw[pos + 1] === 110) { pos += 2; line += 1; }
      else if (raw[pos] === 92 && raw[pos + 1] === 114) {
        if (raw[pos + 2] === 92 && raw[pos + 3] === 110) { pos += 4; line += 1; }
        else break;
      } else break;
    }
    if (pos >= n) break;
    const recordLine = line;
    const recordRow = (header && phase === 0) ? null : rowsEmitted;
    const rowStart = ol;
    const errStart = errParts.length;
    let fi = 0;
    let ended;
    let quoted = false;
    let firstEmpty = false;
    let extraArr = null;
    if (phase === 1) {
      if (rowsEmitted > 0) { if (ol + 2 > ob.length) ob = growBuf(ob, ol, ol + 2); ob[ol++] = 44; }
      if (ol + 1 > ob.length) ob = growBuf(ob, ol, ol + 1);
      ob[ol++] = 91;
    }
    do {
      let vStr = null;
      let vSpans = null;
      let vLits = null;
      let vSpanBytes = 0;
      let fQuoted = false;
      if (raw[pos] === 92 && raw[pos + 1] === 34) {
        // ---- Quoted field (same semantics as v11).
        fQuoted = true;
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 2;
        scanQuoted(raw, n, pos);
        let segStart = Q.segStart;
        let breaks = Q.breaks;
        let close = Q.close;
        let qhit = Q.qhit;
        let pieces = Q.pieces;
        let lits = Q.lits;
        if (close === -1) {
          pos = open + 2;
          line = openLine;
          errParts.push(JSON.stringify({ code: 'unterminated_quote', line: recordLine, row: recordRow }));
          const r = slowScan(raw, n, errParts, recordLine, recordRow, '"', pos, null, 0);
          vStr = r.value; ended = r.ended; pos = r.next; line += r.lineBump;
        } else {
          if (pieces === null) { vSpans = [open + 2, close]; vLits = []; vSpanBytes = close - (open + 2); }
          else {
            pieces.push(segStart, close);
            vSpans = pieces; vLits = lits;
            vSpanBytes = 0;
            for (let k = 0; k < vSpans.length; k += 2) vSpanBytes += vSpans[k + 1] - vSpans[k];
          }
          line += breaks;
          pos = close + 2;
          if (pos >= n) { ended = END; }
          else {
            const cb = raw[pos];
            if (cb === 44) { pos += 1; ended = COMMA; }
            else if (cb === 92 && raw[pos + 1] === 110) { pos += 2; line += 1; ended = LINE_BREAK; }
            else if (cb === 92 && raw[pos + 1] === 114 && raw[pos + 2] === 92 && raw[pos + 3] === 110) { pos += 4; line += 1; ended = LINE_BREAK; }
            else {
              const qval = materializeSpans(raw, vSpans, vLits);
              const r = slowScan(raw, n, errParts, recordLine, recordRow, qval, pos, null, 0);
              vStr = r.value; vSpans = null; vLits = null; vSpanBytes = 0;
              ended = r.ended; pos = r.next; line += r.lineBump;
              if (r.added > 0) errParts.push(JSON.stringify({ code: 'quote_junk', line: recordLine, row: recordRow }));
            }
          }
        }
      } else {
        // ---- FAST: plain unquoted field. 1-lane raw scan + one span copy.
        quoted = false;
        scanUnquoted(raw, n, pos);
        let j = UQ.j;
        let c = UQ.c;
        let hit = UQ.hit;
        if (j >= n) { vSpans = [pos, j]; vLits = []; vSpanBytes = j - pos; ended = END; pos = n; }
        else if (c === 44) { vSpans = [pos, j]; vLits = []; vSpanBytes = j - pos; ended = COMMA; pos = j + 1; }
        else if (c === 10) { vSpans = [pos, j]; vLits = []; vSpanBytes = j - pos; ended = LINE_BREAK; pos = j + 2; line += 1; }
        else if (raw[j + 2] === 92 && raw[j + 3] === 110) { vSpans = [pos, j]; vLits = []; vSpanBytes = j - pos; ended = LINE_BREAK; pos = j + 4; line += 1; }
        else {
          // Stray CR at j: slow scan from j+2, first segment already kept.
          errParts.push(JSON.stringify({ code: 'stray_cr', line: recordLine, row: recordRow }));
          const r = slowScan(raw, n, errParts, recordLine, recordRow, null, j + 2, [spanToString(raw, pos, j)], j - pos);
          vStr = r.value; ended = r.ended; pos = r.next; line += r.lineBump;
        }
      }
      const isEmpty = vStr !== null ? vStr.length === 0 : (vSpanBytes === 0 && (vLits === null || vLits.length === 0));
      if (fi === 0) firstEmpty = isEmpty && !fQuoted;
      const willCut = (phase === 1 && width > 0 && fi >= width);
      if (willCut) {
        if (extraArr === null) extraArr = [];
        extraArr.push(vStr !== null ? vStr : materializeSpans(raw, vSpans, vLits));
      } else {
        const need = 1 + 2 + vSpanBytes + (vLits === null ? 0 : vLits.length) + (vStr !== null ? vStr.length * 6 + 16 : 0);
        if (ol + need > ob.length) ob = growBuf(ob, ol, ol + need);
        if (fi > 0) ob[ol++] = 44;
        if (vStr !== null) { ol = writeJsonString(ob, ol, vStr); }
        else {
          ob[ol++] = 34;
          for (let k = 0; k < vSpans.length; k += 2) {
            const a = vSpans[k];
            const b2 = vSpans[k + 1];
            if (b2 > a) { raw.copy(ob, ol, a, b2); ol += b2 - a; }
            if (k + 2 < vSpans.length) { ob[ol++] = vLits[k]; ob[ol++] = vLits[k + 1]; }
          }
          ob[ol++] = 34;
        }
      }
      fi++;
    } while (ended === COMMA);
    if (fi === 1 && firstEmpty && !quoted) { ol = rowStart; errParts.length = errStart; continue; }
    if (width < 0) width = fi;
    if (phase === 1) {
      if (fi < width) {
        errParts.push(JSON.stringify({ code: 'short_row', line: recordLine, row: recordRow, fields: fi }));
        if (ol + (width - fi) * 3 + 1 > ob.length) ob = growBuf(ob, ol, ol + (width - fi) * 3 + 1);
        for (let k = fi; k < width; k++) { ob[ol++] = 44; ob[ol++] = 34; ob[ol++] = 34; }
      } else if (fi > width) {
        errParts.push(JSON.stringify({ code: 'long_row', line: recordLine, row: recordRow, extra: extraArr }));
      }
      if (ol + 1 > ob.length) ob = growBuf(ob, ol, ol + 1);
      ob[ol++] = 93;
      rowsEmitted++;
    } else {
      if (ol + 10 > ob.length) ob = growBuf(ob, ol, ol + 10);
      ol += ob.write('],"rows":[', ol, 'ascii');
      phase = 1;
    }
  }
  if (phase === 0) {
    if (ol + 12 > ob.length) ob = growBuf(ob, ol, ol + 12);
    ol += ob.write('],"rows":[]', ol, 'ascii');
  } else {
    if (ol + 1 > ob.length) ob = growBuf(ob, ol, ol + 1);
    ob[ol++] = 93;
  }
  const es = ',"errors":[' + errParts.join(',') + ']}';
  if (ol + es.length > ob.length) ob = growBuf(ob, ol, ol + es.length);
  ol += ob.write(es, ol, 'utf8');
  return ob.subarray(0, ol);
}

async function fallbackCase(raw, s, e, header) {
  const { run } = await import(new URL('./solve.js', import.meta.url).href);
  const text = JSON.parse('"' + raw.toString('utf8', s, e) + '"');
  return Buffer.from(JSON.stringify(run({ text, header })), 'utf8');
}

async function fallbackAll(raw) {
  const { run } = await import(new URL('./solve.js', import.meta.url).href);
  const cases = JSON.parse(raw.toString('utf8'));
  const answers = [];
  for (const c of cases) answers.push(run(c.input));
  return Buffer.from(JSON.stringify(answers), 'utf8');
}

function isWs(b) { return b === 32 || b === 10 || b === 13 || b === 9; }

async function transduceAll(raw) {
  // JIT warm-up: parse a tiny synthetic span (with a quoted field and a
  // doubled quote) 100x so the real cases run TurboFan-optimized instead of
  // interpreted in a fresh process. 100x ~= 500x; a bigger warm-up span costs
  // more than it saves.
  {
    const w = Buffer.from('a,\"b\"\"c\"\n1,2\n', 'ascii');
    for (let i = 0; i < 100; i++) parseCase(w, 0, w.length, true);
  }
  let p = 0;
  while (p < raw.length && isWs(raw[p])) p++;
  if (raw[p] !== 91) throw NEED_FALLBACK;
  p++;
  const parts = [Buffer.from('[', 'ascii')];
  let first = true;
  while (true) {
    while (p < raw.length && isWs(raw[p])) p++;
    if (p >= raw.length) throw NEED_FALLBACK;
    if (raw[p] === 93) { p++; break; }
    if (raw[p] !== 123) throw NEED_FALLBACK;
    const ti = raw.indexOf('"text":"', p);
    if (ti < 0) throw NEED_FALLBACK;
    const s = ti + 8;
    const he = raw.indexOf('","header":', s);
    if (he < 0) throw NEED_FALLBACK;
    const e = he;
    let hp = he + 11;
    let header;
    if (raw[hp] === 116) { header = true; hp += 4; }
    else if (raw[hp] === 102) { header = false; hp += 5; }
    else throw NEED_FALLBACK;
    if (!first) parts.push(Buffer.from(',', 'ascii'));
    first = false;
    try {
      parts.push(parseCase(raw, s, e, header));
    } catch (err) {
      if (err !== NEED_FALLBACK) throw err;
      parts.push(await fallbackCase(raw, s, e, header));
    }
    p = hp;
    while (p < raw.length && isWs(raw[p])) p++;
    while (p < raw.length && raw[p] === 125) p++; // close input + element objects ("}}")
    while (p < raw.length && isWs(raw[p])) p++;
    if (p < raw.length && raw[p] === 44) { p++; continue; }
    if (p < raw.length && raw[p] === 93) { p++; break; }
    throw NEED_FALLBACK;
  }
  while (p < raw.length && isWs(raw[p])) p++;
  if (p < raw.length) throw NEED_FALLBACK;
  parts.push(Buffer.from(']', 'ascii'));
  return Buffer.concat(parts);
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(INPUT_DIR, 'cases.json'));
let outBuf;
try {
  outBuf = await transduceAll(raw);
} catch (err) {
  if (err === NEED_FALLBACK) outBuf = await fallbackAll(raw);
  else throw err;
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), outBuf);
