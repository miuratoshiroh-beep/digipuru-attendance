/**
 * 業務ロジック（core/*.js）の実行環境
 * - core はもともと Google Apps Script 用に書いた同期処理。vm の中で動かし、Host 経由でサーバーとつなぐ
 * - 処理は1件ずつ順番に実行する（同時に書き込まない）。処理が終わったら変更を1トランザクションでDBに書く
 * - 処理中にエラーが出たら、メモリ上の変更を捨ててDBから読み直す（途中までの書き込みは残らない）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const holidayJp = require('@holiday-jp/holiday_jp');

const CORE = ['util.js', 'calc.js', 'schema.js', 'repo.js', 'domain.js', 'notify.js', 'monthly.js', 'form.js', 'api.js', 'jobs.js'];
const CORE_DIR = path.join(__dirname, '..', 'core');

function tokyoParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; f.formatToParts(d).forEach(p => { o[p.type] = p.value; }); return o;
}
/** Utilities.formatDate 互換（Asia/Tokyo 固定） */
function formatDate(d, tz, pattern) {
  const p = tokyoParts(d);
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|H|mm|m|ss|XXX/g, (t, lit) => {
    if (lit !== undefined) return lit;
    return { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, H: String(+p.hour), mm: p.minute, m: String(+p.minute), ss: p.second, XXX: '+09:00' }[t];
  });
}
function jpHolidays(year) {
  return Object.keys(holidayJp.holidays).filter(k => k.slice(0, 4) === String(year)).sort().map(k => ({ date: k, name: holidayJp.holidays[k].name }));
}

function loadSchema() {
  const c = {}; vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(CORE_DIR, 'schema.js'), 'utf8') + ';this.__S = SCHEMA;', c);
  return JSON.parse(JSON.stringify(c.__S));
}

/**
 * @param {object} o
 * @param {object} o.store   PgStore / MemoryStore
 * @param {function} [o.sendMail]  ({to, subject, body}) => Promise
 * @param {string} [o.appUrl]
 * @param {function} [o.now] テスト用の現在時刻
 * @param {function} [o.log]
 */
function createEngine(o) {
  const log = o.log || (() => {});
  const Host = {
    db: { tables: {} }, ops: [], mails: [], files: [], user: '', appUrl: o.appUrl || '',
    now: o.now || null, uuid: () => crypto.randomUUID(), jpHolidays
  };
  const ctx = {
    Host,
    Utilities: { formatDate },
    console: { log: (...a) => log('info', ...a), error: (...a) => log('error', ...a), warn: (...a) => log('warn', ...a) },
    Date, Math, JSON, Object, Array, String, Number, Error, RegExp, Buffer, isNaN, parseInt, parseFloat
  };
  vm.createContext(ctx);
  for (const f of CORE) vm.runInContext(fs.readFileSync(path.join(CORE_DIR, f), 'utf8'), ctx, { filename: 'core/' + f });

  let queue = Promise.resolve();
  let ready = false;

  async function reload() { Host.db.tables = await o.store.load(); }

  /** 1件の処理（同期関数 fn を vm の中で実行し、変更をコミットする） */
  async function exec(user, fn) {
    if (!ready) { const e = new Error('起動中です。数秒後にもう一度お試しください'); e.userFacing = true; e.status = 503; throw e; }
    Host.user = user || ''; Host.ops = []; Host.mails = []; Host.files = [];
    ctx.Repo.clearCache();
    let result, error = null;
    try { result = fn(ctx); } catch (e) { error = e; }
    const ops = Host.ops, files = Host.files, mails = Host.mails;
    Host.ops = []; Host.files = []; Host.mails = [];
    if (error) {
      if (ops.length) await reload();      // メモリ上の書きかけを捨てる
      throw error;
    }
    try {
      await o.store.commit(ops, files);
    } catch (e) {
      log('error', 'commit failed', e);
      await reload();
      const err = new Error('保存に失敗しました。もう一度お試しください（' + e.message + '）'); err.userFacing = true; throw err;
    }
    for (const t of Object.values(Host.db.tables)) if (t.writeOnly) t.rows = [];
    if (mails.length && o.sendMail) {
      for (const m of mails) o.sendMail(m).catch(e => log('error', 'mail failed', m.to, m.subject, e.message));
    }
    return { result, mails, files };
  }

  function run(user, fn) {
    const p = queue.then(() => exec(user, fn));
    queue = p.catch(() => {});
    return p;
  }

  const engine = {
    ctx, Host,
    async init() {
      await reload();
      ready = true;
      await engine.seedDefaults();
    },
    isReady: () => ready,
    idle: () => queue,
    /** 画面からの API 呼び出し。args は JSON にできる値だけ */
    async call(fn, args, user) {
      if (!/^api[A-Z]\w*$/.test(fn) || typeof ctx[fn] !== 'function') { const e = new Error('不明な操作です：' + fn); e.userFacing = true; e.status = 404; throw e; }
      const json = JSON.stringify(args || []);
      const r = await run(user, c => c[fn].apply(null, c.JSON.parse(json)));
      return r.result === undefined ? null : JSON.parse(JSON.stringify(r.result));
    },
    /** サーバー内部の処理（定時処理・帳票の保存など） */
    async internal(user, fn) { return (await run(user, fn)).result; },
    /** 設定・36協定・帳票の番地の初期値を足す（既存の値は変えない） */
    async seedDefaults() {
      return engine.internal('system', c => {
        const add = (name, rows) => {
          const have = {};
          c.Repo.all(name).forEach(r => { have[r[c.SCHEMA[name][0][0]]] = true; });
          const cols = c.SCHEMA[name].map(x => x[0]);
          const objs = rows.filter(r => !have[r[0]]).map(r => { const x = {}; cols.forEach((k, i) => { x[k] = r[i]; }); return x; });
          c.Repo.append(name, objs);
          return objs.length;
        };
        return { rules: add('rules', c.DEFAULT_RULE_ROWS), agreement36: add('agreement36', c.DEFAULT_AGREEMENT_ROWS), form_map: add('form_map', c.DEFAULT_FORM_MAP_ROWS) };
      });
    },
    async reload() { await run('system', () => null); await reload(); },
    /** 現在の管理者・社員か（ログイン時の確認） */
    whoIs(email) {
      email = String(email || '').toLowerCase();
      const t = Host.db.tables.employees;
      const e = t && t.rows.find(r => String(r.email).toLowerCase() === email && r.active);
      return e ? { emp_id: e.emp_id, name: e.name, role: e.role || 'staff' } : null;
    }
  };
  return engine;
}

module.exports = { createEngine, loadSchema, formatDate, jpHolidays };
