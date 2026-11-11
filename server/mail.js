/**
 * メール送信
 *  - gmail：管理者が画面から接続した Google アカウントで Gmail API（HTTPS）から送る。Railway の SMTP 制限に影響されない
 *  - smtp ：SMTP_HOST などの環境変数があれば SMTP で送る（Railway Pro 以上）
 *  - どちらもなければログに出すだけ
 * 接続した Google アカウントの更新トークンは SESSION_SECRET から作った鍵で暗号化して app_settings に保存する
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');

function key() { return crypto.createHash('sha256').update('mail:' + (process.env.SESSION_SECRET || 'dev-secret')).digest(); }
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64) {
  const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function mimeWord(s) { return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }

/** RFC 822 形式のメール（本文は UTF-8 の base64） */
function rfc822({ from, to, subject, body }) {
  const text = Buffer.from(body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    'From: ' + from, 'To: ' + to, 'Subject: ' + mimeWord(subject), 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', text
  ].join('\r\n');
}

function createMailer({ pool, log, oauth }) {
  let smtp = null;
  if (process.env.SMTP_HOST) {
    smtp = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  let gmailCache = null;   // { email, client }

  async function getSetting(k) {
    if (!pool) return null;
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [k]);
    return r.rows[0] ? r.rows[0].value : null;
  }
  async function setSetting(k, v) {
    await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [k, v]);
  }

  async function gmail() {
    if (gmailCache) return gmailCache;
    if (!oauth || !oauth.clientId) return null;
    const enc = await getSetting('gmail_refresh_token');
    if (!enc) return null;
    const client = new OAuth2Client(oauth.clientId, oauth.clientSecret, oauth.redirectUri);
    client.setCredentials({ refresh_token: decrypt(enc) });
    gmailCache = { email: await getSetting('gmail_sender'), client };
    return gmailCache;
  }

  return {
    async init() {
      if (pool) await pool.query('CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    },
    /** 画面の管理タブに出す送信方法 */
    async status() {
      const g = await gmail().catch(() => null);
      if (g) return { mode: 'gmail', sender: g.email };
      if (smtp) return { mode: 'smtp', sender: process.env.MAIL_FROM || process.env.SMTP_USER };
      return { mode: 'none', sender: '' };
    },
    async connectGmail(email, refreshToken) {
      await setSetting('gmail_refresh_token', encrypt(refreshToken));
      await setSetting('gmail_sender', email);
      gmailCache = null;
    },
    async disconnectGmail() {
      if (pool) await pool.query("DELETE FROM app_settings WHERE key IN ('gmail_refresh_token', 'gmail_sender')");
      gmailCache = null;
    },
    async send(m) {
      const g = await gmail();
      if (g) {
        const from = (process.env.MAIL_FROM_NAME ? mimeWord(process.env.MAIL_FROM_NAME) + ' ' : '') + '<' + g.email + '>';
        const res = await g.client.request({
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', method: 'POST',
          data: { raw: b64url(rfc822({ from, to: m.to, subject: m.subject, body: m.body })) }
        });
        log('info', 'mail sent (gmail)', m.to, m.subject, res.data && res.data.id);
        return;
      }
      if (smtp) {
        await smtp.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: m.to, subject: m.subject, text: m.body });
        log('info', 'mail sent (smtp)', m.to, m.subject);
        return;
      }
      log('warn', 'mail not configured', m.to, m.subject);
    }
  };
}

module.exports = { createMailer, rfc822, encrypt, decrypt };
