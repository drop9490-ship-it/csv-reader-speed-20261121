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
// Speed: a single-pass scanner. Unquoted fields are scanned for their delimiter
// one character at a time (a single range check per character) but built with
// one slice (no per-character string building); quoted fields are found with
// indexOf('"') and the same slice fast path. Slow paths run only where the data
// forces them: stray CRs inside a field, doubled quotes, and CR/LF inside a
// quoted field. No allocation per character, no per-field array unless a field
// is actually broken.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Reads an unquoted field starting at pos, appending to `prefix` (null for a
  // plain field, the quoted value for the junk after a closing quote, '"' for
  // the re-read after a quote that never closes). Returns {value, ended, added}
  // where `added` counts the characters this scan kept (the junk detector's
  // measure). Pushes stray_cr errors as met, in order. Scans for the next
  // delimiter one character at a time but builds the field with a single slice,
  // so no string is ever built up a character at a time.
  function scanUnquoted(prefix) {
    let seg = null; // segments when a stray CR was dropped
    let added = 0;
    let vstart = pos;
    let i = pos;
    while (true) {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c < 45 && (c === 44 || c === 10 || c === 13)) break;
        j += 1;
      }
      const tail = text.slice(vstart, j);
      added += j - vstart;
      const value = seg === null ? (prefix === null ? tail : prefix + tail) : (prefix === null ? seg.join('') + tail : prefix + seg.join('') + tail);
      if (j >= n) return { value, ended: END, added, next: n };
      const c = text.charCodeAt(j);
      if (c === 44) return { value, ended: COMMA, added, next: j + 1 };
      if (c === 10) return { value, ended: LINE_BREAK, added, next: j + 1, lineBump: 1 };
      if (text.charCodeAt(j + 1) === 10) return { value, ended: LINE_BREAK, added, next: j + 2, lineBump: 1 };
      // A CR not followed by LF is dropped (stray_cr); the field goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (seg === null) seg = [tail];
      else seg.push(tail);
      i = j + 1;
      vstart = j + 1;
    }
  }

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
    const fields = [];
    let ended;
    let quoted = false;
    do {
      let value;
      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        // Find the closing quote; '""' is one literal quote.
        let seg = null; // string segments when doubled quotes occur
        let segStart = pos; // start of the current literal run
        let scan = pos;
        let close = -1;
        while (true) {
          const q = text.indexOf('"', scan);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            if (seg === null) seg = [];
            seg.push(text.slice(segStart, q), '"');
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
          const r = scanUnquoted('"');
          value = r.value;
          ended = r.ended;
          pos = r.next;
          line += r.lineBump || 0;
        } else {
          let qval;
          if (seg === null) qval = text.slice(open + 1, close);
          else {
            seg.push(text.slice(segStart, close));
            qval = seg.join('');
          }
          // Each CRLF or lone CR inside quotes is read as LF; count every
          // line break the field held so the next record starts on its line.
          if (qval.indexOf('\r') !== -1) qval = qval.replace(/\r\n?/g, '\n');
          if (qval.indexOf('\n') !== -1) {
            let k = 0;
            let i = -1;
            while ((i = qval.indexOf('\n', i + 1)) !== -1) k += 1;
            line += k;
          }
          pos = close + 1;
          if (pos >= n) {
            value = qval;
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              value = qval;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              value = qval;
              ended = LINE_BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              value = qval;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up to
              // the next comma or line break.
              const r = scanUnquoted(qval);
              value = r.value;
              ended = r.ended;
              pos = r.next;
              line += r.lineBump || 0;
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        // An unquoted field.
        quoted = false;
        const r = scanUnquoted(null);
        value = r.value;
        ended = r.ended;
        pos = r.next;
        line += r.lineBump || 0;
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
