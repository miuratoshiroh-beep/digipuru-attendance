/**
 * 定時処理（server/jobs.js が呼ぶ）
 *  - nightlyJob：毎日2時台。勤務区分の変更予約の反映、daily・monthly の保存、36協定の判定、設定の点検
 *  - morningJob：毎日 notify_hour 時台。打刻漏れ・乖離、前月分の確定依頼とリマインド
 */
function nightlyJob() { return Monthly.nightly(); }
function morningJob() { return Notify.morning(); }
function notifyHour() { return Calc.normalizeRules(Repo.kv('rules')).notify_hour || 7; }

/** 締めの取り消し（例：reopenMonth('2026-12')） */
function reopenMonth(ym) { return Monthly.reopen(ym); }

/** 古い記録をCSVに書き出してから消す（例：archiveBefore('2026-04-01')） */
function archiveBefore(date) { return Monthly.archiveBefore(date); }
