/**
 * 計算ロジック（純粋関数）。GAS と Node（Jest）の両方で動く。
 * - 日付は 'yyyy-MM-dd' 文字列、月は 'yyyy-MM'
 * - 時刻・時間はすべて「勤務日の 0:00 からの分」。日付をまたぐ退勤は 1440 以上になる
 * - シートの読み書き・現在時刻の取得はここでは行わない
 */
var Calc = (function () {
  'use strict';

  var DEFAULT_RULES = {
    lunch_start: 720,            // 昼休 12:00
    lunch_end: 780,              // 昼休 13:00
    lunch_min: 60,               // 帳票の B10（休憩時間）
    lunch_apply_min: 360,        // 就業時間帯がこれを超える日は昼休を lunch_min 控除（帳票の計算式と一致させる）
    legal_holiday_dow: 0,        // 法定休日の曜日（0=日）
    week_start_dow: 0,           // 週の起算日（0=日）
    deviation_grace_min: 29,     // 乖離とみなす猶予（30分単位の申請に合わせ、次の単位に届くまでは乖離にしない）
    ot_unit_min: 30,             // 残業・早出の申請単位（終業側は切り捨て、早出側は切り上げ）
    stagger_grace_min: 15,       // 時差出勤とみなす猶予
    flex_frame_mode: 'calendar', // calendar: 40h×暦日/7、workdays: 所定労働日数×8h
    w40_counts_in_limit: true,   // 36協定の「月42時間」に週40時間超を含める
    fiscal_start_month: 4,
    close_deadline_bizday: 3,
    operation_start: '',        // 運用開始日。これより前の日は記録なし・打刻漏れを判定しない
    makeup_enabled: true,        // 中抜け（③休憩等）の分だけ、申請なしで終業後に勤務できる
    offset_enabled: true,        // 平日の不足（遅刻・早退・中抜け）を同じ月の休日出勤・残業で充当する
    offset_order: 'holiday_first' // 充当の順：holiday_first（休日出勤→残業）/ overtime_first（残業→休日出勤）
  };

  var DEFAULT_AGREEMENT = {
    limit_general_min: 2520,     // 月42時間
    limit_restricted_min: 2400,  // 月40時間（管理職・営業・裁量労働）
    over_limit_max_count: 6,
    annual_limit_min: 43200,     // 年720時間
    annual_warn_min: 36000,      // 年600時間
    caution_ratio: 0.75,
    warn_ratio: 0.9,
    single_month_cap_min: 6000,  // 単月100時間未満（休日労働含む）
    avg_cap_min: 4800,           // 2〜6ヶ月平均80時間以内（休日労働含む）
    health_min: 4800             // 時間外＋休日労働 月80時間超
  };

  var LEAVE = {
    paid_full:  { label: '有給休暇',   paid: true,  days: 1,   name: '有給（全日）' },
    paid_am:    { label: '有給休暇',   paid: true,  days: 0.5, name: '有給（午前）' },
    paid_pm:    { label: '有給休暇',   paid: true,  days: 0.5, name: '有給（午後）' },
    other_full: { label: 'その他の休', paid: false, days: 1,   name: 'その他の休' },
    other_am:   { label: 'その他の休', paid: false, days: 0.5, name: 'その他の休（午前）' },
    other_pm:   { label: 'その他の休', paid: false, days: 0.5, name: 'その他の休（午後）' }
  };

  var FLAG_LABEL = {
    NO_RECORD: '記録なし',
    MISSING_IN: '出勤未打刻',
    MISSING_OUT: '退勤未打刻',
    DEVIATION: '乖離理由未入力',
    BREAK_SHORT: '休憩要確認',
    EDITED: '修正済'
  };
  var ISSUE_FLAGS = ['NO_RECORD', 'MISSING_IN', 'MISSING_OUT', 'DEVIATION'];
  var TYPE_LABEL = { fixed: '固定時間制', flex: 'フレックス', disc: '裁量労働', manager: '管理職' };
  var DOW = '日月火水木金土';

  /* ---------- 日付・時刻 ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function utc(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +(p[2] || 1))); }
  function ymd(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function addDays(s, n) { var d = utc(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
  function dow(s) { return utc(s).getUTCDay(); }
  function ymOf(s) { return s.slice(0, 7); }
  function addMonths(ym, n) { var d = utc(ym + '-01'); d.setUTCMonth(d.getUTCMonth() + n); return ymd(d).slice(0, 7); }
  function daysInMonth(ym) { var p = ym.split('-'); return new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate(); }
  function monthDays(ym) { var n = daysInMonth(ym), out = []; for (var i = 1; i <= n; i++) out.push(ym + '-' + pad2(i)); return out; }
  function weekStart(s, wsd) { var diff = (dow(s) - wsd + 7) % 7; return addDays(s, -diff); }
  function floorUnit(min, unit) { return Math.floor(min / unit) * unit; }
  function hm(min) { if (min == null || min === '') return ''; var m = Math.round(min), sign = m < 0 ? '-' : ''; m = Math.abs(m); return sign + Math.floor(m / 60) + ':' + pad2(m % 60); }
  function hhmm(min) { if (min == null || min === '') return ''; var m = Math.round(min); return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
  function parseHm(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    var m = String(v).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }
  function overlap(a, b, c, d) { return Math.max(0, Math.min(b, d) - Math.max(a, c)); }
  function toBool(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1'; }

  /* ---------- 設定の正規化 ---------- */
  var TIME_KEYS = ['lunch_start', 'lunch_end'];
  var BOOL_KEYS = ['w40_counts_in_limit', 'print_approver_name', 'mail_enabled', 'makeup_enabled', 'offset_enabled'];
  function normalizeRules(raw) {
    var r = {}, k;
    for (k in DEFAULT_RULES) r[k] = DEFAULT_RULES[k];
    for (k in (raw || {})) {
      var v = raw[k];
      if (v === '' || v == null) continue;
      if (TIME_KEYS.indexOf(k) >= 0) r[k] = parseHm(v);
      else if (BOOL_KEYS.indexOf(k) >= 0) r[k] = toBool(v);
      else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) r[k] = Number(v);
      else r[k] = v;
    }
    return r;
  }
  function normalizeAgreement(raw) {
    var a = {}, k;
    for (k in DEFAULT_AGREEMENT) a[k] = DEFAULT_AGREEMENT[k];
    for (k in (raw || {})) { if (raw[k] !== '' && raw[k] != null) a[k] = Number(raw[k]); }
    return a;
  }
  function normalizeEmployee(e) {
    return {
      emp_id: String(e.emp_id),
      emp_no: e.emp_no == null ? '' : String(e.emp_no),
      name: e.name || '',
      email: (e.email || '').toLowerCase(),
      division: e.division || '',
      section: e.section || '',
      job: e.job || '',
      role: e.role || 'staff',
      approver_email: (e.approver_email || '').toLowerCase(),
      work_type: e.work_type || 'fixed',
      limit_class: e.limit_class || 'general',
      deemed_min: e.deemed_min === '' || e.deemed_min == null ? 480 : Number(e.deemed_min),
      sched_start: parseHm(e.sched_start) == null ? 510 : parseHm(e.sched_start),
      sched_end: parseHm(e.sched_end) == null ? 1050 : parseHm(e.sched_end),
      sched_min: e.sched_min === '' || e.sched_min == null ? 480 : Number(e.sched_min),
      active: e.active === '' || e.active == null ? true : toBool(e.active),
      joined_on: e.joined_on || '',
      left_on: e.left_on || '',
      seconded: toBool(e.seconded),
      exempt: toBool(e.exempt)
    };
  }

  /* ---------- 日種別 ---------- */
  // holidays: { 'yyyy-MM-dd': { kind: 'company'|'legal'|'work', name: '' } }
  function dayType(s, rules, holidays) {
    var h = holidays && holidays[s];
    if (h && (h.kind === 'legal' || h.kind === 'company' || h.kind === 'work')) return h.kind;
    var d = dow(s);
    if (d === rules.legal_holiday_dow) return 'legal';
    if (h || d === 0 || d === 6) return 'company';
    return 'work';
  }
  function isEmployed(emp, s) {
    if (emp.joined_on && s < emp.joined_on) return false;
    if (emp.left_on && s > emp.left_on) return false;
    return true;
  }

  /* ---------- 1日の計算 ---------- */
  /**
   * inp: { in, out, edited, preStart, preEnd, preReason, preApprover, leaveType,
   *        extraBreak, extraBreakNote, deviation('non_work'|''), deviationNote }
   */
  function calcDay(emp, s, inp, rules, holidays, today) {
    inp = inp || {};
    var t = dayType(s, rules, holidays);
    var lv = inp.leaveType && LEAVE[inp.leaveType] ? LEAVE[inp.leaveType] : null;
    var c = {
      date: s, dow: dow(s), type: t, holidayName: holidays && holidays[s] ? (holidays[s].name || '') : '',
      punchIn: inp.in == null ? null : inp.in, punchOut: inp.out == null ? null : inp.out,
      preStart: inp.preStart == null ? null : inp.preStart, preEnd: inp.preEnd == null ? null : inp.preEnd,
      preReason: inp.preReason || '', preApprover: inp.preApprover || '',
      leaveType: lv ? inp.leaveType : '', leaveDays: lv ? lv.days : 0, leavePaid: lv ? lv.paid : false,
      a: null, b: null, lunch: 0, extraBreak: Number(inp.extraBreak) || 0, extraBreakNote: inp.extraBreakNote || '',
      deviation: inp.deviation || '', deviationNote: inp.deviationNote || '',
      work: 0, r: 0, formR: null, w40: 0, night: 0, hol: 0, real: 0, staggered: false, flags: [], note: '',
      makeup: 0, lack: 0, filled: 0, offsetFrom: [], offsetTo: [], judged: false
    };
    var past = s < today;
    var judged = !emp.exempt && (!rules.operation_start || s >= rules.operation_start);
    c.judged = judged;
    var hasIn = c.punchIn != null, hasOut = c.punchOut != null;
    if (inp.edited) c.flags.push('EDITED');

    if (!hasIn && !hasOut) {
      if (judged && !lv && t === 'work' && past && isEmployed(emp, s)) c.flags.push('NO_RECORD');
      c.note = buildNote(c, lv);
      return c;
    }
    if (!hasIn || !hasOut) {
      if (judged && !hasIn && (past || s === today)) c.flags.push('MISSING_IN');
      if (judged && !hasOut && past) c.flags.push('MISSING_OUT');
      c.note = buildNote(c, lv);
      return c;
    }

    var a = c.punchIn, b = c.punchOut;
    if (emp.work_type === 'fixed' && t === 'work') {
      var unit = rules.ot_unit_min || 1;
      // 早出：承認済みの早出開始があるときだけ、申請単位に切り上げて計上（例 7:10 → 7:30）
      if (c.preStart != null && c.punchIn < emp.sched_start) a = Math.min(emp.sched_start, Math.ceil(Math.max(c.punchIn, c.preStart) / unit) * unit);
      else a = Math.max(c.punchIn, emp.sched_start);
      // 中抜け補填：③休憩等の分だけ、申請なしで終業後に勤務できる（例 中抜け1:00 → 18:30まで）
      var makeupEnd = emp.sched_end + (rules.makeup_enabled ? c.extraBreak : 0);
      var appliedEnd = Math.max(emp.sched_end, c.preEnd || 0);
      var planEnd = Math.max(makeupEnd, appliedEnd);
      if (c.deviation === 'non_work') b = Math.min(c.punchOut, planEnd);
      else if (c.punchOut > planEnd + rules.deviation_grace_min) c.flags.push('DEVIATION');
      // 終業：補填の範囲は実時刻、それを超えた分は申請単位に切り捨て、終業予定を上限にする（例 18:40・18:50 → 18:30、19:10 → 19:00）
      else if (c.punchOut > emp.sched_end) b = c.punchOut <= makeupEnd ? c.punchOut : Math.min(planEnd, makeupEnd + Math.floor((c.punchOut - makeupEnd) / unit) * unit);
      if (b > appliedEnd && makeupEnd > appliedEnd) c.makeup = Math.min(b, makeupEnd) - appliedEnd;
      if (c.punchIn > emp.sched_start + rules.stagger_grace_min) c.staggered = true;
      if (a > b) a = b;
    }
    c.a = a; c.b = b;
    var span = b - a;
    c.lunch = span > rules.lunch_apply_min ? rules.lunch_min : overlap(a, b, rules.lunch_start, rules.lunch_end);
    c.work = Math.max(0, span - c.lunch - c.extraBreak);
    c.night = overlap(a, b, 0, 300) + overlap(a, b, 1320, 1740) + overlap(a, b, 2760, 3180);
    var brk = c.lunch + c.extraBreak;
    if ((c.work > 480 && brk < 60) || (c.work > 360 && brk < 45)) c.flags.push('BREAK_SHORT');

    if (t === 'legal') {
      c.hol = c.work; c.real = c.work;
      // 帳票の④（数式）は法定休日も日8時間超を残業として出すため、照合用に保持する
      if (emp.work_type === 'fixed') c.formR = Math.max(0, c.work - emp.sched_min);
    } else if (emp.work_type === 'fixed') {
      c.r = Math.max(0, c.work - emp.sched_min);
      c.formR = c.r;
    } else if (emp.work_type === 'disc' || emp.work_type === 'manager') {
      if (t === 'work') { c.r = Math.max(0, emp.deemed_min - 480); c.real = Math.max(0, c.work - 480); }
      else { c.r = c.work; c.real = c.work; }
    }
    c.note = buildNote(c, lv);
    return c;
  }

  function buildNote(c, lv) {
    var parts = [];
    if (c.deviation === 'non_work' && c.deviationNote) parts.push(c.deviationNote);
    if (c.extraBreak && c.extraBreakNote) parts.push(c.extraBreakNote);
    if (c.staggered) parts.push('時差出勤');
    if (c.makeup) parts.push('中抜け分 終業後勤務' + hm(c.makeup));
    if (c.work > 0 && c.type === 'company') parts.push('休日出勤');
    if (c.work > 0 && c.type === 'legal') parts.push('法定休日出勤');
    if (lv && !(c.work > 0)) parts.push(lv.name.replace('（全日）', ''));
    return parts.join('／');
  }

  /* ---------- 期間の計算（週40時間超を含む） ---------- */
  function calcRange(emp, from, to, inputs, rules, holidays, today) {
    var out = [], acc = 0, s = from;
    while (s <= to) {
      var c = calcDay(emp, s, inputs[s], rules, holidays, today);
      if (c.dow === rules.week_start_dow) acc = 0;
      if (emp.work_type === 'fixed' && c.type !== 'legal') {
        var x = c.work - c.r, before = acc;
        acc += x;
        c.w40 = Math.max(0, acc - Math.max(before, 2400));
      }
      out.push(c);
      s = addDays(s, 1);
    }
    return out;
  }

  /* ---------- 不足の充当（固定時間制・同じ月の中で日・週をまたいで充当） ---------- */
  // その日に働くべき時間（半休は残り半日の所定時間帯）
  function expectedMin(emp, c, rules) {
    if (!c.leaveType) return emp.sched_min;
    var lv = LEAVE[c.leaveType];
    if (lv.days >= 1) return 0;
    var am = /_am$/.test(c.leaveType);   // 午前休 → 午後が勤務、午後休 → 午前が勤務
    var part = am ? overlap(emp.sched_start, emp.sched_end, rules.lunch_end, 4320) : overlap(emp.sched_start, emp.sched_end, 0, rules.lunch_start);
    return Math.min(emp.sched_min, part);
  }
  function md(s) { return (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)); }
  /**
   * 平日の不足（遅刻・早退・中抜けで所定に届かない時間）を、同じ月の休日出勤・平日残業で埋める。
   * 法定の割増（週40h超・深夜・休日35%）や36協定の時間数は変えない。基本給部分の相殺だけを記録する。
   */
  function allocateOffsets(emp, rows, rules, t) {
    t.lack = 0; t.lackHol = 0; t.lackOt = 0; t.lackLeft = 0; t.holWork = 0; t.otWork = 0;
    if (emp.work_type !== 'fixed') return;
    rows.forEach(function (c) {
      if (c.type === 'work') t.otWork += c.r; else t.holWork += c.work;
      if (!c.judged || c.type !== 'work' || c.punchIn == null || c.punchOut == null) return;
      c.lack = Math.max(0, expectedMin(emp, c, rules) - c.work);
      t.lack += c.lack;
    });
    if (rules.offset_enabled && !emp.exempt) {
      var hol = rows.filter(function (c) { return c.judged && c.type !== 'work' && c.work > 0; }).map(function (c) { return { c: c, left: c.work, kind: 'hol' }; });
      var ot = rows.filter(function (c) { return c.judged && c.type === 'work' && c.r > 0; }).map(function (c) { return { c: c, left: c.r, kind: 'ot' }; });
      var src = rules.offset_order === 'overtime_first' ? ot.concat(hol) : hol.concat(ot);
      rows.forEach(function (c) {
        var need = c.lack;
        for (var i = 0; i < src.length && need > 0; i++) {
          var x = src[i];
          if (!x.left) continue;
          var use = Math.min(need, x.left);
          x.left -= use; need -= use;
          c.offsetFrom.push({ date: x.c.date, min: use, kind: x.kind });
          x.c.offsetTo.push({ date: c.date, min: use, kind: x.kind });
          if (x.kind === 'hol') t.lackHol += use; else t.lackOt += use;
        }
        c.filled = c.lack - need;
      });
    }
    t.lackLeft = t.lack - t.lackHol - t.lackOt;
    t.holPay = t.holWork - t.lackHol;     // 休日出勤のうち充当に使わなかった時間
    t.otPay = t.otWork - t.lackOt;        // 平日残業のうち充当に使わなかった時間（充当分も割増25%は対象）
    rows.forEach(function (c) {
      var p = [];
      if (c.lack) p.push('不足' + hm(c.lack) + (c.offsetFrom.length ? '→' + c.offsetFrom.map(function (o) { return md(o.date) + (o.kind === 'hol' ? '出勤' : '残業') + hm(o.min); }).join('・') + 'で充当' : ''));
      if (c.offsetTo.length) p.push(c.offsetTo.map(function (o) { return md(o.date) + '不足へ' + hm(o.min); }).join('・') + '充当');
      if (p.length) c.note = (c.note ? c.note + '／' : '') + p.join('／');
    });
  }

  function limitFor(emp, ag) {
    return emp.limit_class === 'restricted' ? ag.limit_restricted_min : ag.limit_general_min;
  }

  /* ---------- 1ヶ月の計算 ---------- */
  function calcMonth(emp, ym, inputs, rules, holidays, today, ag) {
    ag = ag || DEFAULT_AGREEMENT;
    var days = monthDays(ym);
    var from = weekStart(days[0], rules.week_start_dow);
    var rows = calcRange(emp, from, days[days.length - 1], inputs, rules, holidays, today)
      .filter(function (c) { return ymOf(c.date) === ym; });
    var t = {
      ym: ym, workType: emp.work_type, limit: limitFor(emp, ag),
      workDays: 0, scheduledDays: 0, work: 0, r: 0, w40: 0, night: 0, hol: 0, real: 0,
      paid: 0, paidHalf: 0, other: 0, otherHalf: 0, issues: 0
    };
    allocateOffsets(emp, rows, rules, t);
    rows.forEach(function (c) {
      if (c.type === 'work') t.scheduledDays++;
      if (c.work > 0) t.workDays++;
      t.work += c.work; t.r += c.r; t.w40 += c.w40; t.night += c.night; t.hol += c.hol; t.real += c.real;
      if (c.leaveType) {
        if (c.leavePaid) { t.paid += c.leaveDays; if (c.leaveDays === 0.5) t.paidHalf += 0.5; }
        else { t.other += c.leaveDays; if (c.leaveDays === 0.5) t.otherHalf += 0.5; }
      }
      if (c.flags.some(function (f) { return ISSUE_FLAGS.indexOf(f) >= 0; })) t.issues++;
    });
    if (emp.work_type === 'flex') {
      var frame = rules.flex_frame_mode === 'workdays' ? t.scheduledDays * 480 : Math.floor(2400 * days.length / 7);
      var done = rows.reduce(function (s, c) { return s + (c.type === 'legal' ? 0 : c.work); }, 0);
      var remain = rows.filter(function (c) {
        return c.type === 'work' && c.date >= today && c.punchOut == null && !(c.leaveType && c.leaveDays === 1);
      }).length;
      var closed = ym < ymOf(today);
      t.frame = frame; t.sched = t.scheduledDays * 480; t.done = done;
      t.projected = done + remain * 480; t.projection = !closed;
      t.legalOt = Math.max(0, (closed ? done : t.projected) - frame);
      t.ot36 = t.legalOt;
      t.formOt = t.legalOt;
      t.shortage = Math.max(0, t.sched - done);
    } else if (emp.work_type === 'fixed') {
      t.legalOt = t.r + t.w40;
      t.ot36 = t.r + (rules.w40_counts_in_limit ? t.w40 : 0);
      t.formOt = rows.reduce(function (s, c) { return s + (c.formR || 0); }, 0);
    } else {
      t.legalOt = t.r;
      t.ot36 = t.r;
      t.formOt = t.r;
    }
    t.over60 = Math.max(0, t.legalOt - 3600);
    t.premium = t.night + t.w40;
    t.health = (emp.work_type === 'disc' || emp.work_type === 'manager') ? t.real : t.legalOt + t.hol;
    t.stage = stageOf(t.ot36, t.limit, ag);
    return { rows: rows, totals: t };
  }

  /* ---------- 36協定 ---------- */
  function stageOf(ot, limit, ag) {
    if (ot >= limit) return 'over';
    if (ot >= limit * ag.warn_ratio) return 'warn';
    if (ot >= limit * ag.caution_ratio) return 'caution';
    return 'normal';
  }
  var STAGE_LABEL = {
    normal: '通常', caution: '注意', warn: '警告', over: '上限到達',
    annual_warn: '年間警告', annual_over: '年間上限', over_count: '上限超の月数', health: '健康',
    single: '単月100時間', avg: '複数月平均80時間'
  };
  function fiscalMonths(ym, startMonth) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var sy = m >= startMonth ? y : y - 1;
    var cur = sy + '-' + pad2(startMonth), out = [];
    while (cur <= ym) { out.push(cur); cur = addMonths(cur, 1); }
    return out;
  }
  /**
   * history: 年度内の月の配列 [{ ym, ot36, legalOt, hol }]（当月を含む、昇順）
   * 直近6ヶ月の平均判定には年度をまたぐ月も含めてよい（recent に渡す）
   */
  function annualJudge(history, recent, limit, ag) {
    var total = 0, overCount = 0;
    history.forEach(function (h) { total += h.ot36; if (h.ot36 > limit) overCount++; });
    var res = { total: total, overCount: overCount, stages: [] };
    if (total >= ag.annual_limit_min) res.stages.push('annual_over');
    else if (total >= ag.annual_warn_min) res.stages.push('annual_warn');
    if (overCount >= ag.over_limit_max_count) res.stages.push('over_count');
    var r = (recent || history).slice(-6);
    if (r.length) {
      var last = r[r.length - 1];
      if (last.legalOt + last.hol >= ag.single_month_cap_min) res.stages.push('single');
      for (var k = 2; k <= r.length; k++) {
        var seg = r.slice(-k), sum = 0;
        seg.forEach(function (h) { sum += h.legalOt + h.hol; });
        if (sum / k > ag.avg_cap_min) { res.stages.push('avg'); res.avgMonths = k; break; }
      }
    }
    return res;
  }
  // 通知対象として到達した段階の一覧
  function reachedStages(monthTotals, annual, ag) {
    var s = [];
    var st = monthTotals.stage;
    if (st === 'caution' || st === 'warn' || st === 'over') s.push('caution');
    if (st === 'warn' || st === 'over') s.push('warn');
    if (st === 'over') s.push('over');
    if (monthTotals.health > ag.health_min) s.push('health');
    (annual ? annual.stages : []).forEach(function (x) { s.push(x); });
    return s;
  }
  var STAGE_RECIPIENTS = {
    caution: ['self'], warn: ['self', 'approver'], over: ['self', 'approver', 'admin'],
    annual_warn: ['self', 'approver', 'admin'], annual_over: ['self', 'approver', 'admin'],
    over_count: ['self', 'approver', 'admin'], health: ['self', 'admin'],
    single: ['self', 'approver', 'admin'], avg: ['self', 'approver', 'admin']
  };

  /* ---------- 営業日 ---------- */
  function nthBusinessDay(ym, n, rules, holidays) {
    var days = monthDays(ym), cnt = 0;
    for (var i = 0; i < days.length; i++) {
      if (dayType(days[i], rules, holidays) === 'work') { cnt++; if (cnt === n) return days[i]; }
    }
    return days[days.length - 1];
  }
  function prevBusinessDay(s, rules, holidays) {
    var d = addDays(s, -1);
    for (var i = 0; i < 14; i++) { if (dayType(d, rules, holidays) === 'work') return d; d = addDays(d, -1); }
    return addDays(s, -1);
  }

  /* ---------- 帳票（勤務表兼残業表）に載せる値 ---------- */
  function formMode(emp) {
    if (emp.work_type === 'flex') return 'flex';
    if (emp.work_type === 'disc' || emp.work_type === 'manager') return 'deemed';
    return 'formula';
  }
  function formModel(emp, month, opts) {
    opts = opts || {};
    var t = month.totals, mode = formMode(emp);
    var cumR = 0, cumT = 0;
    var days = month.rows.map(function (c) {
      var worked = c.a != null && c.b != null && c.work > 0;
      var lv = c.leaveType ? LEAVE[c.leaveType] : null;
      var tv = c.night + c.w40;
      if (worked) cumR += c.r;
      if (tv) cumT += tv;
      var pre = (c.preStart != null || c.preEnd != null);
      return {
        date: c.date,
        mark: c.type !== 'work' ? '○' : '',
        preStart: pre ? c.preStart : null,
        preEnd: pre ? c.preEnd : null,
        preReason: pre ? c.preReason : '',
        preStamp: pre && opts.printApprover ? (c.preApprover || '承認済') : (pre ? '承認済' : ''),
        attendance: lv ? lv.label : '',
        paidDays: lv && lv.paid ? lv.days : null,
        otherDays: lv && !lv.paid ? lv.days : null,
        a: worked ? c.a : null,
        b: worked ? c.b : null,
        c: c.extraBreak || null,
        r: mode === 'deemed' && worked ? c.r : null,       // 見做しの場合のみ値で書く（固定は書式の数式に任せる）
        rCum: mode === 'deemed' && worked ? cumR : null,
        t: tv || null,
        note: c.note
      };
    });
    return {
      mode: mode,
      header: { month: month.totals.ym + '-01', division: emp.division, section: emp.section, empNo: emp.emp_no, name: emp.name, schedMin: emp.sched_min },
      days: days,
      totals: {
        formOt: t.formOt, premium: t.premium, paid: t.paid, paidHalf: t.paidHalf, other: t.other, otherHalf: t.otherHalf
      }
    };
  }
  // 帳票の数式（R＝IF(AE>B9,AE−B9,0)、AE＝P−O−(Q＋B10)、S＝累計）を再現する。照合とテスト用
  function emulateFormR(model, lunchMin) {
    var cum = 0;
    return model.days.map(function (d) {
      if (d.a == null) return { r: null, s: null };
      var ae = d.b - d.a - ((d.c || 0) + lunchMin);
      var r = ae > model.header.schedMin ? ae - model.header.schedMin : 0;
      cum += r;
      return { r: r, s: cum };
    });
  }

  var api = {
    DEFAULT_RULES: DEFAULT_RULES, DEFAULT_AGREEMENT: DEFAULT_AGREEMENT, LEAVE: LEAVE,
    FLAG_LABEL: FLAG_LABEL, ISSUE_FLAGS: ISSUE_FLAGS, TYPE_LABEL: TYPE_LABEL, STAGE_LABEL: STAGE_LABEL,
    STAGE_RECIPIENTS: STAGE_RECIPIENTS, DOW: DOW,
    pad2: pad2, floorUnit: floorUnit, addDays: addDays, dow: dow, ymOf: ymOf, addMonths: addMonths, daysInMonth: daysInMonth,
    monthDays: monthDays, weekStart: weekStart, hm: hm, hhmm: hhmm, parseHm: parseHm, overlap: overlap, toBool: toBool,
    normalizeRules: normalizeRules, normalizeAgreement: normalizeAgreement, normalizeEmployee: normalizeEmployee,
    dayType: dayType, calcDay: calcDay, calcRange: calcRange, calcMonth: calcMonth, limitFor: limitFor,
    stageOf: stageOf, fiscalMonths: fiscalMonths, annualJudge: annualJudge, reachedStages: reachedStages,
    expectedMin: expectedMin, allocateOffsets: allocateOffsets,
    nthBusinessDay: nthBusinessDay, prevBusinessDay: prevBusinessDay,
    formMode: formMode, formModel: formModel, emulateFormR: emulateFormR
  };
  return api;
})();

if (typeof module !== 'undefined') module.exports = Calc;
