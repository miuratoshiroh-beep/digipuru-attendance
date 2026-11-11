/**
 * メール通知
 * - 36協定の段階到達（同じ月・同じ段階は1回だけ）
 * - 申請の受付・承認結果
 * - 毎朝：打刻漏れ・乖離、前月分の確定依頼とリマインド
 */
var Notify = (function () {

  function send(c, to, subject, body) {
    var list = (to || []).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    if (!list.length) return false;
    if (c.rules.mail_enabled === false) { console.log('[mail disabled] ' + list.join(',') + ' ' + subject); return false; }
    var url = Util.webAppUrl();
    MailApp.sendEmail({
      to: list.join(','),
      subject: '【勤怠】' + subject,
      body: body + (url ? '\n\n勤怠の画面：' + url : '') + '\n\n（このメールは勤務時間管理システムから自動送信しています）'
    });
    return true;
  }

  function recipients(c, emp, roles) {
    var out = [];
    roles.forEach(function (r) {
      if (r === 'self') out.push(emp.email);
      if (r === 'approver' && emp.approver_email) out.push(emp.approver_email);
      if (r === 'admin') Domain.admins(c).forEach(function (a) { out.push(a.email); });
    });
    return out;
  }

  var STAGE_TEXT = {
    caution: '今月の残業が上限の75%に達しました',
    warn: '今月の残業が上限の90%に達しました',
    over: '今月の残業が上限に達しました',
    annual_warn: '年間の残業が600時間に達しました',
    annual_over: '年間の残業が上限（720時間）に達しました',
    over_count: '上限を超えた月が年6回に達しました',
    health: '時間外と休日労働の合計が月80時間を超えました（医師面接の対象です）',
    single: '時間外と休日労働の合計が単月100時間に達しました',
    avg: '時間外と休日労働の複数月平均が80時間を超えました'
  };

  /** 当月の36協定の段階を判定し、新たに到達した段階だけを通知する */
  function checkStages(c, emp) {
    if (emp.exempt) return [];
    var ym = c.today.slice(0, 7);
    var m = Domain.month(c, emp, ym).totals;
    var an = Domain.annual(c, emp, ym, m);
    var reached = Calc.reachedStages(m, an, c.ag);
    var sent = {};
    Repo.all('notices').forEach(function (n) { if (n.emp_id === emp.emp_id && n.ym === ym) sent[n.stage] = true; });
    var newRows = [];
    reached.forEach(function (st) {
      if (sent[st]) return;
      var to = recipients(c, emp, Calc.STAGE_RECIPIENTS[st] || ['self']);
      var body = emp.name + ' さん\n\n' + STAGE_TEXT[st] + '。\n\n' +
        '今月の残業：' + Calc.hm(m.ot36) + '（上限 ' + Calc.hm(m.limit) + '）\n' +
        '年間累計：' + Calc.hm(an.total) + '（上限 ' + Calc.hm(c.ag.annual_limit_min) + '）\n' +
        '上限を超えた月：' + an.overCount + '回（' + c.ag.over_limit_max_count + '回まで）';
      send(c, to, emp.name + '：' + STAGE_TEXT[st], body);
      newRows.push({ notice_id: Util.id('N'), emp_id: emp.emp_id, ym: ym, stage: st, sent_to: to.join(','), sent_at: Util.stamp() });
    });
    if (newRows.length) Repo.append('notices', newRows);
    return newRows.map(function (r) { return r.stage; });
  }

  var KIND = { pre: '残業・早出の事前申請', fix: '打刻の修正', leave: '休暇' };
  function newRequest(c, emp, r) {
    if (!emp.approver_email) return;
    var detail = r.kind === 'pre' ? ('早出開始 ' + (r.pre_start || '—') + '／終業予定 ' + (r.pre_end || '—') + (r.is_post ? '（事後申請）' : ''))
      : r.kind === 'fix' ? ('出勤 ' + (r.in_time || '変更なし') + '／退勤 ' + (r.out_time || '変更なし'))
      : Calc.LEAVE[r.leave_type].name;
    send(c, [emp.approver_email], emp.name + ' さんから' + KIND[r.kind] + '（' + Util.md(r.work_date) + '）',
      emp.name + ' さんから申請がありました。\n\n種類：' + KIND[r.kind] + '\n対象日：' + r.work_date + '\n内容：' + detail + '\n理由：' + r.reason);
  }
  function decided(c, emp, r) {
    var ok = r.status === 'approved';
    send(c, [emp.email], KIND[r.kind] + '（' + Util.md(r.work_date) + '）が' + (ok ? '承認されました' : '差し戻されました'),
      emp.name + ' さん\n\n' + r.work_date + ' の' + KIND[r.kind] + 'が' + (ok ? '承認されました。' : '差し戻されました。') + (r.comment ? '\nコメント：' + r.comment : ''));
  }
  function confirmed(c, emp, ym) {
    if (!emp.approver_email) return;
    send(c, [emp.approver_email], emp.name + ' さんが' + Number(ym.slice(5)) + '月度の勤怠を確定しました',
      emp.name + ' さんが ' + ym + ' の勤怠を確定しました。内容を確認して承認してください。');
  }

  /** 毎朝：前営業日の打刻漏れ・乖離、前月分の確定依頼・リマインド */
  function morning() {
    var c = Domain.ctx();
    var today = c.today;
    if (Calc.dayType(today, c.rules, c.holidays) !== 'work') return { skipped: 'holiday' };
    var target = Calc.prevBusinessDay(today, c.rules, c.holidays);
    var count = 0;
    c.employees.filter(function (e) { return e.active && !e.exempt; }).forEach(function (e) {
      var pend = Domain.pendingDates(e.emp_id);
      if (pend[target] || Domain.isClosed(target.slice(0, 7))) return;
      var rows = Domain.month(c, e, target.slice(0, 7)).rows;
      var d = rows.filter(function (x) { return x.date === target; })[0];
      var f = d && d.flags.filter(function (x) { return Calc.ISSUE_FLAGS.indexOf(x) >= 0; });
      if (f && f.length) {
        send(c, [e.email, e.approver_email], e.name + '：' + Util.md(target) + ' の' + f.map(function (x) { return Calc.FLAG_LABEL[x]; }).join('・'),
          e.name + ' さん\n\n' + target + ' の勤怠に「' + f.map(function (x) { return Calc.FLAG_LABEL[x]; }).join('・') + '」があります。\n' +
          (f.indexOf('DEVIATION') >= 0 ? '終業予定より遅く退勤しています。業務だった場合は残業の事後申請、業務外の場合は理由を入力してください。' : '打刻の修正を申請してください。'));
        count++;
      }
    });
    // 前月分の確定依頼（第1営業日）とリマインド（期限を過ぎてから毎朝）
    var ym = today.slice(0, 7), prev = Calc.addMonths(ym, -1);
    var first = Calc.nthBusinessDay(ym, 1, c.rules, c.holidays);
    var deadline = Calc.nthBusinessDay(ym, c.rules.close_deadline_bizday, c.rules, c.holidays);
    var reminded = 0;
    var started = !c.rules.operation_start || prev >= String(c.rules.operation_start).slice(0, 7);
    if (started && !Domain.isClosed(prev) && (today === first || today > deadline)) {
      c.employees.filter(function (e) { return e.active && !e.exempt && (!e.joined_on || e.joined_on <= prev + '-31'); }).forEach(function (e) {
        var s = Domain.status(e.emp_id, prev);
        if (!s.confirmed) {
          send(c, [e.email], (today === first ? '' : '【期限超過】') + Number(prev.slice(5)) + '月度の勤怠を確定してください',
            e.name + ' さん\n\n' + prev + ' の勤怠を確認し、「確定」してください。期限は ' + deadline + '（第' + c.rules.close_deadline_bizday + '営業日）です。');
          reminded++;
        } else if (!s.approved && today > deadline && e.approver_email) {
          send(c, [e.approver_email], e.name + ' さんの' + Number(prev.slice(5)) + '月度の勤怠が承認待ちです',
            e.name + ' さんは ' + prev + ' の勤怠を確定済みです。内容を確認して承認してください。');
          reminded++;
        }
      });
    }
    return { target: target, issues: count, reminded: reminded };
  }

  return { send: send, checkStages: checkStages, newRequest: newRequest, decided: decided, confirmed: confirmed, morning: morning };
})();
