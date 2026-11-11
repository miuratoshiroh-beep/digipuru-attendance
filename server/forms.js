/**
 * 帳票『勤務表兼残業表』を Excel に転記し、LibreOffice で計算・PDF化する
 *  1. 社員ごとに template/form_template.xlsx を読み、転記した「原本」と、1〜15日・16日〜月末の「印刷用」2枚を作る
 *  2. 原本を LibreOffice で開き直して数式を計算させ、当月残業時間（R49）・当月割増（T49）を読み戻してシステムの値と照合
 *  3. 差異がなければ印刷用を PDF にして1つにまとめる（A4横2枚／人）
 *  4. 原本（計算済み）は社員ごとの .xlsx を zip にまとめる
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ExcelJS = require('exceljs');
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');

const TEMPLATE = process.env.FORM_TEMPLATE || path.join(__dirname, '..', 'template', 'form_template.xlsx');
const SOFFICE = process.env.SOFFICE_PATH || 'soffice';

// LibreOffice の利用者プロファイル（xlsx を開くとき必ず再計算する設定）
const PROFILE_DIR = path.join(os.tmpdir(), 'attendance-lo-profile');
function ensureProfile() {
  const f = path.join(PROFILE_DIR, 'user', 'registrymodifications.xcu');
  if (fs.existsSync(f)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`);
}

// LibreOffice は同時に1つだけ動かす
let loQueue = Promise.resolve();
function soffice(args, cwd) {
  const p = loQueue.then(() => new Promise((resolve, reject) => {
    ensureProfile();
    execFile(SOFFICE, ['-env:UserInstallation=file://' + PROFILE_DIR, '--headless', '--norestore', ...args], { cwd, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) reject(new Error('LibreOffice の実行に失敗しました：' + (stderr || err.message)));
      else resolve(stdout);
    });
  }));
  loQueue = p.catch(() => {});
  return p;
}

const DAY = m => m / 1440;   // 分 → Excel の時刻値

function fill(ws, model, map) {
  const h = model.header, ym = h.month.slice(0, 7);
  const set = (item, v) => { if (map[item]) ws.getCell(map[item].row, map[item].col).value = (v === '' || v == null) ? null : v; };
  set('month', new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1)));
  set('division', h.division);
  set('section', h.section);
  set('emp_no', h.empNo);
  set('name', h.name);
  set('sched', DAY(h.schedMin));
  const column = (item, fn) => {
    if (!map[item]) return;
    for (let i = 0; i < 31; i++) {
      const d = model.days[i];
      const v = d ? fn(d) : '';
      ws.getCell(map[item].row + i, map[item].col).value = (v === '' || v == null) ? null : v;
    }
  };
  column('day_mark', d => d.mark);
  column('pre_start', d => d.preStart == null ? '' : DAY(d.preStart));
  column('pre_end', d => d.preEnd == null ? '' : DAY(d.preEnd));
  column('pre_reason', d => d.preReason);
  column('pre_stamp', d => d.preStamp);
  column('attendance', d => d.attendance);
  column('paid_days', d => d.paidDays == null ? '' : d.paidDays);
  column('other_days', d => d.otherDays == null ? '' : d.otherDays);
  column('work_start', d => d.a == null ? '' : DAY(d.a));
  column('work_end', d => d.b == null ? '' : DAY(d.b));
  column('extra_break', d => d.c ? DAY(d.c) : '');
  column('night_w40', d => d.t ? DAY(d.t) : '');
  column('note', d => d.note);
  if (model.mode === 'deemed') {
    // 裁量労働・管理職は見做し時間を値で書く（数式を上書き）
    column('ot_day', d => d.r == null ? '' : DAY(d.r));
    column('ot_cum', d => d.rCum == null ? '' : DAY(d.rCum));
  } else if (model.mode === 'flex') {
    // フレックスは日別の④を空欄にし、当月残業時間に月の法定総枠超過を値で書く
    column('ot_day', () => '');
    column('ot_cum', () => '');
    ws.getCell(map.total_ot.row, map.total_ot.col).value = Math.round(model.totals.formOt / 6) / 10;
  }
}

/** 印刷範囲（E1:X50）の外と、もう一方のページの日付行を隠す */
function pageOnly(ws, layout, hideFrom, hideTo) {
  for (let c = 1; c < layout.firstCol; c++) ws.getColumn(c).hidden = true;
  for (let c = layout.lastCol + 1; c <= Math.max(ws.columnCount, layout.lastCol + 20); c++) ws.getColumn(c).hidden = true;
  for (let r = layout.lastRow + 1; r <= Math.max(ws.rowCount, layout.lastRow + 60); r++) ws.getRow(r).hidden = true;
  for (let r = hideFrom; r <= hideTo; r++) ws.getRow(r).hidden = true;
  Object.assign(ws.pageSetup, { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 1 });
  ws.pageSetup.printTitlesRow = undefined;
}

async function workbookFor(job, layout, map) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.getWorksheet(layout.sheet);
  if (!ws) throw Object.assign(new Error('帳票テンプレートにシート「' + layout.sheet + '」がありません'), { userFacing: true });
  // 転記先以外のシート（入力例など）は消す
  wb.worksheets.filter(s => s.id !== ws.id).forEach(s => wb.removeWorksheet(s.id));
  fill(ws, job.model, map);
  return { wb, ws };
}

function cellNumber(cell) {
  const v = cell.value;
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in v) return Number(v.result) || 0;
  return Number(v) || 0;
}

function safe(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_'); }

async function zipFiles(entries) {
  return new Promise((resolve, reject) => {
    const z = archiver('zip', { zlib: { level: 9 } }), bufs = [];
    z.on('data', b => bufs.push(b));
    z.on('end', () => resolve(Buffer.concat(bufs)));
    z.on('error', reject);
    entries.forEach(e => z.append(e.data, { name: e.name }));
    z.finalize();
  });
}

/**
 * @param {object} job  core の Form.prepare の戻り値
 * @returns {{name, results, stopped, xlsx: Buffer, pdf: Buffer|null}}
 */
async function render(job, verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-'));
  try {
    const { layout, map } = job;
    const full = [], pages = [];
    for (let i = 0; i < job.jobs.length; i++) {
      const j = job.jobs[i], base = 'e' + String(i).padStart(3, '0');
      { const { wb } = await workbookFor(j, layout, map); await wb.xlsx.writeFile(path.join(dir, base + '_full.xlsx')); full.push(base + '_full.xlsx'); }
      { const { wb, ws } = await workbookFor(j, layout, map); pageOnly(ws, layout, layout.page1LastRow + 1, layout.firstDayRow + 30); await wb.xlsx.writeFile(path.join(dir, base + '_p1.xlsx')); }
      { const { wb, ws } = await workbookFor(j, layout, map); pageOnly(ws, layout, layout.firstDayRow, layout.page1LastRow); await wb.xlsx.writeFile(path.join(dir, base + '_p2.xlsx')); }
      pages.push(base + '_p1.xlsx', base + '_p2.xlsx');
    }
    // 1) 原本を計算し直して読み戻す
    fs.mkdirSync(path.join(dir, 'calc'));
    await soffice(['--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', 'calc', ...full], dir);
    const results = [], zipEntries = [];
    for (let i = 0; i < job.jobs.length; i++) {
      const j = job.jobs[i], file = path.join(dir, 'calc', full[i]);
      if (!fs.existsSync(file)) throw new Error('帳票の計算に失敗しました（' + j.name + '）');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      const ws = wb.getWorksheet(layout.sheet) || wb.worksheets[0];
      const r49 = cellNumber(ws.getCell(map.total_ot.row, map.total_ot.col));
      const t49 = cellNumber(ws.getCell(map.total_premium.row, map.total_premium.col));
      results.push({ emp_id: j.emp_id, name: j.name, mode: j.model.mode, problems: verify(j.model, r49, t49), r49, t49 });
      zipEntries.push({ name: safe(job.name + '_' + j.label) + '.xlsx', data: fs.readFileSync(file) });
    }
    const stopped = results.some(r => r.problems.length > 0);
    // 1人なら .xlsx、複数なら社員ごとの .xlsx を zip にまとめる
    const single = zipEntries.length === 1;
    const xlsx = single ? zipEntries[0].data : await zipFiles(zipEntries);
    // 2) 差異がなければPDF
    let pdf = null;
    if (!stopped) {
      fs.mkdirSync(path.join(dir, 'pdf'));
      await soffice(['--convert-to', 'pdf', '--outdir', 'pdf', ...pages], dir);
      const out = await PDFDocument.create();
      for (const p of pages) {
        const f = path.join(dir, 'pdf', p.replace(/\.xlsx$/, '.pdf'));
        if (!fs.existsSync(f)) throw new Error('PDFの作成に失敗しました（' + p + '）');
        const src = await PDFDocument.load(fs.readFileSync(f));
        (await out.copyPages(src, src.getPageIndices())).forEach(pg => out.addPage(pg));
      }
      out.setTitle(job.name);
      pdf = Buffer.from(await out.save());
    }
    return { name: job.name, results, stopped, xlsx, xlsxExt: single ? 'xlsx' : 'zip', pdf };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { render, fill, pageOnly, TEMPLATE };
