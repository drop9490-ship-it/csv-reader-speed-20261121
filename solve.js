// S2a: v7 skeleton, scans over a latin1 Buffer (1 byte/char, byte index ==
// char index) instead of utf16le u32. 4 lanes/word, no parity handling, no
// per-word shift. Delimiter hits verified with charCodeAt (non-ASCII chars
// whose low byte equals a delimiter byte are false hits).
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const SLOW_OUT = { value: '', ended: 0, next: 0, lineBump: 0, added: 0 };

// Generic scan (rare paths only). Top-level (v11).
function slowScan(text, n, errors, recordLine, recordRow, prefix, start, seg, added) {
  let vstart = start;
  let i = start;
  while (true) {
    let j = i;
    let c = 0;
    while (j < n) {
      c = text.charCodeAt(j);
      if (c === 44 || c === 10 || c === 13) break;
      j += 1;
    }
    const tail = text.slice(vstart, j);
    added += j - vstart;
    const v = seg === null ? (prefix === null ? tail : prefix + tail) : (prefix === null ? seg.join('') + tail : prefix + seg.join('') + tail);
    if (j >= n) { SLOW_OUT.value = v; SLOW_OUT.ended = END; SLOW_OUT.next = n; SLOW_OUT.lineBump = 0; SLOW_OUT.added = added; return SLOW_OUT; }
    if (c === 44) { SLOW_OUT.value = v; SLOW_OUT.ended = COMMA; SLOW_OUT.next = j + 1; SLOW_OUT.lineBump = 0; SLOW_OUT.added = added; return SLOW_OUT; }
    if (c === 10) { SLOW_OUT.value = v; SLOW_OUT.ended = LINE_BREAK; SLOW_OUT.next = j + 1; SLOW_OUT.lineBump = 1; SLOW_OUT.added = added; return SLOW_OUT; }
    if (text.charCodeAt(j + 1) === 10) { SLOW_OUT.value = v; SLOW_OUT.ended = LINE_BREAK; SLOW_OUT.next = j + 2; SLOW_OUT.lineBump = 1; SLOW_OUT.added = added; return SLOW_OUT; }
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    if (seg === null) seg = [tail];
    else seg.push(tail);
    i = j + 1;
    vstart = j + 1;
  }
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const buf = Buffer.from(text, 'latin1');
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;
  let b = 0;


  while (true) {
    while (pos < n) {
      const bb = buf[pos];
      if (bb === 10) { if (text.charCodeAt(pos) !== 10) break; pos += 1; line += 1; }
      else if (bb === 13) {
        if (text.charCodeAt(pos) !== 13) break;
        if (buf[pos + 1] === 10 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
        else break;
      }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = width > 0 ? new Array(width) : [];
    let fi = 0;
    let ended;
    let quoted = false;
    do {
      let value;
      if (buf[pos] === 34 && text.charCodeAt(pos) === 34) {
        // ---- Quoted field (same semantics as v7).
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        let seg = null;
        let segStart = pos;
        let breaks = 0;
        let hasCR = false;
        let close = -1;
        let qhit = false;
        let s = pos;
        while (s < n) {
          b = buf[s];
          if (b === 34) {
            if (text.charCodeAt(s) === 34) {
              if (buf[s+1] === 34 && text.charCodeAt(s+1) === 34) { seg = seg === null ? text.slice(segStart, s) + '"' : seg + text.slice(segStart, s) + '"'; s += 2; segStart = s; continue; }
              close = s; qhit = true; break;
            }
          } else if (b < 14) {
            if (b === 10) { if (text.charCodeAt(s) === 10) breaks += 1; }
            else if (b === 13) { if (text.charCodeAt(s) === 13) { hasCR = true; if (!(buf[s+1] === 10 && text.charCodeAt(s+1) === 10)) breaks += 1; } }
          }
          s += 1;
        }
        if (close === -1) {
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = slowScan(text, n, errors, recordLine, recordRow, '"', pos, null, 0);
          value = r.value; ended = r.ended; pos = r.next; line += r.lineBump;
        } else {
          let qval;
          if (seg === null) {
            qval = close === open + 1 ? '' : text.slice(open + 1, close);
          } else {
            qval = seg + text.slice(segStart, close);
          }
          if (hasCR) qval = qval.replace(/\r\n?/g, '\n');
          line += breaks;
          pos = close + 1;
          if (pos >= n) { value = qval; ended = END; }
          else {
            const cb = buf[pos];
            if (cb === 44 && text.charCodeAt(pos) === 44) { pos += 1; value = qval; ended = COMMA; }
            else if (cb === 10 && text.charCodeAt(pos) === 10) { pos += 1; line += 1; value = qval; ended = LINE_BREAK; }
            else if (cb === 13 && text.charCodeAt(pos) === 13 && buf[pos + 1] === 10 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; value = qval; ended = LINE_BREAK; }
            else {
              const r = slowScan(text, n, errors, recordLine, recordRow, qval, pos, null, 0);
              value = r.value; ended = r.ended; pos = r.next; line += r.lineBump;
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        // ---- FAST: plain unquoted field. 4-lane latin1 byte scan + one slice.
        quoted = false;
        let j = pos;
        let c = 0;
        let hit = false;
        while (j + 3 < n) {
    b = buf[j];
    if (b < 14) { if (b === 10 || b === 13) { if (text.charCodeAt(j) === b) { c = b; j += 0; hit = true; break; } } }
    else if (b === 44) { if (text.charCodeAt(j) === 44) { c = 44; j += 0; hit = true; break; } }
    b = buf[j+1];
    if (b < 14) { if (b === 10 || b === 13) { if (text.charCodeAt(j+1) === b) { c = b; j += 1; hit = true; break; } } }
    else if (b === 44) { if (text.charCodeAt(j+1) === 44) { c = 44; j += 1; hit = true; break; } }
    b = buf[j+2];
    if (b < 14) { if (b === 10 || b === 13) { if (text.charCodeAt(j+2) === b) { c = b; j += 2; hit = true; break; } } }
    else if (b === 44) { if (text.charCodeAt(j+2) === 44) { c = 44; j += 2; hit = true; break; } }
    b = buf[j+3];
    if (b < 14) { if (b === 10 || b === 13) { if (text.charCodeAt(j+3) === b) { c = b; j += 3; hit = true; break; } } }
    else if (b === 44) { if (text.charCodeAt(j+3) === 44) { c = 44; j += 3; hit = true; break; } }
          j += 4;
        }
        if (!hit) {
    while (j < n) {
      b = buf[j];
      if (b < 14) { if (b === 10 || b === 13) { if (text.charCodeAt(j) === b) { c = b; hit = true; break; } } }
      else if (b === 44) { if (text.charCodeAt(j) === 44) { c = 44; hit = true; break; } }
      j += 1;
    }
        }
        if (j >= n) { value = j === pos ? '' : text.slice(pos, j); ended = END; pos = n; }
        else if (c === 44) { value = j === pos ? '' : text.slice(pos, j); ended = COMMA; pos = j + 1; }
        else if (c === 10) { value = j === pos ? '' : text.slice(pos, j); ended = LINE_BREAK; pos = j + 1; line += 1; }
        else if (buf[j + 1] === 10 && text.charCodeAt(j + 1) === 10) { value = j === pos ? '' : text.slice(pos, j); ended = LINE_BREAK; pos = j + 2; line += 1; }
        else {
          // Stray CR at j: slow scan from j+1, first segment already kept.
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          const r = slowScan(text, n, errors, recordLine, recordRow, null, j + 1, [j === pos ? '' : text.slice(pos, j)], j - pos);
          value = r.value; ended = r.ended; pos = r.next; line += r.lineBump;
        }
      }
      fields[fi++] = value;
    } while (ended === COMMA);
    if (fi !== width) fields.length = fi;

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fi < width) fields[fi++] = '';
      fields.length = fi;
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
