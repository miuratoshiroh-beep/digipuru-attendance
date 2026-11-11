/**
 * テスト用：core をメモリ保存で同期的に動かす（旧 gasfake と同じ使い方）
 *   const g = createGas(); g.as(email).at(iso).call('apiPunch', 'IN')
 * call の後は変更をメモリ保存へコミット、エラー時はコミット済みの状態へ戻す（本番の engine と同じ）
 */
const { createEngine, loadSchema } = require('../server/engine');
const { MemoryStore } = require('../server/store');

function createGas() {
  const schema = loadSchema();
  const store = new MemoryStore(schema);
  const state = { user: 'admin@g.takayoshi.co.jp', now: new Date('2026-11-10T09:00:00+09:00'), mails: [], files: [] };
  const engine = createEngine({ store, now: () => state.now });
  const { ctx, Host } = engine;
  const loadSync = () => { const t = {}; for (const [n, v] of Object.entries(store.committed)) t[n] = { rows: v.rows.map(r => ({ ...r })), seq: v.seq }; Host.db.tables = t; };
  const commitSync = () => {
    const ops = Host.ops, files = Host.files;
    Host.ops = []; Host.files = [];
    store.commit(ops, files);   // MemoryStore.commit は同期的に反映される
    files.forEach(f => state.files.push({ ...f, data: Buffer.isBuffer(f.content) ? f.content.toString('utf8') : String(f.content) }));
    state.mails.push(...Host.mails.map(m => ({ ...m })));
    Host.mails = [];
  };
  loadSync();
  const gas = {
    ctx, state, store, engine,
    as(email) { state.user = email; return gas; },
    at(iso) { state.now = new Date(iso); return gas; },
    /** core の関数を同期で呼ぶ（API 以外の関数も可） */
    call(fn, ...args) {
      commitSync();
      Host.user = state.user; ctx.Repo.clearCache();
      let r;
      try { r = ctx[fn](...args); } catch (e) { Host.ops = []; Host.files = []; Host.mails = []; loadSync(); throw e; }
      commitSync();
      return r;
    },
    /** Repo などを直接使う準備・後片付け（変更をコミットする） */
    direct(fn) { commitSync(); Host.user = state.user; ctx.Repo.clearCache(); const r = fn(ctx); commitSync(); ctx.Repo.clearCache(); return r; }
  };
  // 初期値（設定・36協定・帳票の番地）
  gas.direct(c => {
    const add = (name, rows) => { const cols = c.SCHEMA[name].map(x => x[0]); c.Repo.append(name, rows.map(r => { const o = {}; cols.forEach((k, i) => { o[k] = r[i]; }); return o; })); };
    add('rules', c.DEFAULT_RULE_ROWS); add('agreement36', c.DEFAULT_AGREEMENT_ROWS); add('form_map', c.DEFAULT_FORM_MAP_ROWS);
  });
  return gas;
}
module.exports = { createGas };
