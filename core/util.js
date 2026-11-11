/**
 * 共通ユーティリティ（サーバー版）
 * Host はサーバー（server/engine.js）が差し込む：利用者・現在時刻・URL・メール・ファイル保存
 */
var TZ = 'Asia/Tokyo';

// 現在時刻（テストで差し替えられるように1か所に集約）
var Clock = {
  now: function () { return Host.now ? Host.now() : new Date(); }
};

var Util = {
  fmt: function (d, pattern) { return Utilities.formatDate(d, TZ, pattern); },
  today: function () { return Util.fmt(Clock.now(), 'yyyy-MM-dd'); },
  nowMin: function () { var d = Clock.now(); return Number(Util.fmt(d, 'H')) * 60 + Number(Util.fmt(d, 'm')); },
  stamp: function () { return Util.fmt(Clock.now(), "yyyy-MM-dd'T'HH:mm:ssXXX"); },
  md: function (s) { if (!s) return ''; return Number(s.slice(5, 7)) + '/' + Number(s.slice(8, 10)); },
  id: function (prefix) { return prefix + Util.fmt(Clock.now(), 'yyyyMMddHHmmss') + Math.floor(Math.random() * 1e4); },
  webAppUrl: function () { return Host.appUrl || ''; },
  userEmail: function () { return String(Host.user || '').toLowerCase(); }
};

// 利用者向けのエラー（画面にそのまま表示する）
function UserError(message) { var e = new Error(message); e.userFacing = true; return e; }

// メール送信（送信はコミット後にサーバーが行う）
var MailApp = {
  sendEmail: function (m) { Host.mails.push({ to: m.to, subject: m.subject, body: m.body }); }
};

// 二重実行の防止はサーバー側で1件ずつ処理しているため不要（互換のため残す）
var LockService = {
  getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; }
};

/** ファイル保存（CSV・帳票）。内容はコミット時にDBへ保存し、URL（/files/ID）を返す */
var Files = {
  put: function (name, mime, content) {
    var id = Host.uuid();
    Host.files.push({ id: id, name: name, mime: mime, content: content, created_by: Util.userEmail() });
    return '/files/' + id;
  }
};
