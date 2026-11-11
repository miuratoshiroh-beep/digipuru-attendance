/**
 * デジプル 勤務時間管理システム — サーバー（Railway）
 *
 * 環境変数
 *   DATABASE_URL          PostgreSQL（Railway の Postgres を参照）。未設定ならメモリ保存（ローカル確認用、DEV_LOGIN=1 のときだけ）
 *   SESSION_SECRET        ログインのクッキー署名・メール用トークン暗号化の鍵（32文字以上）
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  Google ログイン（OAuth クライアント：ウェブアプリケーション）
 *   APP_URL               公開URL（未設定なら RAILWAY_PUBLIC_DOMAIN から作る）。OAuth のリダイレクト先は APP_URL/auth/callback
 *   ALLOWED_DOMAINS       ログインを許すメールのドメイン（カンマ区切り。既定 g.takayoshi.co.jp）
 *   ADMIN_EMAILS          社員マスタに関係なく「データ取り込み」画面に入れる人（初期移行用。カンマ区切り）
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM  SMTPで送る場合（Railway Pro 以上）
 *   MAIL_FROM_NAME        差出人名（Gmail 送信時）
 *   DEV_LOGIN=1           ローカル確認用のログイン（GOOGLE_CLIENT_ID 未設定のときだけ有効）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const { createEngine, loadSchema } = require('./engine');
const { PgStore, MemoryStore } = require('./store');
const { createMailer } = require('./mail');
const { startJobs } = require('./jobs');
const forms = require('./forms');
const { exportXlsx, parseXlsx } = require('./data-io');

const env = process.env;
const PORT = Number(env.PORT || 3000);
const PROD = env.NODE_ENV === 'production';
const APP_URL = (env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT)).replace(/\/$/, '');
const ALLOWED = (env.ALLOWED_DOMAINS || 'g.takayoshi.co.jp').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SUPER = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DEV_LOGIN = env.DEV_LOGIN === '1' && !env.GOOGLE_CLIENT_ID;
const OAUTH = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: APP_URL + '/auth/callback' };

function log(level, ...a) {
  const line = '[' + new Date().toISOString() + '] ' + level.toUpperCase() + ' ' + a.map(x => x instanceof Error ? (x.stack || x.message) : (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  (level === 'error' ? console.error : console.log)(line);
}

if (PROD && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) { log('error', 'SESSION_SECRET（32文字以上）を設定してください'); process.exit(1); }
if (!env.DATABASE_URL && !DEV_LOGIN) { log('error', 'DATABASE_URL を設定してください'); process.exit(1); }

const schema = loadSchema();
const pool = env.DATABASE_URL ? new Pool({ connectionString: env.DATABASE_URL, max: 5 }) : null;
// 待機中の接続が切れても落ちない（次の処理で接続し直す）
if (pool) pool.on('error', e => log('warn', 'pg idle client error', e.message));
const store = pool ? new PgStore(pool, schema) : new MemoryStore(schema);
const mailer = createMailer({ pool, log, oauth: OAUTH });
const engine = createEngine({ store, appUrl: APP_URL, log, sendMail: m => mailer.send(m) });

/* ---------- 画面（GAS 版の HTML をそのまま使い、google.script.run を fetch に置き換える） ---------- */
const PUB = path.join(__dirname, '..', 'public');
const SHIM = fs.readFileSync(path.join(PUB, 'shim.html'), 'utf8');
const INDEX = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
  .replace("<?!= include('ui/style'); ?>", () => fs.readFileSync(path.join(PUB, 'style.html'), 'utf8'))
  .replace("<?!= include('ui/app'); ?>", () => SHIM + fs.readFileSync(path.join(PUB, 'app.html'), 'utf8'));
const LOGIN = fs.readFileSync(path.join(PUB, 'login.html'), 'utf8');
const IMPORT = fs.readFileSync(path.join(PUB, 'import.html'), 'utf8');

/* ---------- アプリ ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com"
  });
  next();
});
app.use(cookieSession({
  name: 'att', keys: [env.SESSION_SECRET || 'dev-secret-dev-secret-dev-secret!'],
  maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax', secure: APP_URL.startsWith('https://'), httpOnly: true
}));

const oauthClient = () => new OAuth2Client(OAUTH.clientId, OAUTH.clientSecret, OAUTH.redirectUri);
const emailOf = req => (req.session && req.session.email) || '';
const isSuper = email => SUPER.includes(email);
const isAdmin = email => isSuper(email) || ((engine.whoIs(email) || {}).role === 'admin');
const allowedEmail = email => ALLOWED.some(d => email.endsWith('@' + d));

function requireLogin(kind) {
  return (req, res, next) => {
    const email = emailOf(req);
    if (email) return next();
    if (kind === 'api') return res.status(401).json({ error: 'ログインしてください' });
    res.redirect('/login');
  };
}
function requireAdmin(req, res, next) {
  if (!isAdmin(emailOf(req))) return res.status(403).send('この操作は管理者のみ行えます');
  next();
}
// クロスサイトからの POST を防ぐ（画面は必ずこのヘッダーを付ける）
function requireXhr(req, res, next) {
  if (req.get('X-Requested-With') !== 'fetch') return res.status(400).json({ error: '不正なリクエストです' });
  next();
}

app.get('/healthz', (req, res) => res.json({ ok: true, ready: engine.isReady() }));

/* ---------- ログイン ---------- */
app.get('/login', (req, res) => {
  if (emailOf(req)) return res.redirect('/');
  const msg = { domain: '社用アカウント（@' + ALLOWED.join('、@') + '）でログインしてください', state: 'ログインをやり直してください', oauth: 'Googleログインが未設定です（GOOGLE_CLIENT_ID）' }[req.query.e] || '';
  res.type('html').send(LOGIN.replace('{{MSG}}', msg ? '<p class="err">' + msg + '</p>' : '').replace('{{DEV}}', DEV_LOGIN ? '<form class="dev" action="/auth/dev" method="get"><input name="email" placeholder="（開発用）メールアドレス" required><button>開発用ログイン</button></form>' : ''));
});
app.get('/auth/google', (req, res) => {
  if (!OAUTH.clientId) return res.redirect('/login?e=oauth');
  const nonce = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = 'login:' + nonce;
  res.redirect(oauthClient().generateAuthUrl({ scope: ['openid', 'email', 'profile'], state: req.session.oauthState, prompt: 'select_account', hd: ALLOWED.length === 1 ? ALLOWED[0] : undefined }));
});
// 管理者：メール送信に使う Google アカウントを接続する（Gmail API の送信権限）
app.get('/auth/gmail', requireLogin(), requireAdmin, (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = 'gmail:' + nonce;
  res.redirect(oauthClient().generateAuthUrl({ scope: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'], state: req.session.oauthState, access_type: 'offline', prompt: 'consent', login_hint: emailOf(req) }));
});
app.get('/auth/callback', async (req, res) => {
  const state = String(req.query.state || '');
  if (!req.session.oauthState || state !== req.session.oauthState) return res.redirect('/login?e=state');
  req.session.oauthState = null;
  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code || ''));
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: OAUTH.clientId });
    const p = ticket.getPayload(), email = String(p.email || '').toLowerCase();
    if (!p.email_verified || !allowedEmail(email)) return res.redirect('/login?e=domain');
    if (state.startsWith('gmail:')) {
      if (!isAdmin(emailOf(req))) return res.status(403).send('管理者のみ');
      if (!tokens.refresh_token) return res.status(400).send('更新トークンを取得できませんでした。https://myaccount.google.com/permissions でこのアプリの許可を削除してから、もう一度接続してください');
      await mailer.connectGmail(email, tokens.refresh_token);
      log('info', 'gmail connected', email);
      return res.redirect('/#mail-connected');
    }
    req.session.email = email;
    req.session.name = p.name || '';
    res.redirect('/');
  } catch (e) {
    log('error', 'oauth callback', e);
    res.redirect('/login?e=state');
  }
});
if (DEV_LOGIN) {
  app.get('/auth/dev', (req, res) => { req.session.email = String(req.query.email || '').toLowerCase(); res.redirect('/'); });
}
app.get('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

/* ---------- 画面と API ---------- */
app.get('/', requireLogin(), (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(INDEX); });

app.post('/api/:fn', requireLogin('api'), requireXhr, express.json({ limit: '2mb' }), async (req, res) => {
  const email = emailOf(req), fn = req.params.fn;
  try {
    let result = await engine.call(fn, Array.isArray(req.body) ? req.body : [], email);
    if (result && result.__async === 'forms') {
      const out = await forms.render(result.job, (model, r49, t49) => engine.ctx.Form.verify(model, r49, t49));
      result = JSON.parse(JSON.stringify(await engine.internal(email, c => c.formsSaved_(result.job.ym, out))));
    }
    res.json({ result });
  } catch (e) {
    log(/^処理中にエラー|保存に失敗/.test(e.message) ? 'error' : 'warn', fn, email, e.message);
    res.status(e.status || 400).json({ error: e.message });
  }
});

/* ---------- ファイル（締めのCSV・帳票）と全データの出力 ---------- */
function disposition(name, inline) {
  return (inline ? 'inline' : 'attachment') + "; filename=\"download\"; filename*=UTF-8''" + encodeURIComponent(name);
}
app.get('/files/:id', requireLogin(), requireAdmin, async (req, res) => {
  const f = await store.getFile(String(req.params.id));
  if (!f) return res.status(404).send('ファイルが見つかりません');
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': disposition(f.name, /pdf/.test(f.mime)), 'Cache-Control': 'private, no-store' });
  res.send(f.content);
});
app.get('/export/data.xlsx', requireLogin(), requireAdmin, async (req, res) => {
  const buf = await exportXlsx(await store.dumpAll(), schema);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': disposition('デジプル勤怠データ_' + stamp + '.xlsx'), 'Cache-Control': 'no-store' });
  res.send(buf);
});

/* ---------- 管理：データ取り込み・メール送信 ---------- */
app.get('/admin/import', requireLogin(), requireAdmin, (req, res) => { res.type('html').send(IMPORT); });
app.post('/admin/import', requireLogin('api'), requireAdmin, requireXhr, express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  const email = emailOf(req);
  try {
    const { tables, skipped, unknownColumns } = await parseXlsx(req.body, schema);
    const names = Object.keys(tables);
    if (!names.length) return res.status(400).json({ error: '取り込めるシートがありません（シート名をテーブル名にしてください）' });
    const result = await engine.internal(email, c => {
      const counts = {};
      names.forEach(n => { c.Repo.replaceWhere(n, () => true, tables[n]); counts[n] = tables[n].length; });
      c.Domain.audit('import', names.join(','), counts);
      c.Repo.clearCache();
      return { counts, warnings: c.Monthly.validateSettings(c.Domain.ctx()) };
    });
    await engine.seedDefaults();
    log('info', 'import', email, JSON.stringify(result.counts));
    res.json({ result: Object.assign(result, { skipped, unknownColumns }) });
  } catch (e) {
    log('error', 'import', e);
    res.status(400).json({ error: e.message });
  }
});
app.get('/admin/mail', requireLogin('api'), requireAdmin, async (req, res) => {
  res.json({ result: Object.assign(await mailer.status(), { oauth: !!OAUTH.clientId }) });
});
app.post('/admin/mail/test', requireLogin('api'), requireAdmin, requireXhr, async (req, res) => {
  try {
    await mailer.send({ to: emailOf(req), subject: '【勤怠】テストメール', body: '勤怠システムからのテストメールです。\n\n勤怠の画面：' + APP_URL });
    res.json({ result: await mailer.status() });
  } catch (e) { res.status(400).json({ error: 'テストメールを送れませんでした：' + e.message }); }
});
app.post('/admin/mail/disconnect', requireLogin('api'), requireAdmin, requireXhr, async (req, res) => {
  await mailer.disconnectGmail();
  res.json({ result: await mailer.status() });
});

app.use((req, res) => res.status(404).send('見つかりません'));

/* ---------- 起動 ---------- */
let server, jobs;
async function main() {
  server = app.listen(PORT, () => log('info', 'listening on ' + PORT + ' (' + APP_URL + ')'));
  // DBの再起動・移行中は、つながるまで待つ（すぐ終了すると再起動の回数上限に達するため）
  for (let i = 1; ; i++) {
    try { await store.init(); await mailer.init(); break; }
    catch (e) {
      if (i >= 60) throw e;
      log('warn', 'database not reachable, retrying (' + i + '): ' + e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  log('info', 'waiting for writer lock');
  await store.acquireWriterLock(() => log('info', '前のインスタンスの終了を待っています'));
  await engine.init();
  if (!pool && DEV_LOGIN && env.DEV_SEED) await require(path.resolve(env.DEV_SEED))(engine);
  await importFromEnv();
  log('info', 'ready');
  jobs = startJobs({ engine, store, log });
}
/**
 * 環境変数 IMPORT_DATA（{ tables: { テーブル名: [[列名...], [値...], ...] } } を gzip→base64）からの取り込み
 * 画面にログインできない状態での初期移行用。同じ内容は1回だけ（job_runs に記録）。取り込み後は変数を消す
 */
async function importFromEnv() {
  if (!env.IMPORT_DATA) return;
  const zlib = require('zlib');
  const raw = Buffer.from(env.IMPORT_DATA, 'base64');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  if (!(await store.claimJob('import_env', hash))) { log('info', 'IMPORT_DATA ' + hash + ' は取り込み済み。変数を消してください'); return; }
  const data = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  const tables = {};
  for (const [name, rows] of Object.entries(data.tables || {})) {
    if (!schema[name]) continue;
    const head = rows[0];
    tables[name] = rows.slice(1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i]; }); return o; });
  }
  const res = await engine.internal('system', c => {
    const counts = {};
    Object.keys(tables).forEach(n => { c.Repo.replaceWhere(n, () => true, tables[n]); counts[n] = tables[n].length; });
    c.Domain.audit('import', 'IMPORT_DATA ' + hash, counts);
    c.Repo.clearCache();
    return { counts, warnings: c.Monthly.validateSettings(c.Domain.ctx()) };
  });
  await engine.seedDefaults();
  await store.finishJob('import_env', hash, JSON.stringify(res));
  log('info', 'IMPORT_DATA ' + hash + ' imported', JSON.stringify(res));
}

async function shutdown(sig) {
  log('info', 'shutdown ' + sig);
  if (jobs) jobs.stop();
  if (server) server.close();
  await engine.idle();   // 処理中の書き込みを終えてから止める
  try { await store.releaseWriterLock(); } catch (e) { /* ignore */ }
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
main().catch(e => { log('error', 'startup failed', e); process.exit(1); });

module.exports = { app };
