/**
 * 全データの Excel 出力と、Excel からの取り込み（旧スプレッドシートからの移行・復元）
 * シート名＝テーブル名、1行目＝列名（core/schema.js と同じ）。列の並びは問わない
 */
const ExcelJS = require('exceljs');

async function exportXlsx(tables, schema) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'デジプル勤怠';
  for (const [name, cols] of Object.entries(schema)) {
    const ws = wb.addWorksheet(name);
    ws.addRow(cols.map(c => c[0]));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of tables[name] || []) ws.addRow(cols.map(([c, t]) => (r[c] == null || r[c] === '') ? null : (t === 'b' ? !!r[c] : r[c])));
    cols.forEach(([c], i) => { ws.getColumn(i + 1).width = Math.min(40, Math.max(10, c.length + 2)); });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
/** Excel のセル値を文字列・数値・真偽値へ（日付・時刻はスプレッドシートの自動変換を戻す） */
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    if (v.getUTCFullYear() <= 1900) return v.getUTCHours() + ':' + pad(v.getUTCMinutes());
    const d = v.getUTCFullYear() + '-' + pad(v.getUTCMonth() + 1) + '-' + pad(v.getUTCDate());
    if (!v.getUTCHours() && !v.getUTCMinutes() && !v.getUTCSeconds()) return d;
    // 日時（日本時間で記録した値として扱う）
    return d + 'T' + pad(v.getUTCHours()) + ':' + pad(v.getUTCMinutes()) + ':' + pad(v.getUTCSeconds()) + '+09:00';
  }
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('richText' in v) return v.richText.map(x => x.text).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.hyperlink);
  }
  return v;
}

/** @returns {{ tables: {name: rows[]}, skipped: string[], unknownColumns: {} }} */
async function parseXlsx(buf, schema) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const tables = {}, skipped = [], unknownColumns = {};
  wb.worksheets.forEach(ws => {
    const name = ws.name.trim();
    if (!schema[name]) { skipped.push(name); return; }
    const head = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { head[col] = String(cellValue(cell.value)).trim(); });
    const known = new Set(schema[name].map(c => c[0]));
    const unk = head.filter(h => h && !known.has(h));
    if (unk.length) unknownColumns[name] = unk;
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (r === 1) return;
      const o = {}; let any = false;
      head.forEach((h, col) => {
        if (!h || !known.has(h)) return;
        const v = cellValue(row.getCell(col).value);
        if (v !== '' && v != null) any = true;
        o[h] = v;
      });
      if (any) rows.push(o);
    });
    tables[name] = rows;
  });
  return { tables, skipped, unknownColumns };
}

module.exports = { exportXlsx, parseXlsx, cellValue };
