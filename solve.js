// C1: v4 restructured — fast path FIRST, no per-field slow-setup locals.
// Same semantics as v4 (csv-reader 1.0.0). Slow scan is a small local
// function, called only on rare paths (stray CR / quote junk / unterminated).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const SLOW_OUT = { value: '', ended: 0, next: 0, lineBump: 0, added: 0 };

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const _buf = Buffer.from(text, 'utf16le');
  const u16 = new Uint16Array(_buf.buffer, _buf.byteOffset, n);
  const u32 = new Uint32Array(_buf.buffer, _buf.byteOffset, n >> 1);
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Generic scan (rare paths only). Reads an unquoted field starting at
  // `start`, with `prefix` already kept (null / '"' / quoted value).
  // `seg`/`added` carry a first segment when the caller already kept one.
  // Returns via SLOW_OUT; pushes stray_cr errors as met.
  function slowScan(prefix, start, seg, added) {
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

  while (true) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
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
      if (u16[pos] === 34) {
        // ---- Quoted field (same semantics as v4).
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        let seg = null;
        let segStart = pos;
        let scan = pos;
        let close = -1;
        while (true) {
          const q = text.indexOf('"', scan);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            seg = seg === null ? text.slice(segStart, q) + '"' : seg + text.slice(segStart, q) + '"';
            scan = q + 2;
            segStart = q + 2;
            continue;
          }
          close = q;
          break;
        }
        if (close === -1) {
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = slowScan('"', pos, null, 0);
          value = r.value; ended = r.ended; pos = r.next; line += r.lineBump;
        } else {
          let qval;
          if (seg === null) {
            qval = text.slice(open + 1, close);
            if (qval.indexOf('\n') !== -1 || qval.indexOf('\r') !== -1) {
              let hasCR = false;
              let breaks = 0;
              for (let t = open + 1; t < close; t++) {
                const c = u16[t];
                if (c === 10) breaks += 1;
                else if (c === 13) { hasCR = true; if (u16[t + 1] !== 10) breaks += 1; }
              }
              if (hasCR) qval = qval.replace(/\r\n?/g, '\n');
              line += breaks;
            }
          } else {
            qval = seg + text.slice(segStart, close);
            if (qval.indexOf('\r') !== -1) qval = qval.replace(/\r\n?/g, '\n');
            if (qval.indexOf('\n') !== -1) {
              let k = 0;
              let i = -1;
              while ((i = qval.indexOf('\n', i + 1)) !== -1) k += 1;
              line += k;
            }
          }
          pos = close + 1;
          if (pos >= n) { value = qval; ended = END; }
          else {
            const c = text.charCodeAt(pos);
            if (c === 44) { pos += 1; value = qval; ended = COMMA; }
            else if (c === 10) { pos += 1; line += 1; value = qval; ended = LINE_BREAK; }
            else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; value = qval; ended = LINE_BREAK; }
            else {
              const r = slowScan(qval, pos, null, 0);
              value = r.value; ended = r.ended; pos = r.next; line += r.lineBump;
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        // ---- FAST: plain unquoted field. One u32 scan + one slice.
        quoted = false;
        let j = pos;
        let c = 0;
        while (j < n) {
          if ((j & 1) === 1) {
            c = u16[j];
            if (c === 44 || c === 10 || c === 13) break;
            j += 1;
            continue;
          }
          if (j + 1 >= n) {
            c = u16[j];
            if (c === 44 || c === 10 || c === 13) break;
            j += 1;
            break;
          }
          const w = u32[j >> 1];
          const lo = w & 0xffff;
          if (lo === 44 || lo === 10 || lo === 13) { c = lo; break; }
          const hi = w >>> 16;
          if (hi === 44 || hi === 10 || hi === 13) { c = hi; j += 1; break; }
          j += 2;
        }
        if (j >= n) { value = text.slice(pos, j); ended = END; pos = n; }
        else if (c === 44) { value = text.slice(pos, j); ended = COMMA; pos = j + 1; }
        else if (c === 10) { value = text.slice(pos, j); ended = LINE_BREAK; pos = j + 1; line += 1; }
        else if (u16[j + 1] === 10) { value = text.slice(pos, j); ended = LINE_BREAK; pos = j + 2; line += 1; }
        else {
          // Stray CR at j: slow scan from j+1, first segment already kept.
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          const r = slowScan(null, j + 1, [text.slice(pos, j)], j - pos);
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
