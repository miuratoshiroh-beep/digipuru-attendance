// 固定時間制のシステム計算（④当日・累計）が、帳票『勤務表兼残業表』の数式と一致することを確認する
// 帳票の数式：AF=Q+B10、AE=P-O-AF、R=IF(AE>B9,AE-B9,0)、S=SUM(R14:R)
const Calc = require('../core/calc');

const R = Calc.normalizeRules({});
const AG = Calc.normalizeAgreement({});
const HOL = { '2026-10-12': { kind: 'company', name: 'スポーツの日' } };

function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function randomMonth(seed, opts = {}) {
  const r = rng(seed), inputs = {};
  Calc.monthDays('2026-10').forEach(d => {
    const t = Calc.dayType(d, R, HOL);
    if (t !== 'work' && r() > 0.15) return;
    if (r() < 0.06) { inputs[d] = { leaveType: 'paid_full' }; return; }
    const early = r() < 0.15;
    const inn = early ? 420 + Math.floor(r() * 60) : 500 + Math.floor(r() * 40);
    const out = 1050 + Math.floor(r() * 300) - 20;
    const inp = { in: inn, out };
    if (early) inp.preStart = 420;
    if (out > 1065) { if (r() < 0.8) inp.preEnd = Math.ceil(out / 30) * 30; else { inp.deviation = 'non_work'; inp.deviationNote = '業後雑談'; } }
    if (r() < 0.1) { inp.extraBreak = 30 + Math.floor(r() * 4) * 15; inp.extraBreakNote = '私用'; }
    if (opts.halfDays && r() < 0.08) { inp.leaveType = 'paid_pm'; inp.out = 720; delete inp.preEnd; delete inp.deviation; }
    inputs[d] = inp;
  });
  return inputs;
}

describe('帳票の計算式との一致（固定時間制）', () => {
  for (let seed = 1; seed <= 40; seed++) {
    test(`ランダムな月 #${seed}`, () => {
      const e = Calc.normalizeEmployee({ emp_id: 'E', work_type: 'fixed' });
      const m = Calc.calcMonth(e, '2026-10', randomMonth(seed, { halfDays: seed % 3 === 0 }), R, HOL, '2026-11-10', AG);
      const model = Calc.formModel(e, m, {});
      const em = Calc.emulateFormR(model, R.lunch_min);
      let cum = 0;
      m.rows.forEach((c, i) => {
        const worked = model.days[i].a != null;
        if (!worked) { expect(em[i].r).toBeNull(); return; }
        cum += c.formR;
        expect(em[i].r).toBe(c.formR);
        expect(em[i].s).toBe(cum);
      });
      expect(cum).toBe(m.totals.formOt);
    });
  }
  test('時短（所定6時間）でも一致', () => {
    const e = Calc.normalizeEmployee({ emp_id: 'E', work_type: 'fixed', sched_start: '9:00', sched_end: '16:00', sched_min: 360 });
    const inputs = { '2026-10-07': { in: 540, out: 1020, preEnd: 1020 }, '2026-10-08': { in: 540, out: 960 } };
    const m = Calc.calcMonth(e, '2026-10', inputs, R, HOL, '2026-11-10', AG);
    const em = Calc.emulateFormR(Calc.formModel(e, m, {}), R.lunch_min);
    const i7 = m.rows.findIndex(c => c.date === '2026-10-07');
    expect(em[i7].r).toBe(m.rows[i7].r);
    expect(m.rows[i7].r).toBe(60);
  });
});

describe('帳票モデル', () => {
  test('見做し（裁量・管理職）は④を値で持つ、固定は数式に任せる', () => {
    const d = Calc.normalizeEmployee({ emp_id: 'D', work_type: 'disc', deemed_min: 540 });
    const m = Calc.calcMonth(d, '2026-10', { '2026-10-07': { in: 570, out: 1300 } }, R, HOL, '2026-11-10', AG);
    const fm = Calc.formModel(d, m, {});
    expect(fm.mode).toBe('deemed');
    const row = fm.days.find(x => x.date === '2026-10-07');
    expect(row.r).toBe(60);
    const f = Calc.normalizeEmployee({ emp_id: 'F', work_type: 'fixed' });
    const fm2 = Calc.formModel(f, Calc.calcMonth(f, '2026-10', { '2026-10-07': { in: 510, out: 1200, preEnd: 1200 } }, R, HOL, '2026-11-10', AG), {});
    expect(fm2.mode).toBe('formula');
    expect(fm2.days.find(x => x.date === '2026-10-07').r).toBeNull();
  });
  test('休日に○、休暇の出勤状況・日数、承認印、深夜・週40時間超', () => {
    const f = Calc.normalizeEmployee({ emp_id: 'F', work_type: 'fixed' });
    const inputs = {
      '2026-10-05': { leaveType: 'paid_full' },
      '2026-10-06': { in: 510, out: 1350, preEnd: 1350, preReason: 'トラブル対応', preApprover: '三浦 10/6' },
      '2026-10-07': { leaveType: 'other_full' }
    };
    const fm = Calc.formModel(f, Calc.calcMonth(f, '2026-10', inputs, R, HOL, '2026-11-10', AG), { printApprover: true });
    const g = d => fm.days.find(x => x.date === d);
    expect(g('2026-10-04').mark).toBe('○');
    expect([g('2026-10-05').attendance, g('2026-10-05').paidDays]).toEqual(['有給休暇', 1]);
    expect([g('2026-10-07').attendance, g('2026-10-07').otherDays]).toEqual(['その他の休', 1]);
    expect([g('2026-10-06').preEnd, g('2026-10-06').preReason, g('2026-10-06').preStamp]).toEqual([1350, 'トラブル対応', '三浦 10/6']);
    expect(g('2026-10-06').t).toBe(30);
  });
});
