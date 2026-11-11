// GAS 模擬環境で API を通しで動かす結合テスト
const { createGas } = require('./harness');
const { seed } = require('./seed');

const SASAKI = 'sasaki.ryo@g.takayoshi.co.jp';
const KACHO = 'kacho@g.takayoshi.co.jp';
const ADMIN = 'admin@g.takayoshi.co.jp';
const at = (d, hm) => `${d}T${hm}:00+09:00`;

function newGas() { const g = createGas(); seed(g); return g; }

describe('初期設定', () => {
  test('初期値（設定・36協定・帳票の番地）が入り、足し直しても重複しない', async () => {
    const g = newGas();
    ['rules', 'agreement36', 'form_map'].forEach(n => expect(g.ctx.Repo.all(n).length).toBeGreaterThan(5));
    const before = g.ctx.Repo.all('rules').length;
    expect(g.ctx.Repo.all('rules').map(r => r.key)).toEqual(expect.arrayContaining(['ot_unit_min', 'makeup_enabled', 'offset_enabled']));
    g.engine.init = null;
    await g.engine.seedDefaults().catch(() => {});   // 起動前（ready=false）は何もしない
    expect(g.ctx.Repo.all('rules').length).toBe(before);
  });
  test('登録されていないアカウントはエラー', () => {
    const g = newGas();
    g.as('nobody@g.takayoshi.co.jp');
    expect(() => g.call('apiBootstrap')).toThrow(/登録されていません/);
  });
  test('起動時に権限が返る', () => {
    const g = newGas();
    expect(g.as(SASAKI).call('apiBootstrap')).toMatchObject({ isApprover: false, isAdmin: false });
    expect(g.as(KACHO).call('apiBootstrap')).toMatchObject({ isApprover: true, isAdmin: false });
    expect(g.as(ADMIN).call('apiBootstrap')).toMatchObject({ isApprover: true, isAdmin: true });
  });
});

describe('打刻', () => {
  test('出勤→退勤で当日の計算が返り、二重打刻はエラー', () => {
    const g = newGas().as(SASAKI);
    let h = g.at(at('2026-11-10', '08:24')).call('apiPunch', 'IN', 'test');
    expect(h.state).toBe('on');
    expect(() => g.call('apiPunch', 'IN')).toThrow(/すでに記録/);
    h = g.at(at('2026-11-10', '17:40')).call('apiPunch', 'OUT');
    expect(h.state).toBe('done');
    expect(h.today.a).toBe(510);
    expect(h.today.work).toBe(480);   // 17:40退勤は30分単位で17:30
    expect(() => g.call('apiPunch', 'OUT')).toThrow(/すでに記録/);
  });
  test('日付をまたいだ退勤（翌1:30）は前日の退勤になる', () => {
    const g = newGas().as(SASAKI);
    g.at(at('2026-11-10', '08:30')).call('apiPunch', 'IN');
    g.at(at('2026-11-11', '01:30')).call('apiPunch', 'OUT');
    const m = g.call('apiMonth', '2026-11');
    const d = m.rows.find(r => r.date === '2026-11-10');
    expect(d.punchOut).toBe(25 * 60 + 30);
    expect(d.flags).toContain('DEVIATION');
  });
  test('出勤記録がないまま退勤するとエラー', () => {
    const g = newGas().as(SASAKI).at(at('2026-11-10', '18:00'));
    expect(() => g.call('apiPunch', 'OUT')).toThrow(/出勤の記録がありません/);
  });
});

describe('申請と承認', () => {
  test('事前申請→承認で終業予定が反映され、乖離が消える', () => {
    const g = newGas().as(SASAKI);
    g.at(at('2026-11-10', '08:25')).call('apiPunch', 'IN');
    g.at(at('2026-11-10', '19:40')).call('apiPunch', 'OUT');
    let m = g.call('apiMonth', '2026-11');
    expect(m.rows.find(r => r.date === '2026-11-10').flags).toContain('DEVIATION');
    g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-10', preEnd: '19:30', reason: '開発対応' });
    expect(g.state.mails.some(x => x.to === KACHO)).toBe(true);
    // 本人は自分の申請を承認できない
    expect(() => g.call('apiDecide', g.call('apiMyRequests')[0].req_id, true)).toThrow(/権限/);
    const ap = g.as(KACHO).call('apiApprovals');
    expect(ap.pending).toHaveLength(1);
    expect(ap.pending[0].is_post).toBe(true);
    g.call('apiDecide', ap.pending[0].req_id, true, '');
    m = g.as(SASAKI).call('apiMonth', '2026-11');
    const d = m.rows.find(r => r.date === '2026-11-10');
    expect(d.flags).not.toContain('DEVIATION');
    expect(d.preEnd).toBe(19 * 60 + 30);
    expect(d.r).toBe(19 * 60 + 30 - 510 - 60 - 480);   // 19:40退勤・申請19:30 → 19:30まで
    expect(d.preApprover).toMatch(/^課長 11\/10$/);
  });
  test('事前申請の入力チェック', () => {
    const g = newGas().as(SASAKI);
    expect(() => g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preEnd: '17:00', reason: 'x' })).toThrow(/終業.*より後/);
    expect(() => g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preEnd: '18:40', reason: 'x' })).toThrow(/30分単位/);
    expect(() => g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preStart: '07:10', reason: 'x' })).toThrow(/30分単位/);
    expect(() => g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preStart: '09:00', reason: 'x' })).toThrow(/始業.*より前/);
    expect(() => g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preEnd: '19:00', reason: '' })).toThrow(/理由/);
    g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preEnd: '19:00', reason: '見積作成' });
    expect(() => g.call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preEnd: '20:00', reason: 'y' })).toThrow(/承認待ち/);
    expect(() => g.as('kobayashi.misaki@g.takayoshi.co.jp').call('apiSubmitRequest', { kind: 'pre', date: '2026-11-12', preEnd: '19:00', reason: 'x' })).toThrow(/固定時間制/);
  });
  test('打刻修正→承認で修正行が追記され、元の打刻は残る。差し戻しは理由が必要', () => {
    const g = newGas().as(SASAKI);
    g.at(at('2026-11-09', '08:28')).call('apiPunch', 'IN');
    g.at(at('2026-11-10', '09:00'));
    let m = g.call('apiMonth', '2026-11');
    expect(m.rows.find(r => r.date === '2026-11-09').flags).toContain('MISSING_OUT');
    g.call('apiSubmitRequest', { kind: 'fix', date: '2026-11-09', outTime: '17:35', reason: '打刻忘れ' });
    const home = g.call('apiHome');
    expect(home.issues.find(i => i.date === '2026-11-09')).toBeUndefined();   // 承認待ちは要対応から外す
    const ap = g.as(KACHO).call('apiApprovals');
    expect(() => g.call('apiDecide', ap.pending[0].req_id, false, '')).toThrow(/理由/);
    g.call('apiDecide', ap.pending[0].req_id, true, '');
    m = g.as(SASAKI).call('apiMonth', '2026-11');
    const d = m.rows.find(r => r.date === '2026-11-09');
    expect(d.punchOut).toBe(17 * 60 + 35);
    expect(d.flags).toEqual(['EDITED']);
    const logs = g.ctx.Repo.all('punch_log').filter(p => p.work_date === '2026-11-09');
    expect(logs.map(p => p.source).sort()).toEqual(['fix', 'web']);
  });
  test('乖離を業務外と申告、休憩等の入力', () => {
    const g = newGas().as(SASAKI);
    g.at(at('2026-11-09', '08:28')).call('apiPunch', 'IN');
    g.at(at('2026-11-09', '19:00')).call('apiPunch', 'OUT');
    g.at(at('2026-11-10', '09:00'));
    expect(() => g.call('apiSaveDayInput', { date: '2026-11-09', deviation: 'non_work', deviationNote: '' })).toThrow(/理由/);
    let m = g.call('apiSaveDayInput', { date: '2026-11-09', deviation: 'non_work', deviationNote: '退社19時 業後雑談' });
    let d = m.rows.find(r => r.date === '2026-11-09');
    expect([d.b, d.r, d.note]).toEqual([1050, 0, '退社19時 業後雑談']);
    m = g.call('apiSaveDayInput', { date: '2026-11-09', extraBreak: 60, extraBreakNote: '私用1時間' });
    d = m.rows.find(r => r.date === '2026-11-09');
    // 中抜け1時間の分は終業後（17:30〜18:30）の勤務で補填される。業務外は18:30以降
    expect([d.b, d.work, d.r, d.makeup]).toEqual([1110, 480, 0, 60]);
    expect(d.note).toBe('退社19時 業後雑談／私用1時間／中抜け分 終業後勤務1:00');
  });
  test('取り下げ', () => {
    const g = newGas().as(SASAKI);
    const list = g.call('apiSubmitRequest', { kind: 'leave', date: '2026-11-20', leaveType: 'paid_full', reason: '私用' });
    const after = g.call('apiCancelRequest', list[0].req_id);
    expect(after[0].status).toBe('cancelled');
  });
});

describe('月次の確定・承認・締め', () => {
  function fullOctober(g) {
    // 10月の全営業日を打刻（佐々木・小林・長谷川）。管理職2名も打刻する
    const C = g.ctx.Calc, R = C.normalizeRules({}), H = { '2026-10-12': { kind: 'company' } };
    const users = ['sasaki.ryo', 'kobayashi.misaki', 'hasegawa.takumi', 'kacho', 'admin'];
    C.monthDays('2026-10').forEach(d => {
      if (C.dayType(d, R, H) !== 'work') return;
      users.forEach(u => {
        g.as(u + '@g.takayoshi.co.jp').at(at(d, '08:25')).call('apiPunch', 'IN');
        g.at(at(d, '17:35')).call('apiPunch', 'OUT');
      });
    });
  }
  test('確定→承認→締め→CSV、締め後は申請・打刻できない', () => {
    const g = newGas();
    fullOctober(g);
    g.at(at('2026-11-02', '09:00'));
    // 承認前は締められない
    expect(() => g.as(ADMIN).call('apiCloseMonth', '2026-10')).toThrow(/承認が済んでいない/);
    // 未確定の承認はできない
    expect(() => g.as(KACHO).call('apiApproveMonth', 'E002', '2026-10')).toThrow(/確定していません/);
    ['sasaki.ryo', 'kobayashi.misaki', 'hasegawa.takumi', 'kacho', 'admin'].forEach(u => g.as(u + '@g.takayoshi.co.jp').call('apiConfirmMonth', '2026-10'));
    ['E002', 'E003', 'E004'].forEach(id => g.as(KACHO).call('apiApproveMonth', id, '2026-10'));
    ['E001', 'E005'].forEach(id => g.as(ADMIN).call('apiApproveMonth', id, '2026-10'));
    const res = g.as(ADMIN).call('apiCloseMonth', '2026-10');
    expect(res.month.closed).toBe(true);
    expect(g.state.files.map(f => f.name)).toEqual(['勤怠_2026-10_daily.csv', '勤怠_2026-10_monthly.csv']);
    expect(res.result.csv.daily).toBe('/files/' + g.state.files[0].id);
    expect(res.month.close.csv_monthly_url).toBe('/files/' + g.state.files[1].id);
    expect(g.state.files[1].data.charCodeAt(0)).toBe(0xFEFF);
    const snap = g.ctx.Repo.all('monthly').filter(r => r.ym === '2026-10');
    expect(snap).toHaveLength(5);
    expect(snap.every(r => r.closed)).toBe(true);
    expect(g.ctx.Repo.all('daily').filter(r => r.work_date.startsWith('2026-10'))).toHaveLength(31 * 5);
    expect(() => g.as(SASAKI).call('apiSubmitRequest', { kind: 'leave', date: '2026-10-20', leaveType: 'paid_full', reason: 'x' })).toThrow(/締め済み/);
    expect(() => g.as(SASAKI).call('apiSaveDayInput', { date: '2026-10-20', extraBreak: 30, extraBreakNote: 'x' })).toThrow(/締め済み/);
    expect(() => g.as(ADMIN).call('apiCloseMonth', '2026-10')).toThrow(/すでに締め済み/);
  });
  test('締め済みの月だけアーカイブできる', () => {
    const g = newGas();
    g.as(SASAKI).at(at('2026-10-05', '08:30')).call('apiPunch', 'IN');
    g.at(at('2026-11-10', '09:00'));
    expect(() => g.call('archiveBefore', '2026-11-01')).toThrow(/締められていない/);
    g.ctx.Repo.append('month_close', [{ ym: '2026-10', closed_at: 'x', closed_by: 'x' }]);
    const r = g.call('archiveBefore', '2026-11-01');
    expect(r.moved).toBe(1);
    expect(g.ctx.Repo.all('punch_log')).toHaveLength(0);
  });
  test('打刻漏れがあると確定できない', () => {
    const g = newGas().as(SASAKI).at(at('2026-11-02', '09:00'));
    expect(() => g.call('apiConfirmMonth', '2026-10')).toThrow(/打刻漏れ/);
  });
  test('当月は締められない、管理者以外は締められない', () => {
    const g = newGas().at(at('2026-11-10', '09:00'));
    expect(() => g.as(ADMIN).call('apiCloseMonth', '2026-11')).toThrow(/当月以降/);
    expect(() => g.as(KACHO).call('apiCloseMonth', '2026-10')).toThrow(/管理者のみ/);
  });
});

describe('運用開始日・勤怠対象外', () => {
  test('運用開始日より前は記録なしにせず、前月の確定も求めない', () => {
    const g = newGas();
    g.ctx.Repo.upsert('rules', { key: 'operation_start' }, { value: '2026-11-11', note: '' });
    const h = g.as(SASAKI).at(at('2026-11-12', '09:00')).call('apiHome');
    expect(h.issues.map(i => i.date)).toEqual(['2026-11-11']);
    expect(h.prev.status.notRequired).toBe(true);
    const res = g.at(at('2026-11-12', '07:00')).call('morningJob');
    expect(res.issues).toBe(5);            // 11/11 の記録なし（5名）
    expect(res.reminded).toBe(0);
  });
  test('勤怠対象外（役員）は記録なし・通知・締めの対象にしない', () => {
    const g = newGas();
    const a = g.ctx.Repo.find('employees', { emp_id: 'E001' }); a.exempt = true; g.ctx.Repo.update('employees', a);
    const h = g.as(ADMIN).at(at('2026-11-10', '09:00')).call('apiHome');
    expect(h.issues).toEqual([]);
    expect(h.prev.status.notRequired).toBe(true);
    const m = g.call('apiAdminMonth', '2026-10');
    expect(m.rows.map(r => r.emp.emp_id)).not.toContain('E001');
    expect(g.call('apiBootstrap').isAdmin).toBe(true);
  });
});

describe('権限', () => {
  test('他人の勤怠は承認者・管理者以外は見られない', () => {
    const g = newGas();
    expect(() => g.as(SASAKI).call('apiMonth', '2026-11', 'E003')).toThrow(/表示できません/);
    expect(g.as(KACHO).call('apiMonth', '2026-11', 'E003').emp.name).toBe('小林 美咲');
    expect(g.as(ADMIN).call('apiMonth', '2026-11', 'E005').emp.name).toBe('課長 一郎');
    expect(() => g.as(SASAKI).call('apiApprovals')).toThrow(/承認者のみ/);
    expect(() => g.as(KACHO).call('apiAdminMonth', '2026-10')).toThrow(/管理者のみ/);
  });
});

describe('通知', () => {
  test('36協定の段階到達は1回だけ通知（注意75%）', () => {
    const g = newGas().as(SASAKI);
    // 11月：平日に毎日21:30まで（残業3時間）。事前申請あり
    const C = g.ctx.Calc, R = C.normalizeRules({}), H = { '2026-11-03': { kind: 'company' } };
    const days = C.monthDays('2026-11').filter(d => C.dayType(d, R, H) === 'work' && d <= '2026-11-20');
    days.forEach(d => {
      g.ctx.Repo.append('requests', [{ req_id: 'R' + d, emp_id: 'E002', kind: 'pre', work_date: d, pre_end: '21:30', status: 'approved', reason: '開発', approver_name: '課長', decided_at: d + 'T09:00:00+09:00' }]);
    });
    days.forEach(d => { g.at(at(d, '08:30')).call('apiPunch', 'IN'); g.at(at(d, '21:30')).call('apiPunch', 'OUT'); });
    const stages = g.ctx.Repo.all('notices').filter(n => n.emp_id === 'E002').map(n => n.stage);
    expect(stages).toEqual(expect.arrayContaining(['caution', 'warn', 'over']));
    expect(new Set(stages).size).toBe(stages.length);
    const overMail = g.state.mails.find(m => /上限に達しました/.test(m.subject));
    expect(overMail.to).toContain(ADMIN);
    expect(overMail.to).toContain(KACHO);
  });
  test('朝の通知：前営業日の打刻漏れ', () => {
    const g = newGas().as(SASAKI);
    g.at(at('2026-11-09', '08:30')).call('apiPunch', 'IN');
    g.at(at('2026-11-10', '07:00'));
    const res = g.call('morningJob');
    expect(res.target).toBe('2026-11-09');
    expect(g.state.mails.some(m => m.to.includes(SASAKI) && /退勤未打刻/.test(m.subject))).toBe(true);
  });
  test('朝の通知：第1営業日に前月の確定依頼', () => {
    const g = newGas().at(at('2026-11-02', '07:00'));
    const res = g.call('morningJob');
    expect(res.reminded).toBe(5);
  });
});

describe('夜間処理', () => {
  test('daily・monthly の保存、勤務区分の変更予約の反映、設定の点検', () => {
    const g = newGas().at(at('2026-12-01', '02:00'));
    const e = g.ctx.Repo.find('employees', { emp_id: 'E002' });
    e.work_type_next = 'flex'; e.work_type_next_from = '2026-12-01';
    g.ctx.Repo.update('employees', e);
    const bad = g.ctx.Repo.find('employees', { emp_id: 'E004' });
    bad.approver_email = 'ghost@g.takayoshi.co.jp';
    g.ctx.Repo.update('employees', bad);
    const res = g.call('nightlyJob');
    expect(res.workTypeChanged).toEqual(['E002']);
    expect(g.ctx.Repo.find('employees', { emp_id: 'E002' }).work_type).toBe('flex');
    expect(res.persisted.monthly).toBe(10);
    expect(res.settingErrors.join()).toMatch(/ghost/);
  });
});

describe('帳票', () => {
  test('転記データ：番地・社員ごとのモデルを返し、画面の処理はサーバーに引き継ぐ', () => {
    const g = newGas();
    const as = g.as(SASAKI);
    as.at(at('2026-10-05', '07:10')).call('apiPunch', 'IN');
    as.at(at('2026-10-05', '20:00')).call('apiPunch', 'OUT');
    g.ctx.Repo.append('requests', [{ req_id: 'RX', emp_id: 'E002', kind: 'pre', work_date: '2026-10-05', pre_start: '07:00', pre_end: '20:00', status: 'approved', reason: '撮影準備', approver_name: '課長', decided_at: '2026-10-02T09:00:00+09:00' }]);
    const res = g.as(ADMIN).at(at('2026-11-10', '09:00')).call('apiBuildForms', '2026-10', 'E002');
    expect(res.__async).toBe('forms');
    expect(res.job.name).toBe('勤務表兼残業表_2026-10_701_佐々木 遼');
    expect(res.job.map.work_start).toEqual({ row: 14, col: 15, a1: 'O14' });
    expect(res.job.layout).toEqual({ sheet: '入力用', firstDayRow: 14, page1LastRow: 28, lastRow: 50, firstCol: 5, lastCol: 24 });
    const d5 = res.job.jobs[0].model.days[4];
    expect([d5.preStart, d5.preEnd, d5.preReason, d5.preStamp, d5.a, d5.b]).toEqual([420, 1200, '撮影準備', '課長 10/2', 450, 1200]);
    expect(() => g.as(SASAKI).call('apiBuildForms', '2026-10', 'E002')).toThrow(/管理者のみ/);
  });
});

describe('一括承認', () => {
  test('選択した申請をまとめて承認し、処理できない申請は理由を返す', () => {
    const g = newGas().as(SASAKI).at(at('2026-11-10', '09:00'));
    ['2026-11-11', '2026-11-12', '2026-11-13'].forEach(d => g.call('apiSubmitRequest', { kind: 'pre', date: d, preEnd: '19:00', reason: '開発対応' }));
    const ids = g.as(KACHO).call('apiApprovals').pending.map(r => r.req_id);
    expect(ids).toHaveLength(3);
    g.call('apiDecide', ids[0], true, '');
    const res = g.call('apiDecideBulk', ids, '2026-10');
    expect(res.done).toBe(2);
    expect(res.failed).toEqual([expect.objectContaining({ req_id: ids[0], message: 'この申請はすでに処理されています' })]);
    expect(res.appr.pending).toHaveLength(0);
    expect(g.ctx.Repo.all('requests').filter(r => r.status === 'approved')).toHaveLength(3);
    expect(() => g.call('apiDecideBulk', [], '2026-10')).toThrow(/選んで/);
    expect(g.as(SASAKI).call('apiDecideBulk', ids, '2026-10').failed).toHaveLength(3);
  });
  test('確定済みの月次をまとめて承認する（未確定の人は対象外）', () => {
    const g = newGas();
    ['sasaki.ryo', 'kobayashi.misaki'].forEach(u => {
      g.as(u + '@g.takayoshi.co.jp').at(at('2026-10-30', '08:25')).call('apiPunch', 'IN');
      g.at(at('2026-10-30', '17:35')).call('apiPunch', 'OUT');
    });
    g.ctx.Repo.upsert('rules', { key: 'operation_start' }, { value: '2026-10-30', note: '' });
    g.at(at('2026-11-02', '09:00'));
    ['sasaki.ryo', 'kobayashi.misaki'].forEach(u => g.as(u + '@g.takayoshi.co.jp').call('apiConfirmMonth', '2026-10'));
    const res = g.as(KACHO).call('apiApproveMonthBulk', [], '2026-10');
    expect(res.done).toBe(2);
    expect(['E002', 'E003', 'E004'].map(id => g.ctx.Domain.status(id, '2026-10').approved)).toEqual([true, true, false]);
    expect(() => g.call('apiApproveMonthBulk', [], '2026-10')).toThrow(/確定済みの社員がいません/);
    expect(g.call('apiApproveMonthBulk', ['E004'], '2026-10').failed[0].message).toMatch(/確定していません/);
  });
});

describe('マスタの編集', () => {
  test('社員：保存・重複や管理者なしは保存しない・管理者以外は不可', () => {
    const g = newGas().as(ADMIN);
    const m = g.call('apiMasterGet', 'employees');
    expect(m.columns.find(c => c.name === 'email').label).toBe('メールアドレス');
    const rows = m.rows.map(r => ({ ...r }));
    rows.push({ emp_id: 'E009', name: '新人 花子', email: 'Hanako.Shinjin@g.takayoshi.co.jp', role: 'staff', work_type: 'fixed', limit_class: 'general', sched_start: '8:30', sched_end: '17:30', sched_min: 480, deemed_min: 480, active: true, approver_email: KACHO });
    const saved = g.call('apiMasterSave', 'employees', rows);
    expect(saved.rows.find(r => r.emp_id === 'E009').email).toBe('hanako.shinjin@g.takayoshi.co.jp');
    expect(() => g.call('apiMasterSave', 'employees', [...rows, { ...rows[1] }])).toThrow(/重複/);
    expect(() => g.call('apiMasterSave', 'employees', rows.map(r => ({ ...r, role: 'staff' })))).toThrow(/管理者/);
    expect(() => g.call('apiMasterSave', 'employees', rows.map(r => r.emp_id === 'E004' ? { ...r, work_type: 'part' } : r))).toThrow(/勤務区分/);
    expect(g.ctx.Repo.all('employees')).toHaveLength(6);   // 失敗した保存は何も変えない
    expect(() => g.as(KACHO).call('apiMasterGet', 'employees')).toThrow(/管理者のみ/);
    expect(() => g.as(ADMIN).call('apiMasterGet', 'punch_log')).toThrow(/編集できない/);
  });
  test('休日：祝日の取り込み（既にある日は変えない）', () => {
    const g = newGas().as(ADMIN);
    const r = g.call('apiImportHolidays', 2026);
    expect(r.added).toBe(18 - 3);   // 2026年の祝日・休日18日のうち、スポーツの日・文化の日・勤労感謝の日は登録済み
    expect(r.rows.find(x => x.date === '2026-01-01').name).toBe('元日');
  });
});
