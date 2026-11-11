/**
 * 日次・月次の保存（daily / monthly シート）、締め、CSV出力、夜間処理
 * daily・monthly は計算結果の写し。正本は打刻ログ・申請・本人入力
 */
var Monthly = (function () {

  function dailyRow(emp, d, at) {
    return {
      emp_id: emp.emp_id, work_date: d.date, day_type: d.type,
      punch_in: Calc.hhmm(d.punchIn), punch_out: Calc.hhmm(d.punchOut),
      pre_start: Calc.hhmm(d.preStart), pre_end: Calc.hhmm(d.preEnd), pre_reason: d.preReason, pre_approver: d.preApprover,
      leave_type: d.leaveType, leave_days: d.leaveDays || null,
      work_start: Calc.hhmm(d.a), work_end: Calc.hhmm(d.b), lunch_min: d.lunch, extra_break_min: d.extraBreak,
      work_min: d.work, ot_daily_min: d.r, w40_min: d.w40, night_min: d.night, holiday_min: d.hol, real_over_min: d.real,
      staggered: d.staggered, flags: d.flags.join(','), note: d.note, calc_at: at,
      makeup_min: d.makeup, lack_min: d.lack, filled_min: d.filled,
      offset_to_min: d.offsetTo.reduce(function (s, o) { return s + o.min; }, 0)
    };
  }
  function monthlyRow(emp, t, closed, at) {
    return {
      emp_id: emp.emp_id, ym: t.ym, work_type: emp.work_type, limit_min: t.limit, work_days: t.workDays,
      paid_days: t.paid, paid_half_days: t.paidHalf, other_days: t.other, other_half_days: t.otherHalf,
      work_min: t.work, ot_daily_min: t.r, w40_min: t.w40, ot36_min: t.ot36, legal_ot_min: t.legalOt, over60_min: t.over60,
      night_min: t.night, premium_min: t.premium, holiday_min: t.hol, health_min: t.health,
      flex_frame_min: t.frame == null ? null : t.frame, form_ot_min: t.formOt, stage: t.stage, closed: !!closed, calc_at: at,
      lack_min: t.lack, offset_hol_min: t.lackHol, offset_ot_min: t.lackOt, lack_left_min: t.lackLeft,
      hol_work_min: t.holWork, hol_pay_min: t.holPay == null ? null : t.holPay, ot_work_min: t.otWork, ot_pay_min: t.otPay == null ? null : t.otPay
    };
  }
  function targets(c, ym) {
    return c.employees.filter(function (e) {
      if (e.joined_on && e.joined_on > ym + '-31') return false;
      if (e.left_on && e.left_on < ym + '-01') return false;
      return true;
    });
  }

  /** 指定月の daily・monthly を計算し直して保存する（締め済みの月は対象外） */
  function persist(c, yms, closedYm) {
    var at = Util.stamp(), dRows = [], mRows = [], set = {};
    yms.forEach(function (ym) {
      if (Domain.isClosed(ym) && ym !== closedYm) return;
      set[ym] = true;
      targets(c, ym).forEach(function (e) {
        var m = Domain.month(c, e, ym);
        m.rows.forEach(function (d) { dRows.push(dailyRow(e, d, at)); });
        mRows.push(monthlyRow(e, m.totals, ym === closedYm, at));
      });
    });
    if (!Object.keys(set).length) return { daily: 0, monthly: 0 };
    Repo.replaceWhere('daily', function (r) { return set[r.work_date.slice(0, 7)]; }, dRows);
    Repo.replaceWhere('monthly', function (r) { return set[r.ym]; }, mRows);
    return { daily: dRows.length, monthly: mRows.length };
  }

  function csv(name, rows) {
    var cols = SCHEMA[name].map(function (x) { return x[0]; });
    var lines = [cols.join(',')].concat(rows.map(function (r) {
      return cols.map(function (k) {
        var v = r[k] == null ? '' : String(r[k]);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }));
    return '﻿' + lines.join('\r\n');
  }

  /** 締め：全員の承認を確認し、スナップショットとCSVを保存する */
  function close(ym) {
    var c = Domain.ctx();
    if (Domain.isClosed(ym)) throw UserError(ym + ' はすでに締め済みです');
    if (ym >= c.today.slice(0, 7)) throw UserError('当月以降は締められません');
    var notApproved = targets(c, ym).filter(function (e) {
      if ((!e.active || e.exempt) && Domain.month(c, e, ym).totals.workDays === 0) return false;
      return !Domain.status(e.emp_id, ym).approved;
    });
    if (notApproved.length) throw UserError('承認が済んでいない社員がいます：' + notApproved.map(function (e) { return e.name; }).join('、'));
    persist(c, [ym], ym);
    var d = Repo.all('daily').filter(function (r) { return r.work_date.slice(0, 7) === ym; });
    var m = Repo.all('monthly').filter(function (r) { return r.ym === ym; });
    var urls = {
      daily: Files.put('勤怠_' + ym + '_daily.csv', 'text/csv; charset=utf-8', csv('daily', d)),
      monthly: Files.put('勤怠_' + ym + '_monthly.csv', 'text/csv; charset=utf-8', csv('monthly', m))
    };
    Repo.append('month_close', [{ ym: ym, closed_at: Util.stamp(), closed_by: Util.userEmail(), csv_daily_url: urls.daily, csv_monthly_url: urls.monthly }]);
    Domain.audit('close', ym, urls);
    return { ym: ym, csv: urls, csvSkipped: false };
  }

  /** 締めの取り消し（管理者が保守画面から実行する） */
  function reopen(ym) {
    var row = Repo.find('month_close', { ym: ym });
    if (!row) throw new Error(ym + ' は締められていません');
    Repo.replaceWhere('month_close', function (r) { return r.ym === ym; }, []);
    Repo.all('monthly').forEach(function (r) { if (r.ym === ym && r.closed) { r.closed = false; Repo.update('monthly', r); } });
    Domain.audit('reopen', ym, '');
    return true;
  }

  /** 勤務区分の変更予約を反映する */
  function applyWorkTypeChanges(c) {
    var changed = [];
    Repo.all('employees').forEach(function (e) {
      if (e.work_type_next && e.work_type_next_from && e.work_type_next_from <= c.today) {
        var before = e.work_type;
        e.work_type = e.work_type_next; e.work_type_next = ''; e.work_type_next_from = '';
        Repo.update('employees', e);
        Domain.audit('work_type', e.emp_id, before + ' -> ' + e.work_type);
        changed.push(e.emp_id);
      }
    });
    return changed;
  }

  /** 設定の点検（不正な値を管理者に知らせる） */
  function validateSettings(c) {
    var errs = [], emails = {};
    Repo.all('employees').forEach(function (e, i) {
      if (!e.emp_id) return;
      var label = '社員 ' + (e.name || e.emp_id);
      if (e.email) emails[e.email.toLowerCase()] = true;
      if (e.email && !/^[^@\s]+@[^@\s]+$/.test(e.email)) errs.push(label + '：メールアドレスが正しくありません');
      if (['fixed', 'flex', 'disc', 'manager'].indexOf(e.work_type) < 0) errs.push(label + '：勤務区分（fixed/flex/disc/manager）が正しくありません');
      if (['general', 'restricted'].indexOf(e.limit_class || 'general') < 0) errs.push(label + '：上限区分（general/restricted）が正しくありません');
      if (e.sched_start && Calc.parseHm(e.sched_start) == null) errs.push(label + '：始業時刻（H:mm）が正しくありません');
      if (e.sched_end && Calc.parseHm(e.sched_end) == null) errs.push(label + '：終業時刻（H:mm）が正しくありません');
      if (['staff', 'approver', 'admin'].indexOf(e.role || 'staff') < 0) errs.push(label + '：権限（staff/approver/admin）が正しくありません');
    });
    Repo.all('employees').forEach(function (e) {
      if (e.approver_email && !emails[e.approver_email.toLowerCase()]) errs.push('社員 ' + e.name + '：承認者 ' + e.approver_email + ' が社員一覧にいません');
    });
    Repo.all('holidays').forEach(function (h) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) errs.push('休日 ' + h.date + '：日付は yyyy-MM-dd で入力してください');
      if (['company', 'legal', 'work'].indexOf(h.kind || 'company') < 0) errs.push('休日 ' + h.date + '：区分（company/legal/work）が正しくありません');
    });
    ['lunch_start', 'lunch_end'].forEach(function (k) { if (c.rules[k] == null || isNaN(c.rules[k])) errs.push('設定 ' + k + ' が正しくありません'); });
    return errs;
  }

  /** 夜間処理（毎日2時） */
  function nightly() {
    var c = Domain.ctx();
    var changed = applyWorkTypeChanges(c);
    if (changed.length) { Repo.clearCache(); c = Domain.ctx(); }
    var ym = c.today.slice(0, 7);
    var res = persist(c, [Calc.addMonths(ym, -1), ym]);
    var stages = 0;
    c.employees.filter(function (e) { return e.active; }).forEach(function (e) {
      try { stages += Notify.checkStages(c, e).length; } catch (err) { console.error(err); }
    });
    var errs = validateSettings(c);
    if (errs.length) {
      Notify.send(c, Domain.admins(c).map(function (a) { return a.email; }), '設定に確認が必要な項目があります', errs.join('\n'));
    }
    return { workTypeChanged: changed, persisted: res, stagesNotified: stages, settingErrors: errs };
  }

  /**
   * 指定日より前の記録（打刻ログ・申請・本人入力・日次）をCSVに書き出してから消す
   * 対象期間の月がすべて締め済みのときだけ実行できる。monthly（月次の写し）は残す
   */
  function archiveBefore(date) {
    var c = Domain.ctx();
    var first = Repo.all('punch_log').reduce(function (m, r) { return !m || r.work_date < m ? r.work_date : m; }, '');
    if (first) {
      for (var ym = first.slice(0, 7); ym < date.slice(0, 7); ym = Calc.addMonths(ym, 1)) {
        if (!Domain.isClosed(ym)) throw UserError(ym + ' が締められていないため移せません');
      }
    }
    var sheets = ['punch_log', 'requests', 'day_inputs', 'daily'];
    var moved = {}, total = 0;
    sheets.forEach(function (n) { moved[n] = Repo.all(n).filter(function (r) { return r.work_date && r.work_date < date; }); total += moved[n].length; });
    if (!total) return { moved: 0 };
    var urls = {};
    sheets.forEach(function (n) {
      urls[n] = Files.put('勤怠アーカイブ_' + n + '_' + date + 'より前.csv', 'text/csv; charset=utf-8', csv(n, moved[n]));
      Repo.replaceWhere(n, function (r) { return r.work_date && r.work_date < date; }, []);
    });
    Domain.audit('archive', date, { moved: total, files: urls });
    return { moved: total, files: urls };
  }

  return { persist: persist, close: close, reopen: reopen, nightly: nightly, validateSettings: validateSettings, csv: csv, archiveBefore: archiveBefore };
})();
