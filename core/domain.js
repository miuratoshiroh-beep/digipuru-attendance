/**
 * 業務ロジックのうちシートの値を集める部分
 * 打刻ログ・申請・本人入力から、Calc に渡す「日ごとの入力」を組み立てる
 */
var Domain = (function () {

  function ctx() {
    var rules = Calc.normalizeRules(Repo.kv('rules'));
    var ag = Calc.normalizeAgreement(Repo.kv('agreement36'));
    var holidays = {};
    Repo.all('holidays').forEach(function (h) { if (h.date) holidays[h.date] = { kind: h.kind || 'company', name: h.name || '' }; });
    var employees = Repo.all('employees').filter(function (e) { return e.emp_id; }).map(Calc.normalizeEmployee);
    var byId = {}, byEmail = {};
    employees.forEach(function (e) { byId[e.emp_id] = e; if (e.email) byEmail[e.email] = e; });
    return {
      rules: rules, ag: ag, holidays: holidays, employees: employees, byId: byId, byEmail: byEmail,
      today: Util.today(), nowMin: Util.nowMin()
    };
  }

  function admins(c) { return c.employees.filter(function (e) { return e.active && e.role === 'admin'; }); }
  function approverOf(c, emp) { return emp.approver_email ? c.byEmail[emp.approver_email] || { email: emp.approver_email, name: emp.approver_email } : null; }
  function subordinates(c, me) {
    if (me.role === 'admin') return c.employees.filter(function (e) { return e.active; });
    return c.employees.filter(function (e) { return e.active && e.approver_email === me.email; });
  }
  function canSee(c, me, emp) {
    if (me.emp_id === emp.emp_id || me.role === 'admin') return true;
    return emp.approver_email === me.email;
  }

  /** 期間内の日ごとの入力 { 'yyyy-MM-dd': { in, out, edited, preStart, ... } } */
  function inputsFor(empId, from, to) {
    var inputs = {};
    function get(d) { return inputs[d] || (inputs[d] = {}); }
    var web = {}, fix = {};
    Repo.all('punch_log').forEach(function (p) {
      if (p.emp_id !== empId || p.work_date < from || p.work_date > to) return;
      var bucket = p.source === 'fix' ? fix : web;
      var key = p.work_date + '|' + p.kind;
      if (p.source === 'fix') {
        if (!bucket[key] || p.created_at >= bucket[key].created_at) bucket[key] = p;
      } else {
        if (!bucket[key]) bucket[key] = p;
        else if (p.kind === 'IN' && p.minute < bucket[key].minute) bucket[key] = p;
        else if (p.kind === 'OUT' && p.minute > bucket[key].minute) bucket[key] = p;
      }
    });
    [web, fix].forEach(function (bucket) {
      Object.keys(bucket).forEach(function (k) {
        var p = bucket[k], d = get(p.work_date);
        if (p.kind === 'IN') d.in = p.minute; else d.out = p.minute;
        if (p.source === 'fix') d.edited = true;
      });
    });
    var pre = {}, leave = {};
    Repo.all('requests').forEach(function (r) {
      if (r.emp_id !== empId || r.status !== 'approved' || r.work_date < from || r.work_date > to) return;
      var target = r.kind === 'pre' ? pre : r.kind === 'leave' ? leave : null;
      if (!target) return;
      if (!target[r.work_date] || r.decided_at >= target[r.work_date].decided_at) target[r.work_date] = r;
    });
    Object.keys(pre).forEach(function (d) {
      var r = pre[d], x = get(d);
      x.preStart = Calc.parseHm(r.pre_start);
      x.preEnd = Calc.parseHm(r.pre_end);
      x.preReason = r.reason;
      x.preApprover = (r.approver_name || '') + ' ' + Util.md(r.decided_at.slice(0, 10));
    });
    Object.keys(leave).forEach(function (d) { if (leave[d].leave_type !== 'cancel') get(d).leaveType = leave[d].leave_type; });
    Repo.all('day_inputs').forEach(function (i) {
      if (i.emp_id !== empId || i.work_date < from || i.work_date > to) return;
      var x = get(i.work_date);
      x.extraBreak = i.extra_break_min || 0;
      x.extraBreakNote = i.extra_break_note;
      x.deviation = i.deviation;
      x.deviationNote = i.deviation_note;
    });
    return inputs;
  }

  function month(c, emp, ym) {
    var from = Calc.weekStart(ym + '-01', c.rules.week_start_dow);
    var to = ym + '-' + Calc.pad2(Calc.daysInMonth(ym));
    return Calc.calcMonth(emp, ym, inputsFor(emp.emp_id, from, to), c.rules, c.holidays, c.today, c.ag);
  }

  function isClosed(ym) { return !!Repo.find('month_close', { ym: ym }); }
  function status(empId, ym) {
    var s = Repo.find('month_status', { emp_id: empId, ym: ym });
    return { confirmed: !!(s && s.confirmed_at), approved: !!(s && s.approved_at), approvedBy: s ? s.approved_by : '', closed: isClosed(ym) };
  }

  /** 年度の累計・上限超の月数・複数月平均の判定 */
  function annual(c, emp, ym, currentTotals) {
    var snap = {};
    Repo.all('monthly').forEach(function (m) {
      if (m.emp_id === emp.emp_id && m.closed) snap[m.ym] = { ym: m.ym, ot36: m.ot36_min || 0, legalOt: m.legal_ot_min || 0, hol: m.holiday_min || 0 };
    });
    function get(y) {
      if (y === ym && currentTotals) return { ym: y, ot36: currentTotals.ot36, legalOt: currentTotals.legalOt, hol: currentTotals.hol };
      if (snap[y]) return snap[y];
      if (y > c.today.slice(0, 7)) return { ym: y, ot36: 0, legalOt: 0, hol: 0 };
      var t = month(c, emp, y).totals;
      return { ym: y, ot36: t.ot36, legalOt: t.legalOt, hol: t.hol };
    }
    var fy = Calc.fiscalMonths(ym, c.rules.fiscal_start_month);
    // 運用開始前の月はデータがないため0として扱う
    var history = fy.map(get);
    var recent = [];
    for (var i = 5; i >= 0; i--) recent.push(get(Calc.addMonths(ym, -i)));
    return Calc.annualJudge(history, recent, Calc.limitFor(emp, c.ag), c.ag);
  }

  function pendingDates(empId) {
    var o = {};
    Repo.all('requests').forEach(function (r) { if (r.emp_id === empId && r.status === 'pending') o[r.work_date] = true; });
    return o;
  }

  function audit(action, target, detail) {
    Repo.append('audit_log', [{ at: Util.stamp(), actor_email: Util.userEmail(), action: action, target: target, detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}) }]);
  }

  return {
    ctx: ctx, admins: admins, approverOf: approverOf, subordinates: subordinates, canSee: canSee,
    inputsFor: inputsFor, month: month, isClosed: isClosed, status: status, annual: annual,
    pendingDates: pendingDates, audit: audit
  };
})();
