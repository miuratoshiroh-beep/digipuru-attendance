/**
 * PostgreSQL での結合テスト（TEST_DATABASE_URL があるときだけ）
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/att npx jest test/pg.test.js
 */
const { Pool } = require('pg');
const { createEngine, loadSchema } = require('../server/engine');
const { PgStore } = require('../server/store');
const { EMPLOYEES, HOLIDAYS } = require('./seed');

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
const SASAKI = 'sasaki.ryo@g.takayoshi.co.jp', KACHO = 'kacho@g.takayoshi.co.jp', ADMIN = 'admin@g.takayoshi.co.jp';

d('PostgreSQL', () => {
  let pool, schema, now = new Date('2026-11-10T08:30:00+09:00');
  const mails = [], stores = [];
  async function boot() {
    const store = new PgStore(pool, schema);
    stores.push(store);
    await store.init();
    await store.acquireWriterLock();
    const engine = createEngine({ store, now: () => now, sendMail: async m => { mails.push(m); } });
    await engine.init();
    return { store, engine };
  }
  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    schema = loadSchema();
    for (const t of [...Object.keys(schema), 'app_files', 'job_runs']) await pool.query(`DROP TABLE IF EXISTS "${t}"`);
  });
  afterAll(async () => { for (const s of stores) await s.releaseWriterLock(); await pool.end(); });

  test('初期化・書き込み・再起動後の読み直し・失敗時の巻き戻し・ファイル', async () => {
    let { store, engine } = await boot();
    const rules = await pool.query('SELECT count(*)::int AS n FROM rules');
    expect(rules.rows[0].n).toBeGreaterThan(20);
    await engine.internal('system', c => { c.Repo.append('employees', EMPLOYEES); c.Repo.append('holidays', HOLIDAYS); });
    // 打刻
    const r = await engine.call('apiPunch', ['IN'], SASAKI);
    expect(r.today.punchIn).toBe(510);
    now = new Date('2026-11-10T19:10:00+09:00');
    await engine.call('apiPunch', ['OUT'], SASAKI);
    const p = await pool.query('SELECT emp_id, kind, minute, work_date FROM punch_log ORDER BY id');
    expect(p.rows).toEqual([{ emp_id: 'E002', kind: 'IN', minute: 510, work_date: '2026-11-10' }, { emp_id: 'E002', kind: 'OUT', minute: 1150, work_date: '2026-11-10' }]);
    // 型（数値・真偽値）
    const e = await pool.query("SELECT sched_min, active FROM employees WHERE emp_id = 'E002'");
    expect(e.rows[0]).toEqual({ sched_min: 480, active: true });
    // 業務エラーはDBに何も残さない（途中の書き込みも巻き戻す）
    const before = (await pool.query('SELECT count(*)::int AS n FROM requests')).rows[0].n;
    await expect(engine.internal(SASAKI, c => { c.Repo.append('requests', [{ req_id: 'X1', emp_id: 'E002', kind: 'pre', work_date: '2026-11-11', status: 'pending' }]); throw new Error('途中で失敗'); })).rejects.toThrow('途中で失敗');
    expect((await pool.query('SELECT count(*)::int AS n FROM requests')).rows[0].n).toBe(before);
    expect(engine.ctx.Repo.all('requests').length).toBe(before);
    // 申請→承認（承認者にメール）
    await engine.call('apiSubmitRequest', [{ kind: 'pre', date: '2026-11-11', preEnd: '19:00', reason: '開発' }], SASAKI);
    expect(mails.some(m => m.to.includes(KACHO))).toBe(true);
    const ids = (await engine.call('apiApprovals', [], KACHO)).pending.map(x => x.req_id);
    const bulk = await engine.call('apiDecideBulk', [ids, '2026-10'], KACHO);
    expect(bulk.done).toBe(1);
    // 再起動（別のエンジンで読み直す）
    await store.releaseWriterLock();
    ({ store, engine } = await boot());
    const reqs = engine.ctx.Repo.all('requests');
    expect(reqs.map(x => [x.status, x.approver_email])).toEqual([['approved', KACHO]]);
    // 夜間処理で daily・monthly
    const res = await engine.internal('system', c => c.nightlyJob());
    expect(res.persisted.monthly).toBe(10);
    const daily = await pool.query("SELECT work_min, ot_daily_min, flags FROM daily WHERE emp_id = 'E002' AND work_date = '2026-11-10'");
    expect(daily.rows[0]).toEqual({ work_min: 580, ot_daily_min: 100, flags: 'DEVIATION' });   // 終業予定なしで19:10退勤＝乖離（本人が理由を入れるまで打刻どおり）
    // 締めのCSV（ファイルは app_files）
    const out = await engine.internal(ADMIN, c => c.Files.put('t.csv', 'text/csv', '﻿a,b'));
    const f = await store.getFile(out.replace('/files/', ''));
    expect([f.name, f.content.toString('utf8')]).toEqual(['t.csv', '﻿a,b']);
    // マスタの保存：不正なら保存しない
    const m = await engine.call('apiMasterGet', ['holidays'], ADMIN);
    await expect(engine.call('apiMasterSave', ['holidays', [...m.rows, { date: '2026/12/31', kind: 'company', name: '大晦日' }]], ADMIN)).rejects.toThrow(/yyyy-MM-dd/);
    expect((await pool.query('SELECT count(*)::int AS n FROM holidays')).rows[0].n).toBe(3);
    const saved = await engine.call('apiMasterSave', ['holidays', [...m.rows, { date: '2026-12-31', kind: 'company', name: '大晦日' }]], ADMIN);
    expect(saved.rows).toHaveLength(4);
    const imp = await engine.call('apiImportHolidays', [2027], ADMIN);
    expect(imp.added).toBe(17);
    expect((await pool.query("SELECT count(*)::int AS n FROM holidays WHERE date LIKE '2027-%'")).rows[0].n).toBe(17);
    // 監査ログ（メモリには持たない）
    expect(engine.Host.db.tables.audit_log.rows).toHaveLength(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'master_save'")).rows[0].n).toBe(1);
    // 定時処理の二重実行防止
    expect(await store.claimJob('morning', '2026-11-10')).toBe(true);
    expect(await store.claimJob('morning', '2026-11-10')).toBe(false);
    await store.releaseWriterLock();
  });

  test('書き込み担当は1つだけ（2つ目は前のインスタンスの終了を待つ）', async () => {
    const a = new PgStore(pool, schema), b = new PgStore(pool, schema);
    await a.acquireWriterLock();
    let waited = 0;
    const p = b.acquireWriterLock(() => { waited++; });
    await new Promise(r => setTimeout(r, 2500));
    expect(waited).toBeGreaterThan(0);
    await a.releaseWriterLock();
    await p;
    await b.releaseWriterLock();
  });
});
