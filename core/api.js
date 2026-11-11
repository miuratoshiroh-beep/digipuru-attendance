/**
 * 画面から呼ぶ関数（POST /api/関数名。画面側は google.script.run と同じ書き方で呼ぶ）
 * すべての関数は呼び出した人の権限を確認してから値を返す
 */

/* ---------- 共通 ---------- */
function guard_(fn) {
  try {
    return fn();
  } catch (e) {
    if (e && e.userFacing) throw new Error(e.message);
    console.error(e && e.stack ? e.stack : e);
    throw new Error('処理中にエラーが発生しました。時間をおいて再度お試しください。続く場合は管理者に連絡してください（' + (e && e.message ? e.message : e) + '）');
  }
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw UserError('混み合っています。数秒後にもう一度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}
function me_(c) {
  var email = Util.userEmail();
  var emp = c.byEmail[email];
  if (!email) throw UserError('Googleアカウントを確認できません。社用アカウント（@g.takayoshi.co.jp）でログインしてください');
  if (!emp || !emp.active) throw UserError('このアカウント（' + email + '）は登録されていません。管理者に連絡してください');
  return emp;
}
function isApprover_(c, me) {
  return me.role === 'admin' || me.role === 'approver' || c.employees.some(function (e) { return e.approver_email === me.email; });
}
function requireAdmin_(me) { if (me.role !== 'admin') throw UserError('この操作は管理者のみ行えます'); }
function checkYm_(ym) { if (!/^\d{4}-\d{2}$/.test(String(ym))) throw UserError('月の指定が正しくありません'); return ym; }
function checkDate_(d) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw UserError('日付の指定が正しくありません'); return d; }
function empSummary_(c, e) {
  return {
    emp_id: e.emp_id, emp_no: e.emp_no, name: e.name, section: e.section, division: e.division, job: e.job,
    work_type: e.work_type, typeLabel: Calc.TYPE_LABEL[e.work_type] || e.work_type, role: e.role,
    limit: Calc.limitFor(e, c.ag), sched_start: e.sched_start, sched_end: e.sched_end, sched_min: e.sched_min,
    approver: e.approver_email ? (c.byEmail[e.approver_email] ? c.byEmail[e.approver_email].name : e.approver_email) : ''
  };
}
function serializeDay_(c) {
  return {
    date: c.date, dow: c.dow, type: c.type, holidayName: c.holidayName,
    punchIn: c.punchIn, punchOut: c.punchOut, preStart: c.preStart, preEnd: c.preEnd, preReason: c.preReason, preApprover: c.preApprover,
    leaveType: c.leaveType, leaveName: c.leaveType ? Calc.LEAVE[c.leaveType].name : '', leaveDays: c.leaveDays,
    a: c.a, b: c.b, lunch: c.lunch, extraBreak: c.extraBreak, extraBreakNote: c.extraBreakNote,
    deviation: c.deviation, deviationNote: c.deviationNote,
    work: c.work, r: c.r, w40: c.w40, night: c.night, hol: c.hol, real: c.real, staggered: c.staggered,
    flags: c.flags, flagLabels: c.flags.map(function (f) { return Calc.FLAG_LABEL[f] || f; }), note: c.note,
    makeup: c.makeup, lack: c.lack, filled: c.filled, offsetFrom: c.offsetFrom, offsetTo: c.offsetTo
  };
}
// 乖離判定に使う終業予定（事前申請と中抜け補填の遅いほう）
function planEnd_(c, emp, d) {
  return Math.max(emp.sched_end + (c.rules.makeup_enabled ? (d.extraBreak || 0) : 0), d.preEnd || 0);
}
function monthPayload_(c, emp, ym) {
  var m = Domain.month(c, emp, ym);
  var an = Domain.annual(c, emp, ym, m.totals);
  return {
    emp: empSummary_(c, emp), ym: ym, rows: m.rows.map(serializeDay_), totals: m.totals,
    stageLabel: Calc.STAGE_LABEL[m.totals.stage], annual: an, status: Domain.status(emp.emp_id, ym),
    pending: Domain.pendingDates(emp.emp_id), today: c.today
  };
}
function issuesOf_(c, emp) {
  var out = [], pend = Domain.pendingDates(emp.emp_id), cur = c.today.slice(0, 7), prev = Calc.addMonths(cur, -1);
  [prev, cur].forEach(function (ym) {
    if (Domain.isClosed(ym)) return;
    Domain.month(c, emp, ym).rows.forEach(function (d) {
      var f = d.flags.filter(function (x) { return Calc.ISSUE_FLAGS.indexOf(x) >= 0; })[0];
      if (f && !pend[d.date]) out.push({ date: d.date, flag: f, label: Calc.FLAG_LABEL[f], punchIn: d.punchIn, punchOut: d.punchOut, planEnd: planEnd_(c, emp, d) });
    });
  });
  return out;
}

/* ---------- 起動・ホーム ---------- */
function apiBootstrap() {
  return guard_(function () {
    var c = Domain.ctx(), me = me_(c);
    return {
      me: empSummary_(c, me), isApprover: isApprover_(c, me), isAdmin: me.role === 'admin',
      today: c.today, nowMin: c.nowMin,
      rules: { deviation_grace_min: c.rules.deviation_grace_min, ot_unit_min: c.rules.ot_unit_min || 1, lunch_start: c.rules.lunch_start, lunch_end: c.rules.lunch_end, makeup_enabled: !!c.rules.makeup_enabled, offset_enabled: !!c.rules.offset_enabled },
      leaveTypes: Object.keys(Calc.LEAVE).map(function (k) { return { key: k, name: Calc.LEAVE[k].name }; }),
      dataUrl: me.role === 'admin' ? Repo.url() : ''
    };
  });
}

function apiHome() {
  return guard_(function () { var c = Domain.ctx(); return home_(c, me_(c)); });
}
function home_(c, me) {
  var cur = c.today.slice(0, 7), prev = Calc.addMonths(cur, -1);
  var m = Domain.month(c, me, cur);
  var today = m.rows.filter(function (d) { return d.date === c.today; })[0];
  var yest = Calc.addDays(c.today, -1);
  var yIn = Domain.inputsFor(me.emp_id, yest, yest)[yest] || {};
  var openYesterday = yIn.in != null && yIn.out == null && c.nowMin < 300;
  var st = today.punchIn == null ? (openYesterday ? 'on_yesterday' : 'before') : (today.punchOut == null ? 'on' : 'done');
  var prevStatus = Domain.status(me.emp_id, prev);
  // 運用開始前の月・勤怠対象外の人には前月の確定を求めない
  if (me.exempt || (c.rules.operation_start && prev < String(c.rules.operation_start).slice(0, 7))) prevStatus = { confirmed: true, approved: true, closed: false, notRequired: true };
  return {
    today: serializeDay_(today), state: st, nowMin: c.nowMin, date: c.today,
    totals: m.totals, stageLabel: Calc.STAGE_LABEL[m.totals.stage], annual: Domain.annual(c, me, cur, m.totals),
    issues: issuesOf_(c, me),
    prev: { ym: prev, status: prevStatus, deadline: Calc.nthBusinessDay(cur, c.rules.close_deadline_bizday, c.rules, c.holidays) },
    emp: empSummary_(c, me)
  };
}

/* ---------- 打刻 ---------- */
function apiPunch(kind, userAgent) {
  return guard_(function () {
    if (kind !== 'IN' && kind !== 'OUT') throw UserError('打刻の種類が正しくありません');
    var result = withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c), today = c.today, now = c.nowMin;
      var yest = Calc.addDays(today, -1);
      var inp = Domain.inputsFor(me.emp_id, yest, today);
      var t = inp[today] || {}, y = inp[yest] || {};
      var workDate = today, minute = now;
      if (kind === 'IN') {
        if (t.in != null) throw UserError('今日の出勤はすでに記録されています（' + Calc.hhmm(t.in) + '）');
      } else {
        if (t.in != null && t.out == null) { /* 今日の退勤 */ }
        else if (t.in == null && y.in != null && y.out == null && now < 300) { workDate = yest; minute = now + 1440; }
        else if (t.out != null) throw UserError('今日の退勤はすでに記録されています（' + Calc.hhmm(t.out) + '）');
        else throw UserError('今日の出勤の記録がありません。打刻の修正を申請してください');
      }
      if (Domain.isClosed(workDate.slice(0, 7))) throw UserError('この月は締め済みのため打刻できません');
      Repo.append('punch_log', [{
        log_id: Util.id('P'), emp_id: me.emp_id, kind: kind, minute: minute, work_date: workDate,
        punched_at: Util.stamp(), source: 'web', req_id: '', user_agent: String(userAgent || '').slice(0, 200), created_at: Util.stamp()
      }]);
      Repo.clearCache();
      return { c: Domain.ctx(), meId: me.emp_id };
    });
    var c2 = result.c, me2 = c2.byId[result.meId];
    if (kind === 'OUT') { try { Notify.checkStages(c2, me2); } catch (e) { console.error(e); } }
    return home_(c2, me2);
  });
}

/* ---------- マイ勤怠 ---------- */
function apiMonth(ym, empId) {
  return guard_(function () {
    checkYm_(ym);
    var c = Domain.ctx(), me = me_(c);
    var emp = empId ? c.byId[empId] : me;
    if (!emp || !Domain.canSee(c, me, emp)) throw UserError('この社員の勤怠は表示できません');
    return monthPayload_(c, emp, ym);
  });
}

/* ---------- 申請 ---------- */
function apiMyRequests() {
  return guard_(function () {
    var c = Domain.ctx(), me = me_(c);
    return Repo.all('requests').filter(function (r) { return r.emp_id === me.emp_id; })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).slice(0, 60).map(function (r) { return requestView_(c, r); });
  });
}
function requestView_(c, r) {
  var e = c.byId[r.emp_id];
  return {
    req_id: r.req_id, emp_id: r.emp_id, empName: e ? e.name : r.emp_id, kind: r.kind, work_date: r.work_date,
    pre_start: r.pre_start, pre_end: r.pre_end, is_post: r.is_post, in_time: r.in_time, out_time: r.out_time,
    leave_type: r.leave_type, leaveName: Calc.LEAVE[r.leave_type] ? Calc.LEAVE[r.leave_type].name : '',
    reason: r.reason, status: r.status, approver_name: r.approver_name, decided_at: r.decided_at, comment: r.comment, created_at: r.created_at,
    before: r.kind === 'fix' ? (function () { var x = Domain.inputsFor(r.emp_id, r.work_date, r.work_date)[r.work_date] || {}; return { in: x.in == null ? null : x.in, out: x.out == null ? null : x.out }; })() : null
  };
}
function apiSubmitRequest(p) {
  return guard_(function () {
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c);
      p = p || {};
      var kind = p.kind, date = checkDate_(p.date);
      if (['pre', 'fix', 'leave'].indexOf(kind) < 0) throw UserError('申請の種類が正しくありません');
      if (Domain.isClosed(date.slice(0, 7))) throw UserError(Number(date.slice(5, 7)) + '月度は締め済みのため申請できません。経理に相談してください');
      var reason = String(p.reason || '').trim();
      if (!reason) throw UserError('理由を入力してください');
      if (Repo.all('requests').some(function (r) { return r.emp_id === me.emp_id && r.work_date === date && r.kind === kind && r.status === 'pending'; }))
        throw UserError('この日の同じ申請がすでに承認待ちです');
      var row = {
        req_id: Util.id('R'), emp_id: me.emp_id, kind: kind, work_date: date, pre_start: '', pre_end: '', is_post: false,
        in_time: '', out_time: '', leave_type: '', reason: reason.slice(0, 200), status: 'pending',
        approver_email: '', approver_name: '', decided_at: '', comment: '', created_at: Util.stamp()
      };
      var dt = Calc.dayType(date, c.rules, c.holidays);
      if (kind === 'pre') {
        if (me.work_type !== 'fixed') throw UserError('残業・早出の事前申請は固定時間制の社員が対象です');
        var s = Calc.parseHm(p.preStart), e = Calc.parseHm(p.preEnd);
        if (s == null && e == null) throw UserError('早出開始か終業予定を入力してください');
        var u = c.rules.ot_unit_min || 1;
        if ((s != null && s % u) || (e != null && e % u)) throw UserError('早出開始・終業予定は' + u + '分単位で入力してください（例：18:40に退勤 → 18:30）');
        if (dt === 'work' && s != null && s >= me.sched_start) throw UserError('早出開始は始業（' + Calc.hhmm(me.sched_start) + '）より前の時刻にしてください');
        if (dt === 'work' && e != null && e <= me.sched_end) throw UserError('終業予定は終業（' + Calc.hhmm(me.sched_end) + '）より後の時刻にしてください');
        if (s != null && e != null && e <= s) throw UserError('終業予定は早出開始より後の時刻にしてください');
        row.pre_start = s == null ? '' : Calc.hhmm(s);
        row.pre_end = e == null ? '' : Calc.hhmm(e);
        row.is_post = date < c.today || (date === c.today && e != null && c.nowMin > e);
      } else if (kind === 'fix') {
        if (date > c.today) throw UserError('未来の日付の打刻は修正できません');
        var i = Calc.parseHm(p.inTime), o = Calc.parseHm(p.outTime);
        if (i == null && o == null) throw UserError('出勤か退勤の時刻を入力してください');
        var cur = Domain.inputsFor(me.emp_id, date, date)[date] || {};
        var inM = i != null ? i : cur.in, outM = o != null ? o : cur.out;
        if (o != null && inM != null && o <= inM && o < 300) { o += 1440; outM = o; }  // 日付をまたぐ退勤
        if (inM != null && outM != null && outM <= inM) throw UserError('退勤は出勤より後の時刻にしてください');
        row.in_time = i == null ? '' : Calc.hhmm(i);
        row.out_time = o == null ? '' : Calc.hhmm(o);   // 日付をまたぐ退勤は 25:30 のように24時以降で保持
      } else {
        if (!Calc.LEAVE[p.leaveType]) throw UserError('休暇の種類を選んでください');
        row.leave_type = p.leaveType;
      }
      Repo.append('requests', [row]);
      try { Notify.newRequest(c, me, row); } catch (e2) { console.error(e2); }
      Repo.clearCache();
      return apiMyRequests();
    });
  });
}
function apiCancelRequest(reqId) {
  return guard_(function () {
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c);
      var r = Repo.find('requests', { req_id: reqId });
      if (!r || r.emp_id !== me.emp_id) throw UserError('申請が見つかりません');
      if (r.status !== 'pending') throw UserError('承認待ちの申請だけ取り下げられます');
      r.status = 'cancelled'; r.decided_at = Util.stamp();
      Repo.update('requests', r);
      return apiMyRequests();
    });
  });
}

/* ---------- 乖離理由・休憩等 ---------- */
function apiSaveDayInput(p) {
  return guard_(function () {
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c);
      var date = checkDate_(p.date);
      if (date > c.today) throw UserError('未来の日付には入力できません');
      if (Domain.isClosed(date.slice(0, 7))) throw UserError('この月は締め済みのため変更できません');
      var cur = Repo.find('day_inputs', { emp_id: me.emp_id, work_date: date }) || {};
      var obj = {
        extra_break_min: cur.extra_break_min || 0, extra_break_note: cur.extra_break_note || '',
        deviation: cur.deviation || '', deviation_note: cur.deviation_note || '', updated_at: Util.stamp()
      };
      if (p.extraBreak != null) {
        var m = Number(p.extraBreak);
        if (!(m >= 0 && m <= 480)) throw UserError('休憩等の時間が正しくありません');
        var note = String(p.extraBreakNote || '').trim();
        if (m > 0 && !note) throw UserError('休憩等の事由を入力してください');
        obj.extra_break_min = m; obj.extra_break_note = m > 0 ? note.slice(0, 60) : '';
      }
      if (p.deviation != null) {
        if (p.deviation !== '' && p.deviation !== 'non_work') throw UserError('乖離の区分が正しくありません');
        var dn = String(p.deviationNote || '').trim();
        if (p.deviation === 'non_work' && !dn) throw UserError('業務外だった理由を入力してください');
        obj.deviation = p.deviation; obj.deviation_note = p.deviation ? dn.slice(0, 60) : '';
      }
      Repo.upsert('day_inputs', { emp_id: me.emp_id, work_date: date }, obj);
      Repo.clearCache();
      var c2 = Domain.ctx();
      return monthPayload_(c2, c2.byId[me.emp_id], date.slice(0, 7));
    });
  });
}

/* ---------- 月次の確定 ---------- */
function apiConfirmMonth(ym) {
  return guard_(function () {
    checkYm_(ym);
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c);
      if (Domain.isClosed(ym)) throw UserError('この月は締め済みです');
      if (ym > c.today.slice(0, 7)) throw UserError('この月はまだ確定できません');
      var m = Domain.month(c, me, ym);
      if (m.totals.issues) throw UserError('打刻漏れや乖離理由の未入力が ' + m.totals.issues + '日 残っています。解消してから確定してください');
      var pend = Repo.all('requests').filter(function (r) { return r.emp_id === me.emp_id && r.status === 'pending' && r.work_date.slice(0, 7) === ym; });
      if (pend.length) throw UserError('承認待ちの申請が ' + pend.length + '件 あります。承認されてから確定してください');
      Repo.upsert('month_status', { emp_id: me.emp_id, ym: ym }, { confirmed_at: Util.stamp(), approved_at: '', approved_by: '' });
      Domain.audit('confirm', me.emp_id + ' ' + ym, '');
      try { Notify.confirmed(c, me, ym); } catch (e) { console.error(e); }
      Repo.clearCache();
      return monthPayload_(Domain.ctx(), me, ym);
    });
  });
}

/* ---------- 承認者 ---------- */
function apiApprovals(ym) {
  return guard_(function () {
    var c = Domain.ctx(), me = me_(c);
    if (!isApprover_(c, me)) throw UserError('承認者のみ利用できます');
    ym = ym ? checkYm_(ym) : Calc.addMonths(c.today.slice(0, 7), -1);
    var subs = Domain.subordinates(c, me).filter(function (e) { return e.emp_id !== me.emp_id || me.role === 'admin'; });
    var ids = {}; subs.forEach(function (e) { ids[e.emp_id] = true; });
    var pending = Repo.all('requests').filter(function (r) { return r.status === 'pending' && ids[r.emp_id]; })
      .sort(function (a, b) { return a.work_date < b.work_date ? -1 : 1; }).map(function (r) { return requestView_(c, r); });
    var months = subs.map(function (e) {
      var t = Domain.month(c, e, ym).totals;
      return { emp: empSummary_(c, e), status: Domain.status(e.emp_id, ym), totals: { work: t.work, ot36: t.ot36, premium: t.premium, legalOt: t.legalOt, issues: t.issues } };
    });
    return { ym: ym, pending: pending, months: months };
  });
}
// 1件の申請を処理する（ロックの内側で呼ぶ）。通知の失敗は処理を止めない
function decideOne_(c, me, reqId, approve, comment) {
  var r = Repo.find('requests', { req_id: reqId });
  if (!r) throw UserError('申請が見つかりません');
  var emp = c.byId[r.emp_id];
  if (!emp || !(me.role === 'admin' || emp.approver_email === me.email)) throw UserError('この申請を承認する権限がありません');
  if (emp.emp_id === me.emp_id && me.role !== 'admin') throw UserError('自分の申請は承認できません');
  if (r.status !== 'pending') throw UserError('この申請はすでに処理されています');
  if (Domain.isClosed(r.work_date.slice(0, 7))) throw UserError('この月は締め済みです');
  comment = String(comment || '').trim();
  if (!approve && !comment) throw UserError('差し戻す理由を入力してください');
  r.status = approve ? 'approved' : 'rejected';
  r.approver_email = me.email; r.approver_name = me.name.split(/\s|　/)[0] || me.name;
  r.decided_at = Util.stamp(); r.comment = comment.slice(0, 200);
  Repo.update('requests', r);
  if (approve && r.kind === 'fix') {
    var rows = [];
    if (r.in_time) rows.push({ kind: 'IN', minute: Calc.parseHm(r.in_time) });
    if (r.out_time) rows.push({ kind: 'OUT', minute: Calc.parseHm(r.out_time) });
    Repo.append('punch_log', rows.map(function (x) {
      return { log_id: Util.id('P'), emp_id: r.emp_id, kind: x.kind, minute: x.minute, work_date: r.work_date, punched_at: Util.stamp(), source: 'fix', req_id: r.req_id, user_agent: '', created_at: Util.stamp() };
    }));
  }
  Domain.audit(approve ? 'approve' : 'reject', r.req_id, { kind: r.kind, emp: r.emp_id, date: r.work_date });
  try { Notify.decided(c, emp, r); } catch (e) { console.error(e); }
  return r;
}
function apiDecide(reqId, approve, comment, ym) {
  return guard_(function () {
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c);
      decideOne_(c, me, reqId, approve, comment);
      Repo.clearCache();
      return apiApprovals(ym || Calc.addMonths(c.today.slice(0, 7), -1));
    });
  });
}
/** 選択した申請をまとめて承認する。承認できなかった申請は理由を返し、残りは処理を続ける */
function apiDecideBulk(reqIds, ym) {
  return guard_(function () {
    if (!reqIds || !reqIds.length) throw UserError('承認する申請を選んでください');
    if (reqIds.length > 200) throw UserError('一度に承認できるのは200件までです');
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c), done = 0, failed = [];
      reqIds.forEach(function (id) {
        try { decideOne_(c, me, String(id), true, ''); done++; }
        catch (e) {
          if (!e || !e.userFacing) throw e;
          var r = Repo.find('requests', { req_id: id }), emp = r && c.byId[r.emp_id];
          failed.push({ req_id: id, label: r ? (emp ? emp.name : r.emp_id) + ' ' + r.work_date.slice(5).replace('-', '/') : id, message: e.message });
        }
      });
      if (done) Domain.audit('approve_bulk', done + '件', { failed: failed.length });
      Repo.clearCache();
      return { done: done, failed: failed, appr: isApprover_(c, me) ? apiApprovals(ym || Calc.addMonths(c.today.slice(0, 7), -1)) : null };
    });
  });
}
function approveMonthOne_(c, me, empId, ym) {
  var emp = c.byId[empId];
  if (!emp || !(me.role === 'admin' || emp.approver_email === me.email)) throw UserError('この社員を承認する権限がありません');
  if (Domain.isClosed(ym)) throw UserError('この月は締め済みです');
  var s = Repo.find('month_status', { emp_id: empId, ym: ym });
  if (!s || !s.confirmed_at) throw UserError('本人がまだ確定していません');
  if (s.approved_at) throw UserError('すでに承認済みです');
  s.approved_at = Util.stamp(); s.approved_by = me.email;
  Repo.update('month_status', s);
  Domain.audit('approve_month', empId + ' ' + ym, '');
}
function apiApproveMonth(empId, ym) {
  return guard_(function () {
    checkYm_(ym);
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c);
      approveMonthOne_(c, me, empId, ym);
      Repo.clearCache();
      return apiApprovals(ym);
    });
  });
}
/** 確定済みの月次をまとめて承認する。empIds を省略すると、承認できる確定済み・未承認の全員 */
function apiApproveMonthBulk(empIds, ym) {
  return guard_(function () {
    checkYm_(ym);
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c), done = 0, failed = [];
      if (!empIds || !empIds.length) {
        empIds = Domain.subordinates(c, me).filter(function (e) {
          var st = Domain.status(e.emp_id, ym);
          return st.confirmed && !st.approved && !st.closed;
        }).map(function (e) { return e.emp_id; });
      }
      if (!empIds.length) throw UserError('承認できる確定済みの社員がいません');
      empIds.forEach(function (id) {
        try { approveMonthOne_(c, me, String(id), ym); done++; }
        catch (e) {
          if (!e || !e.userFacing) throw e;
          failed.push({ emp_id: id, label: c.byId[id] ? c.byId[id].name : id, message: e.message });
        }
      });
      Repo.clearCache();
      return { done: done, failed: failed, appr: isApprover_(c, me) ? apiApprovals(ym) : null };
    });
  });
}
function apiTeam(ym) {
  return guard_(function () {
    checkYm_(ym);
    var c = Domain.ctx(), me = me_(c);
    if (!isApprover_(c, me)) throw UserError('承認者のみ利用できます');
    return Domain.subordinates(c, me).map(function (e) { return teamRow_(c, e, ym); });
  });
}
function teamRow_(c, e, ym) {
  var m = Domain.month(c, e, ym), an = Domain.annual(c, e, ym, m.totals);
  var pend = Repo.all('requests').filter(function (r) { return r.emp_id === e.emp_id && r.status === 'pending'; }).length;
  return { emp: empSummary_(c, e), totals: m.totals, stageLabel: Calc.STAGE_LABEL[m.totals.stage], annual: an, pending: pend, status: Domain.status(e.emp_id, ym) };
}

/* ---------- 管理者 ---------- */
function apiAdminMonth(ym) {
  return guard_(function () {
    checkYm_(ym);
    var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
    var rows = c.employees.filter(function (e) { return (e.active && !e.exempt) || Domain.month(c, e, ym).totals.workDays > 0; })
      .map(function (e) { return teamRow_(c, e, ym); });
    var close = Repo.find('month_close', { ym: ym });
    return { ym: ym, rows: rows, closed: !!close, close: close ? { closed_at: close.closed_at, csv_daily_url: close.csv_daily_url, csv_monthly_url: close.csv_monthly_url } : null, dataUrl: Repo.url() };
  });
}
function apiCloseMonth(ym) {
  return guard_(function () {
    checkYm_(ym);
    var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
    var res = withLock_(function () { Repo.clearCache(); return Monthly.close(ym); });
    return { result: res, month: apiAdminMonth(ym) };
  });
}
function apiBuildForms(ym, empId) {
  return guard_(function () {
    checkYm_(ym);
    var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
    var targets = empId && empId !== 'ALL' ? [c.byId[empId]] : c.employees.filter(function (e) { return (e.active && !e.exempt) || Domain.month(c, e, ym).totals.workDays > 0; });
    if (!targets.length || !targets[0]) throw UserError('対象の社員がいません');
    // Excel への転記とPDF化は時間がかかるため、サーバー（server/forms.js）が続きを行う
    return { __async: 'forms', job: Form.prepare(c, ym, targets) };
  });
}
/** 帳票の作成結果を保存する（server/forms.js から呼ぶ） */
function formsSaved_(ym, out) {
  var res = { xlsxUrl: '', pdfUrl: '', results: out.results, stopped: out.stopped };
  res.xlsxUrl = out.xlsxExt === 'zip' ? Files.put(out.name + '.zip', 'application/zip', out.xlsx)
    : Files.put(out.name + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', out.xlsx);
  res.xlsxZip = out.xlsxExt === 'zip';
  if (out.pdf) res.pdfUrl = Files.put(out.name + '.pdf', 'application/pdf', out.pdf);
  Domain.audit('form', ym, { count: out.results.length, problems: out.results.filter(function (r) { return r.problems.length; }).length });
  return res;
}
function apiEmployees() {
  return guard_(function () {
    var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
    return { employees: c.employees.map(function (e) { var s = empSummary_(c, e); s.email = e.email; s.active = e.active; s.limit_class = e.limit_class; return s; }), dataUrl: Repo.url() };
  });
}


/* ---------- マスタ（社員・休日・設定・36協定・帳票の番地）の編集 ---------- */
var MASTER_TABLES = {
  employees: {
    title: '社員', key: 'emp_id', labels: {
      emp_id: '社員ID', emp_no: '社員番号', name: '氏名', email: 'メールアドレス', division: '事業本部', section: '部門', job: '職種',
      role: '権限', approver_email: '承認者のメール', work_type: '勤務区分', limit_class: '上限区分', work_type_next: '変更後の勤務区分',
      work_type_next_from: '変更日', deemed_min: 'みなし時間（分）', sched_start: '始業', sched_end: '終業', sched_min: '所定（分）',
      active: '在籍', joined_on: '入社日', left_on: '退職日', seconded: '出向', exempt: '勤怠対象外', memo: 'メモ'
    },
    choices: { role: ['staff', 'approver', 'admin'], work_type: ['fixed', 'flex', 'disc', 'manager'], work_type_next: ['', 'fixed', 'flex', 'disc', 'manager'], limit_class: ['general', 'restricted'] }
  },
  holidays: { title: '休日', key: 'date', labels: { date: '日付', kind: '区分', name: '名称' }, choices: { kind: ['company', 'legal', 'work'] } },
  rules: { title: '設定', key: 'key', labels: { key: '項目', value: '値', note: '説明' } },
  agreement36: { title: '36協定', key: 'key', labels: { key: '項目', value: '値', note: '説明' } },
  form_map: { title: '帳票の番地', key: 'item', labels: { item: '項目', cell: 'セル', note: '説明' } }
};
function master_(table) {
  var m = MASTER_TABLES[table];
  if (!m) throw UserError('編集できないテーブルです');
  return m;
}
function apiMasterGet(table) {
  return guard_(function () {
    var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
    var m = master_(table);
    var rows = Repo.all(table).map(function (r) { var o = {}; SCHEMA[table].forEach(function (col) { o[col[0]] = r[col[0]]; }); return o; });
    if (table === 'holidays') rows.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return {
      table: table, title: m.title, key: m.key, choices: m.choices || {},
      columns: SCHEMA[table].map(function (col) { return { name: col[0], type: col[1], label: m.labels[col[0]] || col[0] }; }),
      rows: rows, tables: Object.keys(MASTER_TABLES).map(function (k) { return { table: k, title: MASTER_TABLES[k].title }; })
    };
  });
}
/** マスタを丸ごと保存する。点検で不正があれば保存しない */
function apiMasterSave(table, rows) {
  return guard_(function () {
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
      var m = master_(table);
      if (!Array.isArray(rows)) throw UserError('保存する内容が正しくありません');
      var seen = {}, errs = [];
      var clean = rows.map(function (r) { return Repo.norm(table, r || {}); }).filter(function (r) {
        return SCHEMA[table].some(function (col) { return col[1] === 's' ? r[col[0]] !== '' : (col[1] === 'n' ? r[col[0]] != null : false); });
      });
      clean.forEach(function (r, i) {
        if (table === 'employees') { r.email = r.email.trim().toLowerCase(); r.approver_email = r.approver_email.trim().toLowerCase(); }
        if (table === 'holidays') r.kind = r.kind || 'company';
        var k = String(r[m.key]).trim();
        if (!k) errs.push((i + 1) + '行目：' + m.labels[m.key] + 'が空欄です');
        else if (seen[k]) errs.push((i + 1) + '行目：' + m.labels[m.key] + '「' + k + '」が重複しています');
        seen[k] = true;
      });
      if (table === 'employees') {
        var mails = {};
        clean.forEach(function (r) { if (r.email) { if (mails[r.email]) errs.push('メールアドレス ' + r.email + ' が重複しています'); mails[r.email] = true; } });
        if (!clean.some(function (r) { return r.active && r.role === 'admin' && r.email; })) errs.push('在籍中の管理者（role=admin）が1人以上必要です');
        if (!clean.some(function (r) { return r.email === me.email && r.active && r.role === 'admin'; })) errs.push('自分（' + me.email + '）の管理者権限を外す変更はできません');
      }
      if (errs.length) throw UserError(errs.join('\n'));
      Repo.replaceWhere(table, function () { return true; }, clean);
      Repo.clearCache();
      var after = Monthly.validateSettings(Domain.ctx());
      if (after.length) throw UserError('保存できません。次の点を直してください：\n' + after.join('\n'));
      Domain.audit('master_save', table, { rows: clean.length });
      return apiMasterGet(table);
    });
  });
}
/** 日本の祝日（内閣府の祝日）を休日に取り込む。既にある日付は変えない */
function apiImportHolidays(year) {
  return guard_(function () {
    year = Number(year);
    if (!(year >= 2020 && year <= 2100)) throw UserError('年の指定が正しくありません');
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
      var have = {};
      Repo.all('holidays').forEach(function (h) { have[h.date] = true; });
      var add = Host.jpHolidays(year).filter(function (h) { return !have[h.date]; }).map(function (h) { return { date: h.date, kind: 'company', name: h.name }; });
      Repo.append('holidays', add);
      Domain.audit('import_holidays', String(year), { added: add.length });
      var res = apiMasterGet('holidays');
      res.added = add.length;
      return res;
    });
  });
}
/** 保守：締めの取り消し */
function apiReopenMonth(ym) {
  return guard_(function () {
    checkYm_(ym);
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
      if (!Domain.isClosed(ym)) throw UserError(ym + ' は締められていません');
      Monthly.reopen(ym);
      return { ok: true };
    });
  });
}
/** 保守：指定日より前の記録をCSVに書き出してから消す */
function apiArchiveBefore(date) {
  return guard_(function () {
    checkDate_(date);
    return withLock_(function () {
      Repo.clearCache();
      var c = Domain.ctx(), me = me_(c); requireAdmin_(me);
      return Monthly.archiveBefore(date);
    });
  });
}
