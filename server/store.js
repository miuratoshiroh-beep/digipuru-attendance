/**
 * 永続化（PostgreSQL）とテスト用のメモリ保存
 * - テーブルと列は core/schema.js の SCHEMA から自動で作る（列の追加は起動時に反映）
 * - 行の id はアプリが採番する（1インスタンスだけが書き込む前提。起動時に advisory lock で保証）
 * - commit は1回の処理で積んだ変更を1トランザクションで書く
 */
const TYPE = { s: 'text', n: 'double precision', b: 'boolean' };
const WRITE_ONLY = new Set(['audit_log']);   // 読み戻さないテーブル（メモリに持たない）
const LOCK_KEY = 72026111;                  // advisory lock のキー（勤怠システム専用）

function q(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function fromDb(schema, row) {
  const o = { _id: Number(row.id) };
  for (const [col, t] of schema) {
    const v = row[col];
    if (v == null) o[col] = t === 'n' ? null : (t === 'b' ? false : '');
    else o[col] = t === 'n' ? Number(v) : (t === 'b' ? !!v : String(v));
  }
  return o;
}

class PgStore {
  constructor(pool, schema) { this.pool = pool; this.schema = schema; this.lockClient = null; }

  async init() {
    // 1回の往復で流す（DBが遠くても起動が遅くならないように）
    const sql = [];
    for (const [name, cols] of Object.entries(this.schema)) {
      sql.push(`CREATE TABLE IF NOT EXISTS ${q(name)} (id bigint PRIMARY KEY)`);
      for (const [col, t] of cols) sql.push(`ALTER TABLE ${q(name)} ADD COLUMN IF NOT EXISTS ${q(col)} ${TYPE[t]}`);
    }
    sql.push(`CREATE TABLE IF NOT EXISTS app_files (
        id text PRIMARY KEY, name text NOT NULL, mime text NOT NULL, content bytea NOT NULL,
        created_by text, created_at timestamptz NOT NULL DEFAULT now())`);
    sql.push(`CREATE TABLE IF NOT EXISTS job_runs (job text NOT NULL, run_key text NOT NULL, ran_at timestamptz NOT NULL DEFAULT now(), result text, PRIMARY KEY (job, run_key))`);
    // よく使う絞り込み用の索引
    const idx = [['punch_log', 'emp_id, work_date'], ['requests', 'emp_id, work_date'], ['daily', 'emp_id, work_date'], ['monthly', 'emp_id, ym'], ['audit_log', 'at']];
    for (const [t, cols] of idx) sql.push(`CREATE INDEX IF NOT EXISTS ${q('ix_' + t)} ON ${q(t)} (${cols})`);
    await this.pool.query(sql.join(';\n'));
  }

  /** 書き込み担当の確保。取れるまで待つ（前のインスタンスが止まるまで） */
  async acquireWriterLock(onWait) {
    this.lockClient = await this.pool.connect();
    // ロックを持つ接続が切れたら書き込み担当でなくなるため、プロセスを終了して再起動に任せる
    this.lockClient.on('error', e => { console.error('writer lock connection lost:', e.message); process.exit(1); });
    for (;;) {
      const r = await this.lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
      if (r.rows[0].ok) return;
      if (onWait) onWait();
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  async releaseWriterLock() {
    if (!this.lockClient) return;
    try { await this.lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (e) { /* 接続が切れていれば解放済み */ }
    this.lockClient.release();
    this.lockClient = null;
  }

  async load() {
    const tables = {};
    for (const [name, cols] of Object.entries(this.schema)) {
      if (WRITE_ONLY.has(name)) {
        const max = await this.pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${q(name)}`);
        tables[name] = { rows: [], seq: Number(max.rows[0].m), writeOnly: true };
        continue;
      }
      const r = await this.pool.query(`SELECT * FROM ${q(name)} ORDER BY id`);
      const rows = r.rows.map(row => fromDb(cols, row));
      tables[name] = { rows, seq: rows.length ? rows[rows.length - 1]._id : 0 };
    }
    return tables;
  }

  async commit(ops, files) {
    if (!ops.length && !files.length) return;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      let i = 0;
      while (i < ops.length) {
        const op = ops[i];
        if (op.op === 'insert') {
          // 同じテーブルへの連続した追加はまとめて書く
          const batch = [];
          while (i < ops.length && ops[i].op === 'insert' && ops[i].table === op.table && batch.length < 300) batch.push(ops[i++].row);
          await this.insertMany(c, op.table, batch);
          continue;
        }
        const cols = this.schema[op.table];
        if (op.op === 'update') {
          const sets = cols.map(([col], k) => `${q(col)} = $${k + 2}`).join(', ');
          await c.query(`UPDATE ${q(op.table)} SET ${sets} WHERE id = $1`, [op.row._id, ...cols.map(([col]) => op.row[col])]);
        } else if (op.op === 'delete') {
          await c.query(`DELETE FROM ${q(op.table)} WHERE id = ANY($1::bigint[])`, [op.ids]);
        }
        i++;
      }
      for (const f of files) {
        const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8');
        await c.query('INSERT INTO app_files (id, name, mime, content, created_by) VALUES ($1, $2, $3, $4, $5)', [f.id, f.name, f.mime, buf, f.created_by || '']);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  async insertMany(c, table, rows) {
    const cols = this.schema[table], names = ['id', ...cols.map(x => x[0])];
    const vals = [], params = [];
    rows.forEach((r, j) => {
      const base = j * names.length;
      vals.push('(' + names.map((_, k) => '$' + (base + k + 1)).join(', ') + ')');
      params.push(r._id, ...cols.map(([col]) => r[col]));
    });
    await c.query(`INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES ${vals.join(', ')}`, params);
  }

  async getFile(id) {
    const r = await this.pool.query('SELECT id, name, mime, content, created_by, created_at FROM app_files WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  /** 定時処理の二重実行防止：同じ job・run_key は1回だけ true */
  async claimJob(job, runKey) {
    const r = await this.pool.query('INSERT INTO job_runs (job, run_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING job', [job, runKey]);
    return r.rowCount === 1;
  }
  async finishJob(job, runKey, result) {
    await this.pool.query('UPDATE job_runs SET result = $3 WHERE job = $1 AND run_key = $2', [job, runKey, String(result).slice(0, 4000)]);
  }

  /** 全テーブル（audit_log を含む）を読む（Excel 出力用） */
  async dumpAll() {
    const out = {};
    for (const [name, cols] of Object.entries(this.schema)) {
      const r = await this.pool.query(`SELECT * FROM ${q(name)} ORDER BY id`);
      out[name] = r.rows.map(row => fromDb(cols, row));
    }
    return out;
  }
}

/** テスト・ローカル確認用：コミット済みの状態を別に持ち、失敗時はそこから戻す */
class MemoryStore {
  constructor(schema) { this.schema = schema; this.committed = {}; this.files = new Map(); this.jobs = new Map(); for (const n of Object.keys(schema)) this.committed[n] = { rows: [], seq: 0 }; }
  async init() {}
  async acquireWriterLock() {}
  async releaseWriterLock() {}
  async load() {
    const t = {};
    for (const [n, v] of Object.entries(this.committed)) t[n] = { rows: WRITE_ONLY.has(n) ? [] : v.rows.map(r => ({ ...r })), seq: v.seq, writeOnly: WRITE_ONLY.has(n) };
    return t;
  }
  async commit(ops, files) {
    for (const op of ops) {
      const t = this.committed[op.table];
      if (op.op === 'insert') { t.rows.push({ ...op.row }); t.seq = Math.max(t.seq, op.row._id); }
      else if (op.op === 'update') { const i = t.rows.findIndex(r => r._id === op.row._id); if (i >= 0) t.rows[i] = { ...op.row }; }
      else if (op.op === 'delete') { const s = new Set(op.ids); t.rows = t.rows.filter(r => !s.has(r._id)); }
    }
    for (const f of files) this.files.set(f.id, { ...f, content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8'), created_at: new Date() });
  }
  async getFile(id) { return this.files.get(id) || null; }
  async claimJob(job, key) { const k = job + '|' + key; if (this.jobs.has(k)) return false; this.jobs.set(k, ''); return true; }
  async finishJob(job, key, result) { this.jobs.set(job + '|' + key, result); }
  async dumpAll() { const o = {}; for (const [n, v] of Object.entries(this.committed)) o[n] = v.rows.map(r => ({ ...r })); return o; }
}

module.exports = { PgStore, MemoryStore, WRITE_ONLY };
