// Minimal .xlsx reader (no dependencies): unzips the workbook with Node's zlib and reads one worksheet's
// cells as written in the file (text, numbers, and the cached result of formulas). Used to import price books
// and to verify an imported price book against the spreadsheet it came from.
import fs from 'node:fs';
import zlib from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (zip directory not found).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .xlsx file (bad zip entry).');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

/**
 * Read a worksheet. Returns { sheet, rows: [{ row, cells: { A: value, ... }, formulas: { I: 'SUM(B3:H3)' } }] }.
 * Values are exactly as stored: strings for text, numbers for numbers (no rounding).
 */
export function readXlsx(file, sheetName = null) {
  const files = unzip(Buffer.isBuffer(file) ? file : fs.readFileSync(file)); // a path or the file's bytes (upload)
  const read = (name) => { const f = files.get(name); if (!f) throw new Error(`Missing ${name} in the workbook.`); return f(); };
  const workbook = read('xl/workbook.xml');
  const sheets = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: decode(m[1]), rid: m[2] }));
  const chosen = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (!chosen) throw new Error(`Sheet "${sheetName}" not found.`);
  const rels = read('xl/_rels/workbook.xml.rels');
  const target = (new RegExp(`<Relationship [^>]*Id="${chosen.rid}"[^>]*Target="([^"]+)"`).exec(rels)
    || new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${chosen.rid}"`).exec(rels))[1];
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;

  const strings = files.has('xl/sharedStrings.xml')
    ? [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))
    : [];
  const xml = read(sheetPath);
  const rows = [];
  for (const rm of xml.matchAll(/<row [^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = {}, formulas = {};
    for (const cm of (rm[2] || '').matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = cm[1], attrs = cm[2], inner = cm[3] || '';
      const type = (/ t="(\w+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      const f = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner);
      if (f) formulas[col] = decode(f[1]);
      else if (/<f [^>]*\/>/.test(inner)) formulas[col] = '(shared formula)';
      let value;
      if (type === 's') value = strings[Number(v)];
      else if (type === 'inlineStr') value = decode(((/<is>[\s\S]*?<t(?: [^>]*)?>([\s\S]*?)<\/t>/.exec(inner)) || [])[1] || '');
      else if (type === 'str') value = v == null ? '' : decode(v);
      else if (type === 'b') value = v === '1';
      else if (type === 'e') value = `#ERROR ${v}`;
      else if (v != null) value = Number(v);
      if (value !== undefined && value !== '') cells[col] = value;
    }
    if (Object.keys(cells).length) rows.push({ row: Number(rm[1]), cells, formulas });
  }
  return { sheet: chosen.name, rows };
}
