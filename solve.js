// Fast csv-reader 1.0.0-compatible CSV reader.
//
// Semantics: exactly csv-reader 1.0.0 (make.fun's own reader, derived from
// d3-dsv 3.0.2's parseRows and papaparse 5.7.1's errors idea). For every input
// {text, header} run() returns the same {columns, rows, errors} the reference
// returns, code unit for code unit:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character, and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its field count) or cut (long_row, with extra: the
//     cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record
//     ends: line the 1-based line its record starts on (every LF, CRLF and lone
//     CR inside a quoted field counted), row its record's index in rows (null
//     for the header).
//
// v4 — speed notes (all measured Node 22, 1 CPU, practice set 10.2 MB):
//   - UTF-16 code units as a Uint16Array (Buffer.from utf16le) + a Uint32Array
//     view: the fast unquoted scan reads 2 code units per iteration.
//   - fast/slow split: a plain unquoted field (>99% of fields) is one inline
//     scan + one slice, no prefix/segment bookkeeping; the generic slow scan
//     runs only for quote junk, unterminated quotes, or stray CRs (<1%).
//   - fields array preallocated (new Array(width), filled by index): the
//     single biggest win vs v3 (push-growth was ~40% of v3's time).
//   - doubled quotes accumulated with string concat (ConsString), not array+join.
//   - quoted-value CR/LF counted in one guarded u16 pass (skipped when the
//     value holds no line break, ~91% of quoted fields).

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
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

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
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
      let prefix = null;
      let junkCheck = false;
      let needScan = true;
      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        // Find the closing quote; '""' is one literal quote.
        let seg = null; // accumulated value when doubled quotes occur (concat, no array)
        let segStart = pos; // start of the current literal run
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
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          prefix = '"';
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
          if (pos >= n) {
            value = qval;
            ended = END;
            needScan = false;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              value = qval;
              ended = COMMA;
              needScan = false;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              value = qval;
              ended = LINE_BREAK;
              needScan = false;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              value = qval;
              ended = LINE_BREAK;
              needScan = false;
            } else {
              // What follows the closing quote is appended as it stands, up to
              // the next comma or line break.
              prefix = qval;
              junkCheck = true;
            }
          }
        }
      } else {
        // An unquoted field.
        quoted = false;
      }
      if (needScan) {
        // Setup for the slow generic scan; the fast path below clears
        // slowFlag when it finishes the field on its own.
        let slowFlag = true;
        let slowPrefix = prefix;
        let slowSeg = null;
        let slowAdded = 0;
        let slowI = pos;
        let slowVstart = pos;
        if (prefix === null) {
          // ---- FAST: plain unquoted field. No prefix, no segments yet:
          // the value is one slice, no construction ternary, no `added`.
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
          const tail = j === pos ? '' : text.slice(pos, j);
          if (j >= n) { value = tail; ended = END; pos = n; slowFlag = false; }
          else if (c === 44) { value = tail; ended = COMMA; pos = j + 1; slowFlag = false; }
          else if (c === 10) { value = tail; ended = LINE_BREAK; pos = j + 1; line += 1; slowFlag = false; }
          else if (u16[j + 1] === 10) { value = tail; ended = LINE_BREAK; pos = j + 2; line += 1; slowFlag = false; }
          else {
            // Stray CR at j: the field goes on via the slow scan, with the
            // first segment (tail) already kept.
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            slowSeg = [tail];
            slowAdded = j - pos;
            slowI = j + 1;
            slowVstart = j + 1;
          }
        }
        if (slowFlag) {
          // ---- SLOW: generic scan (prefix != null, or a stray CR was met).
          // Same shape as v2's scanUnquoted, all locals, no closure.
          let seg = slowSeg;
          let added = slowAdded;
          let vstart = slowVstart;
          let i = slowI;
          const prefix = slowPrefix;
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
            if (j >= n) { value = v; ended = END; pos = n; break; }
            if (c === 44) { value = v; ended = COMMA; pos = j + 1; break; }
            if (c === 10) { value = v; ended = LINE_BREAK; pos = j + 1; line += 1; break; }
            if (text.charCodeAt(j + 1) === 10) { value = v; ended = LINE_BREAK; pos = j + 2; line += 1; break; }
            // A CR not followed by LF is dropped (stray_cr); the field goes on.
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (seg === null) seg = [tail];
            else seg.push(tail);
            i = j + 1;
            vstart = j + 1;
          }
          if (junkCheck && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }
      fields[fi++] = value;
    } while (ended === COMMA);
    fields.length = fi;

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
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
