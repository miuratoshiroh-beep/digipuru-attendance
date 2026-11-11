const Calc = require('../core/calc');

const R = Calc.normalizeRules({});
const AG = Calc.normalizeAgreement({});
const HOL = { '2026-10-12': { kind: 'company', name: 'スポーツの日' }, '2026-11-03': { kind: 'company', name: '文化の日' }, '2026-11-23': { kind: 'company', name: '勤労感謝の日' } };
const T = (h, m) => h * 60 + m;
const TODAY = '2026-11-10';
const emp = (o) => Calc.normalizeEmployee(Object.assign({ emp_id: 'E1', name: 'テスト', work_type: 'fixed' }, o));
const FIX = emp({});
const FLEX = emp({ work_type: 'flex' });
const DISC = emp({ work_type: 'disc', deemed_min: 480, limit_class: 'restricted' });
const day = (e, d, inp) => Calc.calcDay(e, d, inp, R, HOL, TODAY);
// 2026-10-07（水）は平日、10-10（土）所定休日、10-11（日）法定休日、10-12（月）祝日

describe('日種別', () => {
  test('平日・土曜・日曜・祝日', () => {
    expect(Calc.dayType('2026-10-07', R, HOL)).toBe('work');
    expect(Calc.dayType('2026-10-10', R, HOL)).toBe('company');
    expect(Calc.dayType('2026-10-11', R, HOL)).toBe('legal');
    expect(Calc.dayType('2026-10-12', R, HOL)).toBe('company');
  });
  test('休日カレンダーで出勤日に上書きできる', () => {
    expect(Calc.dayType('2026-10-10', R, { '2026-10-10': { kind: 'work' } })).toBe('work');
  });
});

describe('固定時間制', () => {
  test('定時 8:30〜17:30 は実労働8:00・残業0', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 25), out: T(17, 30) });
    expect([c.a, c.b, c.lunch, c.work, c.r]).toEqual([T(8, 30), T(17, 30), 60, 480, 0]);
    expect(c.flags).toEqual([]);
  });
  test('始業前の打刻は事前申請がなければ8:30から', () => {
    const c = day(FIX, '2026-10-07', { in: T(7, 50), out: T(17, 30) });
    expect(c.a).toBe(T(8, 30));
  });
  test('早出申請7:00があれば打刻（6:50）ではなく7:00から', () => {
    const c = day(FIX, '2026-10-07', { in: T(6, 50), out: T(17, 30), preStart: T(7, 0) });
    expect(c.a).toBe(T(7, 0));
    expect(c.r).toBe(90);
  });
  test('早出申請7:00で打刻7:20なら30分単位に切り上げて7:30から', () => {
    const c = day(FIX, '2026-10-07', { in: T(7, 20), out: T(17, 30), preStart: T(7, 0) });
    expect(c.a).toBe(T(7, 30));
    expect(c.r).toBe(60);
  });
  test('8:45出勤は時差出勤にならない、8:46は時差出勤', () => {
    expect(day(FIX, '2026-10-07', { in: T(8, 45), out: T(17, 45) }).staggered).toBe(false);
    const c = day(FIX, '2026-10-07', { in: T(8, 46), out: T(17, 46) });
    expect(c.staggered).toBe(true);
    expect(c.note).toContain('時差出勤');
  });
  test('時差出勤10:30〜19:30は実働8時間で残業0（帳票の入力例）', () => {
    const c = day(FIX, '2026-10-07', { in: T(10, 30), out: T(19, 30), preEnd: T(19, 30) });
    expect(c.work).toBe(480);
    expect(c.r).toBe(0);
  });
  test('乖離：終業予定なしで17:59退勤はOK（残業0）、18:00退勤は乖離', () => {
    const ok = day(FIX, '2026-10-07', { in: T(8, 30), out: T(17, 59) });
    expect(ok.flags).not.toContain('DEVIATION');
    expect([ok.b, ok.r]).toEqual([T(17, 30), 0]);
    expect(day(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 0) }).flags).toContain('DEVIATION');
  });
  test('乖離：終業予定19:00で19:29はOK、19:30は乖離', () => {
    expect(day(FIX, '2026-10-07', { in: T(8, 30), out: T(19, 29), preEnd: T(19, 0) }).flags).not.toContain('DEVIATION');
    expect(day(FIX, '2026-10-07', { in: T(8, 30), out: T(19, 30), preEnd: T(19, 0) }).flags).toContain('DEVIATION');
  });
  test('残業は30分単位：18:40・18:50退勤→18:30、19:10退勤→19:00', () => {
    const b = (out, pre) => day(FIX, '2026-10-07', { in: T(8, 30), out, preEnd: pre });
    expect([b(T(18, 40), T(18, 30)).b, b(T(18, 40), T(18, 30)).r]).toEqual([T(18, 30), 60]);
    expect(b(T(18, 50), T(18, 30)).b).toBe(T(18, 30));
    expect(b(T(19, 10), T(19, 0)).b).toBe(T(19, 0));
    expect(b(T(19, 10), T(19, 0)).r).toBe(90);
  });
  test('終業予定より早く退勤した日は退勤時刻を30分単位で切り捨て（予定19:00で18:50退勤→18:30）', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 50), preEnd: T(19, 0) });
    expect(c.b).toBe(T(18, 30));
  });
  test('終業前の退勤（早退）は切り捨てない', () => {
    expect(day(FIX, '2026-10-07', { in: T(8, 30), out: T(16, 10) }).b).toBe(T(16, 10));
  });
  test('乖離を業務外と申告すると就業時間の終了は終業予定、理由は備考', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(19, 0), deviation: 'non_work', deviationNote: '退社19時 業後雑談' });
    expect(c.b).toBe(T(17, 30));
    expect(c.r).toBe(0);
    expect(c.flags).not.toContain('DEVIATION');
    expect(c.note).toBe('退社19時 業後雑談');
  });
  test('残業申請どおり20:00まで：残業2:30', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(20, 0), preEnd: T(20, 0) });
    expect(c.r).toBe(150);
  });
  test('休憩等60分は労働時間から差し引き、事由が備考に入る', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(19, 30), preEnd: T(19, 30), extraBreak: 60, extraBreakNote: '私用1時間' });
    expect(c.work).toBe(540);
    expect(c.r).toBe(60);
    expect(c.note).toBe('私用1時間');
  });
  test('22:00またぎは深夜を計上', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(23, 0), preEnd: T(23, 0) });
    expect(c.night).toBe(60);
    expect(c.r).toBe(T(23, 0) - T(8, 30) - 60 - 480);
  });
  test('日付をまたぐ退勤（翌1:30＝25:30）', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(25, 30), preEnd: T(25, 30) });
    expect(c.night).toBe(T(25, 30) - T(22, 0));
  });
  test('法定休日の出勤は休日労働で残業に含めない', () => {
    const c = day(FIX, '2026-10-11', { in: T(9, 0), out: T(15, 0) });
    expect(c.hol).toBe(300);
    expect(c.r).toBe(0);
    expect(c.note).toBe('法定休日出勤');
  });
  test('未打刻・記録なし', () => {
    expect(day(FIX, '2026-10-07', { in: T(8, 30), out: null }).flags).toContain('MISSING_OUT');
    expect(day(FIX, '2026-10-07', { in: null, out: T(17, 30) }).flags).toContain('MISSING_IN');
    expect(day(FIX, '2026-10-07', {}).flags).toContain('NO_RECORD');
    expect(day(FIX, '2026-10-10', {}).flags).toEqual([]);
    expect(day(FIX, TODAY, { in: T(8, 30) }).flags).toEqual([]);   // 当日は勤務中
  });
  test('入社前・退職後は記録なしにしない', () => {
    const e = emp({ joined_on: '2026-10-15' });
    expect(Calc.calcDay(e, '2026-10-07', {}, R, HOL, TODAY).flags).toEqual([]);
  });
  test('有給（全日）は記録なしにしない、午後休で午前出勤は実労働を計算', () => {
    expect(day(FIX, '2026-10-07', { leaveType: 'paid_full' }).flags).toEqual([]);
    const c = day(FIX, '2026-10-07', { leaveType: 'paid_pm', in: T(8, 25), out: T(12, 0) });
    expect(c.work).toBe(210);
    expect(c.leaveDays).toBe(0.5);
  });
  test('休憩不足のフラグ', () => {
    const c = day(FIX, '2026-10-10', { in: T(13, 0), out: T(20, 0) });  // 所定休日、7時間、就業時間帯6h超で昼休60控除
    expect(c.lunch).toBe(60);
    expect(c.flags).not.toContain('BREAK_SHORT');
    const d = day(FIX, '2026-10-10', { in: T(13, 0), out: T(19, 0) });  // 6時間ちょうど・昼休帯と重ならない
    expect(d.lunch).toBe(0);
    expect(d.flags).not.toContain('BREAK_SHORT');
  });
  test('修正済フラグ', () => {
    expect(day(FIX, '2026-10-07', { in: T(8, 30), out: T(17, 30), edited: true }).flags).toEqual(['EDITED']);
  });
});

describe('週40時間超（固定時間制）', () => {
  test('平日5日8時間＋土曜5時間 → 土曜の5時間が週40時間超', () => {
    const inputs = {};
    ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].forEach(d => inputs[d] = { in: T(8, 30), out: T(17, 30) });
    inputs['2026-10-10'] = { in: T(13, 0), out: T(18, 0) };
    const rows = Calc.calcRange(FIX, '2026-10-04', '2026-10-10', inputs, R, HOL, TODAY);
    const sat = rows.find(r => r.date === '2026-10-10');
    expect(sat.r).toBe(0);
    expect(sat.w40).toBe(300);
    expect(rows.reduce((s, r) => s + r.w40, 0)).toBe(300);
  });
  test('平日に有給がある週は土曜出勤しても40時間以内', () => {
    const inputs = {};
    ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].forEach(d => inputs[d] = { in: T(8, 30), out: T(17, 30) });
    inputs['2026-10-09'] = { leaveType: 'paid_full' };
    inputs['2026-10-10'] = { in: T(13, 0), out: T(18, 0) };
    const rows = Calc.calcRange(FIX, '2026-10-04', '2026-10-10', inputs, R, HOL, TODAY);
    expect(rows.reduce((s, r) => s + r.w40, 0)).toBe(0);
  });
  test('日8時間超の分は週40時間の計算から除く', () => {
    const inputs = {};
    ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].forEach(d => inputs[d] = { in: T(8, 30), out: T(19, 30), preEnd: T(19, 30) });
    const rows = Calc.calcRange(FIX, '2026-10-04', '2026-10-10', inputs, R, HOL, TODAY);
    expect(rows.reduce((s, r) => s + r.r, 0)).toBe(600);
    expect(rows.reduce((s, r) => s + r.w40, 0)).toBe(0);
  });
  test('月をまたぐ週：9/28〜10/2 の5日＋10/3（土）出勤は10月の週40時間超', () => {
    const inputs = {};
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].forEach(d => inputs[d] = { in: T(8, 30), out: T(17, 30) });
    inputs['2026-10-03'] = { in: T(9, 0), out: T(12, 0) };
    const m = Calc.calcMonth(FIX, '2026-10', inputs, R, HOL, TODAY, AG);
    expect(m.totals.w40).toBe(180);
    expect(m.rows[0].date).toBe('2026-10-01');
  });
});

describe('フレックス', () => {
  test('法定総枠：31日177:08、30日171:25、28日160:00', () => {
    const f = (ym) => Calc.calcMonth(FLEX, ym, {}, R, HOL, '2027-12-31', AG).totals.frame;
    expect(f('2026-10')).toBe(Math.floor(2400 * 31 / 7));
    expect(f('2026-11')).toBe(Math.floor(2400 * 30 / 7));
    expect(f('2027-02')).toBe(9600);
  });
  test('日次の残業は0、月の法定総枠超過が時間外（締め後の月）', () => {
    const inputs = {};
    Calc.monthDays('2026-10').forEach(d => { if (Calc.dayType(d, R, HOL) === 'work') inputs[d] = { in: T(9, 0), out: T(19, 0) }; });
    const m = Calc.calcMonth(FLEX, '2026-10', inputs, R, HOL, TODAY, AG);
    expect(m.rows.every(r => r.r === 0)).toBe(true);
    expect(m.totals.done).toBe(21 * 540);
    expect(m.totals.legalOt).toBe(21 * 540 - Math.floor(2400 * 31 / 7));
    expect(m.totals.projection).toBe(false);
  });
  test('総枠方式 workdays は所定労働日数×8時間', () => {
    const r2 = Calc.normalizeRules({ flex_frame_mode: 'workdays' });
    expect(Calc.calcMonth(FLEX, '2026-10', {}, r2, HOL, TODAY, AG).totals.frame).toBe(21 * 480);
  });
  test('当月は見込み（実績＋残り所定日×8時間）で判定', () => {
    const inputs = { '2026-11-02': { in: T(9, 0), out: T(20, 0) } };
    const m = Calc.calcMonth(FLEX, '2026-11', inputs, R, HOL, '2026-11-03', AG);
    // 11月の所定労働日 19日（11/3祝・11/23祝）。11/3以降の所定日 18日
    expect(m.totals.projection).toBe(true);
    expect(m.totals.projected).toBe(600 + 18 * 480);
  });
  test('遅刻・乖離の判定をしない', () => {
    const c = day(FLEX, '2026-10-07', { in: T(11, 0), out: T(22, 0) });
    expect(c.staggered).toBe(false);
    expect(c.flags).not.toContain('DEVIATION');
  });
});

describe('裁量労働・管理職', () => {
  test('みなし8時間なら平日の残業0、健康管理用に実労働の8時間超を記録', () => {
    const c = day(DISC, '2026-10-07', { in: T(9, 30), out: T(21, 30) });
    expect(c.r).toBe(0);
    expect(c.real).toBe(T(21, 30) - T(9, 30) - 60 - 480);
  });
  test('みなし9時間なら平日の残業1時間', () => {
    const c = day(emp({ work_type: 'disc', deemed_min: 540 }), '2026-10-07', { in: T(9, 30), out: T(15, 0) });
    expect(c.r).toBe(60);
  });
  test('所定休日は実労働を残業、法定休日は休日労働', () => {
    expect(day(DISC, '2026-10-10', { in: T(13, 0), out: T(17, 0) }).r).toBe(240);
    expect(day(DISC, '2026-10-11', { in: T(13, 0), out: T(17, 0) }).hol).toBe(240);
  });
  test('管理職も見做しで扱う', () => {
    const c = day(emp({ work_type: 'manager' }), '2026-10-07', { in: T(8, 0), out: T(21, 0) });
    expect(c.r).toBe(0);
    expect(c.real).toBeGreaterThan(0);
  });
});

describe('月次と36協定', () => {
  const monthInputs = (outH) => {
    const inputs = {};
    Calc.monthDays('2026-10').forEach(d => { if (Calc.dayType(d, R, HOL) === 'work') inputs[d] = { in: T(8, 30), out: outH, preEnd: outH }; });
    return inputs;
  };
  test('平日21日×残業2時間＝42時間で上限到達（一般）', () => {
    const m = Calc.calcMonth(FIX, '2026-10', monthInputs(T(19, 30)), R, HOL, TODAY, AG);
    expect(m.totals.r).toBe(21 * 120);
    expect(m.totals.ot36).toBe(2520);
    expect(m.totals.stage).toBe('over');
  });
  test('段階：75%注意、90%警告', () => {
    expect(Calc.stageOf(1889, 2520, AG)).toBe('normal');
    expect(Calc.stageOf(1890, 2520, AG)).toBe('caution');
    expect(Calc.stageOf(2268, 2520, AG)).toBe('warn');
    expect(Calc.stageOf(2400, 2400, AG)).toBe('over');
  });
  test('60時間超と当月割増', () => {
    const m = Calc.calcMonth(FIX, '2026-10', monthInputs(T(22, 30)), R, HOL, TODAY, AG);
    expect(m.totals.over60).toBe(m.totals.legalOt - 3600);
    expect(m.totals.premium).toBe(m.totals.night + m.totals.w40);
    expect(m.totals.night).toBe(21 * 30);
  });
  test('w40_counts_in_limit=false なら36協定の判定は④のみ', () => {
    const inputs = {};
    ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].forEach(d => inputs[d] = { in: T(8, 30), out: T(17, 30) });
    inputs['2026-10-10'] = { in: T(13, 0), out: T(18, 0) };
    const r2 = Calc.normalizeRules({ w40_counts_in_limit: 'FALSE' });
    const m = Calc.calcMonth(FIX, '2026-10', inputs, r2, HOL, TODAY, AG);
    expect(m.totals.legalOt).toBe(300);
    expect(m.totals.ot36).toBe(0);
  });
  test('有休・他の休の日数と内半日', () => {
    const inputs = { '2026-10-05': { leaveType: 'paid_full' }, '2026-10-06': { leaveType: 'paid_am', in: T(13, 0), out: T(17, 30) }, '2026-10-07': { leaveType: 'other_full' } };
    const m = Calc.calcMonth(FIX, '2026-10', inputs, R, HOL, TODAY, AG);
    expect([m.totals.paid, m.totals.paidHalf, m.totals.other, m.totals.otherHalf]).toEqual([1.5, 0.5, 1, 0]);
  });
  test('年間判定：年600h警告、上限超の月6回、単月100時間、複数月平均80時間', () => {
    const h = (ot, hol) => ({ ot36: ot, legalOt: ot, hol: hol || 0 });
    const hist = [h(3000), h(3000), h(3000), h(3000), h(3000), h(3000), h(3000), h(3000), h(3000), h(3000), h(4000), h(6100)];
    const a = Calc.annualJudge(hist, hist, 2520, AG);
    expect(a.stages).toEqual(expect.arrayContaining(['annual_warn', 'over_count', 'single', 'avg']));
    const b = Calc.annualJudge([h(1000)], [h(1000)], 2520, AG);
    expect(b.stages).toEqual([]);
  });
  test('年度の月リスト（4月起算）', () => {
    expect(Calc.fiscalMonths('2026-11', 4)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(Calc.fiscalMonths('2027-02', 4)[0]).toBe('2026-04');
  });
});

describe('営業日', () => {
  test('11月の第3営業日は11/5（11/3祝）', () => {
    expect(Calc.nthBusinessDay('2026-11', 3, R, HOL)).toBe('2026-11-05');
  });
  test('前営業日', () => {
    expect(Calc.prevBusinessDay('2026-11-09', R, HOL)).toBe('2026-11-06');
    expect(Calc.prevBusinessDay('2026-11-04', R, HOL)).toBe('2026-11-02');
  });
});

describe('設定の正規化', () => {
  test('シートの文字列を数値・時刻・真偽に変換', () => {
    const r = Calc.normalizeRules({ lunch_start: '12:30', deviation_grace_min: '10', w40_counts_in_limit: 'FALSE' });
    expect([r.lunch_start, r.deviation_grace_min, r.w40_counts_in_limit]).toEqual([750, 10, false]);
  });
  test('社員の所定時間（時短）', () => {
    const e = emp({ sched_start: '9:00', sched_end: '15:00', sched_min: 300 });
    expect([e.sched_start, e.sched_end, e.sched_min]).toEqual([540, 900, 300]);
  });
});

describe('中抜けの補填（同じ日）', () => {
  test('中抜け1:00で申請なし18:30退勤 → 乖離にせず18:30まで計上、残業0', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 30), extraBreak: 60, extraBreakNote: '私用' });
    expect(c.flags).toEqual([]);
    expect([c.b, c.work, c.r, c.makeup]).toEqual([T(18, 30), 480, 0, 60]);
    expect(c.note).toBe('私用／中抜け分 終業後勤務1:00');
  });
  test('中抜け0:45：18:40退勤は18:15まで（超過25分は30分未満で切り捨て）、18:45退勤は乖離', () => {
    const a = day(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 40), extraBreak: 45 });
    expect([a.b, a.work, a.r, a.flags]).toEqual([T(18, 15), 480, 0, []]);
    expect(day(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 45), extraBreak: 45 }).flags).toContain('DEVIATION');
  });
  test('中抜け0:45＋終業予定19:00で18:50退勤 → 18:45まで、残業0:30', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 50), extraBreak: 45, preEnd: T(19, 0) });
    expect([c.b, c.work, c.r]).toEqual([T(18, 45), 510, 30]);
    expect(c.makeup).toBe(0);   // 事前申請の範囲内なので補填扱いにしない
  });
  test('補填の範囲内で早めに退勤（中抜け1:00で18:10退勤）は実時刻', () => {
    const c = day(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 10), extraBreak: 60 });
    expect([c.b, c.work, c.makeup]).toEqual([T(18, 10), 460, 40]);
  });
  test('makeup_enabled=false なら従来どおり乖離', () => {
    const R2 = Calc.normalizeRules({ makeup_enabled: 'FALSE' });
    const c = Calc.calcDay(FIX, '2026-10-07', { in: T(8, 30), out: T(18, 30), extraBreak: 60 }, R2, HOL, TODAY);
    expect(c.flags).toContain('DEVIATION');
  });
});

describe('不足の充当（同じ月の中で日・週をまたぐ）', () => {
  const NOV = (extra, rules) => {
    const inputs = Object.assign({
      '2026-11-09': { in: T(8, 30), out: T(17, 30), extraBreak: 60, extraBreakNote: '通院' }, // 中抜け1:00 → 不足1:00
      '2026-11-10': { in: T(9, 0), out: T(17, 30) },                                          // 遅刻0:30 → 不足0:30
      '2026-11-14': { in: T(9, 0), out: T(10, 0) },                                           // 土曜出勤1:00
      '2026-11-16': { in: T(8, 30), out: T(18, 30), preEnd: T(18, 30) }                       // 残業1:00
    }, extra || {});
    return Calc.calcMonth(FIX, '2026-11', inputs, Calc.normalizeRules(rules || {}), HOL, '2026-12-10', AG);
  };
  test('休日出勤→残業の順に、日付順で充当する', () => {
    const m = NOV(), t = m.totals, row = d => m.rows.find(r => r.date === d);
    expect([t.lack, t.lackHol, t.lackOt, t.lackLeft]).toEqual([90, 60, 30, 0]);
    expect([t.holWork, t.holPay, t.otWork, t.otPay]).toEqual([60, 0, 60, 30]);
    expect(row('2026-11-09').note).toBe('通院／不足1:00→11/14出勤1:00で充当');
    expect(row('2026-11-10').note).toBe('時差出勤／不足0:30→11/16残業0:30で充当');
    expect(row('2026-11-14').note).toBe('休日出勤／11/9不足へ1:00充当');
    expect(row('2026-11-16').note).toBe('11/10不足へ0:30充当');
    expect([row('2026-11-09').filled, row('2026-11-16').offsetTo]).toEqual([60, [{ date: '2026-11-10', min: 30, kind: 'ot' }]]);
  });
  test('充当しても36協定の残業・割増は変わらない', () => {
    const a = NOV().totals, b = NOV({}, { offset_enabled: 'FALSE' }).totals;
    expect([a.ot36, a.legalOt, a.w40, a.premium, a.formOt]).toEqual([b.ot36, b.legalOt, b.w40, b.premium, b.formOt]);
    expect([b.lack, b.lackHol, b.lackOt, b.lackLeft]).toEqual([90, 0, 0, 90]);
  });
  test('overtime_first は残業から先に充当', () => {
    const t = NOV({}, { offset_order: 'overtime_first' }).totals;
    expect([t.lackHol, t.lackOt, t.lackLeft]).toEqual([30, 60, 0]);
  });
  test('充当しきれない不足は控除対象として残る', () => {
    const t = NOV({ '2026-11-11': { in: T(8, 30), out: T(15, 30) } }).totals;   // 早退2:00
    expect([t.lack, t.lackLeft]).toEqual([210, 90]);   // 充当できるのは休日出勤1:00＋残業1:00まで
  });
  test('半休の日は残り半日の所定時間帯を基準にする（午後休：8:30〜12:00、午前休：13:00〜17:30）', () => {
    const m = NOV({ '2026-11-17': { leaveType: 'paid_pm', in: T(8, 30), out: T(12, 0) }, '2026-11-18': { leaveType: 'paid_am', in: T(13, 0), out: T(17, 0) } });
    expect(m.rows.find(r => r.date === '2026-11-17').lack).toBe(0);
    expect(m.rows.find(r => r.date === '2026-11-18').lack).toBe(30);
  });
  test('前月の休日出勤は使わない（月の中だけ）', () => {
    const inputs = { '2026-10-31': { in: T(9, 0), out: T(12, 0) }, '2026-11-02': { in: T(8, 30), out: T(16, 30) } };
    const t = Calc.calcMonth(FIX, '2026-11', inputs, R, HOL, '2026-12-10', AG).totals;
    expect([t.lack, t.lackHol, t.lackLeft]).toEqual([60, 0, 60]);
  });
  test('勤怠対象外・フレックスは充当しない', () => {
    const ex = emp({ exempt: true });
    const inputs = { '2026-11-09': { in: T(8, 30), out: T(16, 30) }, '2026-11-14': { in: T(9, 0), out: T(12, 0) } };
    expect(Calc.calcMonth(ex, '2026-11', inputs, R, HOL, '2026-12-10', AG).totals.lackHol).toBe(0);
    expect(Calc.calcMonth(FLEX, '2026-11', inputs, R, HOL, '2026-12-10', AG).totals.lackHol).toBe(0);
  });
});
