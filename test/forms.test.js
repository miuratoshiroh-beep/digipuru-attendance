/**
 * 帳票の転記・計算・照合・PDF（LibreOffice があるときだけ）
 */
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const ExcelJS = require('exceljs');
const { createGas } = require('./harness');
const { seed } = require('./seed');
const forms = require('../server/forms');

let hasLo = true;
try { execSync('which soffice', { stdio: 'ignore' }); } catch (e) { hasLo = false; }
const d = hasLo ? describe : describe.skip;
const at = (d, t) => d + 'T' + t + ':00+09:00';

d('帳票（LibreOffice）', () => {
  function october() {
    const g = createGas(); seed(g);
    const C = g.ctx.Calc, R = C.normalizeRules({}), H = { '2026-10-12': { kind: 'company' } };
    C.monthDays('2026-10').forEach(day => {
      if (C.dayType(day, R, H) !== 'work') return;
      ['sasaki.ryo', 'kobayashi.misaki', 'hasegawa.takumi'].forEach(u => {
        g.as(u + '@g.takayoshi.co.jp').at(at(day, '08:25')).call('apiPunch', 'IN');
        g.at(at(day, day === '2026-10-05' ? '20:00' : '17:35')).call('apiPunch', 'OUT');
      });
    });
    g.direct(c => c.Repo.append('requests', [{ req_id: 'RX', emp_id: 'E002', kind: 'pre', work_date: '2026-10-05', pre_start: '', pre_end: '20:00', status: 'approved', reason: '撮影準備', approver_name: '課長', decided_at: '2026-10-02T09:00:00+09:00' }]));
    return g;
  }
  test('固定・フレックス・裁量の3人：照合が一致し、PDFは1人2ページ、Excelはzip', async () => {
    const g = october();
    const job = g.as('admin@g.takayoshi.co.jp').at(at('2026-11-10', '09:00')).call('apiBuildForms', '2026-10', 'ALL').job;
    job.jobs = job.jobs.filter(j => ['E002', 'E003', 'E004'].includes(j.emp_id));
    const out = await forms.render(job, (m, r, t) => g.ctx.Form.verify(m, r, t));
    expect(out.results.map(r => [r.emp_id, r.mode, r.problems])).toEqual([['E002', 'formula', []], ['E003', 'flex', []], ['E004', 'deemed', []]]);
    const sasaki = out.results[0];
    expect(sasaki.r49).toBeCloseTo(2.5, 5);   // 10/5 8:30〜20:00 → ④2:30
    expect(out.stopped).toBe(false);
    expect(out.xlsxExt).toBe('zip');
    const pdf = await PDFDocument.load(out.pdf);
    expect(pdf.getPageCount()).toBe(6);
    const saved = g.call('formsSaved_', '2026-10', out);
    expect(saved.pdfUrl).toMatch(/^\/files\//);
    expect(g.state.files.map(f => f.name)).toEqual(['勤務表兼残業表_2026-10.zip', '勤務表兼残業表_2026-10.pdf']);
  }, 120000);
  test('1人分は計算済みの .xlsx。転記した値が入っている', async () => {
    const g = october();
    const job = g.as('admin@g.takayoshi.co.jp').at(at('2026-11-10', '09:00')).call('apiBuildForms', '2026-10', 'E002').job;
    const out = await forms.render(job, (m, r, t) => g.ctx.Form.verify(m, r, t));
    expect(out.xlsxExt).toBe('xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.xlsx);
    const ws = wb.getWorksheet('入力用');
    const v = a => { const x = ws.getCell(a).value; return x && typeof x === 'object' && 'result' in x ? x.result : x; };
    expect([v('S7'), v('V7'), v('I18'), v('K18')]).toEqual(['701', '佐々木 遼', '撮影準備', '課長 10/2']);
    const min = a => { const x = v(a); return x instanceof Date ? Math.round((x - Date.UTC(1899, 11, 30)) / 60000) : Math.round(x * 1440); };
    expect([min('O18'), min('P18'), min('R18')]).toEqual([510, 1200, 150]);   // 8:30〜20:00、④2:30
  }, 120000);
  test('照合で差異があればPDFを作らない', async () => {
    const g = october();
    const job = g.as('admin@g.takayoshi.co.jp').at(at('2026-11-10', '09:00')).call('apiBuildForms', '2026-10', 'E002').job;
    job.jobs[0].model.totals.formOt += 60;   // システム側の値をずらす
    const out = await forms.render(job, (m, r, t) => g.ctx.Form.verify(m, r, t));
    expect(out.stopped).toBe(true);
    expect(out.pdf).toBeNull();
    expect(out.results[0].problems[0]).toMatch(/当月残業時間：帳票 2\.50h／システム 3\.50h/);
  }, 120000);
});
