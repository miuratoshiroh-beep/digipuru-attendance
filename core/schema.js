/**
 * テーブル定義（PostgreSQL のテーブルと列はここから自動で作る。列の追加も起動時に反映）
 * 列の型：s=文字列（text）、n=数値（double precision）、b=真偽値（boolean）
 * 列は末尾にのみ追加すること（CSV・Excel 出力の列順を変えない）
 */
var SCHEMA = {
  employees: [
    ['emp_id', 's'], ['emp_no', 's'], ['name', 's'], ['email', 's'], ['division', 's'], ['section', 's'], ['job', 's'],
    ['role', 's'], ['approver_email', 's'], ['work_type', 's'], ['limit_class', 's'], ['work_type_next', 's'],
    ['work_type_next_from', 's'], ['deemed_min', 'n'], ['sched_start', 's'], ['sched_end', 's'], ['sched_min', 'n'],
    ['active', 'b'], ['joined_on', 's'], ['left_on', 's'], ['seconded', 'b'],
    ['exempt', 'b'], ['memo', 's']
  ],
  rules: [['key', 's'], ['value', 's'], ['note', 's']],
  agreement36: [['key', 's'], ['value', 's'], ['note', 's']],
  holidays: [['date', 's'], ['kind', 's'], ['name', 's']],
  punch_log: [
    ['log_id', 's'], ['emp_id', 's'], ['kind', 's'], ['minute', 'n'], ['work_date', 's'], ['punched_at', 's'],
    ['source', 's'], ['req_id', 's'], ['user_agent', 's'], ['created_at', 's']
  ],
  requests: [
    ['req_id', 's'], ['emp_id', 's'], ['kind', 's'], ['work_date', 's'], ['pre_start', 's'], ['pre_end', 's'],
    ['is_post', 'b'], ['in_time', 's'], ['out_time', 's'], ['leave_type', 's'], ['reason', 's'], ['status', 's'],
    ['approver_email', 's'], ['approver_name', 's'], ['decided_at', 's'], ['comment', 's'], ['created_at', 's']
  ],
  day_inputs: [
    ['emp_id', 's'], ['work_date', 's'], ['extra_break_min', 'n'], ['extra_break_note', 's'], ['deviation', 's'],
    ['deviation_note', 's'], ['updated_at', 's']
  ],
  month_status: [['emp_id', 's'], ['ym', 's'], ['confirmed_at', 's'], ['approved_at', 's'], ['approved_by', 's']],
  month_close: [['ym', 's'], ['closed_at', 's'], ['closed_by', 's'], ['csv_daily_url', 's'], ['csv_monthly_url', 's']],
  daily: [
    ['emp_id', 's'], ['work_date', 's'], ['day_type', 's'], ['punch_in', 's'], ['punch_out', 's'], ['pre_start', 's'],
    ['pre_end', 's'], ['pre_reason', 's'], ['pre_approver', 's'], ['leave_type', 's'], ['leave_days', 'n'],
    ['work_start', 's'], ['work_end', 's'], ['lunch_min', 'n'], ['extra_break_min', 'n'], ['work_min', 'n'],
    ['ot_daily_min', 'n'], ['w40_min', 'n'], ['night_min', 'n'], ['holiday_min', 'n'], ['real_over_min', 'n'],
    ['staggered', 'b'], ['flags', 's'], ['note', 's'], ['calc_at', 's'],
    ['makeup_min', 'n'], ['lack_min', 'n'], ['filled_min', 'n'], ['offset_to_min', 'n']
  ],
  monthly: [
    ['emp_id', 's'], ['ym', 's'], ['work_type', 's'], ['limit_min', 'n'], ['work_days', 'n'], ['paid_days', 'n'],
    ['paid_half_days', 'n'], ['other_days', 'n'], ['other_half_days', 'n'], ['work_min', 'n'], ['ot_daily_min', 'n'],
    ['w40_min', 'n'], ['ot36_min', 'n'], ['legal_ot_min', 'n'], ['over60_min', 'n'], ['night_min', 'n'],
    ['premium_min', 'n'], ['holiday_min', 'n'], ['health_min', 'n'], ['flex_frame_min', 'n'], ['form_ot_min', 'n'],
    ['stage', 's'], ['closed', 'b'], ['calc_at', 's'],
    ['lack_min', 'n'], ['offset_hol_min', 'n'], ['offset_ot_min', 'n'], ['lack_left_min', 'n'],
    ['hol_work_min', 'n'], ['hol_pay_min', 'n'], ['ot_work_min', 'n'], ['ot_pay_min', 'n']
  ],
  notices: [['notice_id', 's'], ['emp_id', 's'], ['ym', 's'], ['stage', 's'], ['sent_to', 's'], ['sent_at', 's']],
  form_map: [['item', 's'], ['cell', 's'], ['note', 's']],
  audit_log: [['at', 's'], ['actor_email', 's'], ['action', 's'], ['target', 's'], ['detail', 's']]
};

// 管理者が画面（管理 › マスタ）で編集するテーブル（それ以外はシステムだけが書き込む）
var EDITABLE_SHEETS = ['employees', 'rules', 'agreement36', 'holidays', 'form_map'];

var DEFAULT_RULE_ROWS = [
  ['lunch_start', '12:00', '昼休の開始'],
  ['lunch_end', '13:00', '昼休の終了'],
  ['lunch_min', '60', '昼休の控除（分）。帳票のB10'],
  ['lunch_apply_min', '360', '就業時間帯がこの分を超える日は昼休を一律控除（帳票の計算式と一致させる）'],
  ['legal_holiday_dow', '0', '法定休日の曜日（0=日〜6=土）'],
  ['week_start_dow', '0', '週の起算日（0=日〜6=土）'],
  ['deviation_grace_min', '29', '終業予定から何分を超えて退勤したら乖離とするか（30分単位の申請に合わせて29）'],
  ['ot_unit_min', '30', '残業・早出の申請単位（分）。終業側は切り捨て、早出側は切り上げ'],
  ['stagger_grace_min', '15', '始業から何分を超えて出勤したら時差出勤とするか'],
  ['makeup_enabled', 'TRUE', '中抜け（③休憩等）の分だけ、残業申請なしで終業後に勤務できる（その分は残業にしない）'],
  ['offset_enabled', 'TRUE', '平日の不足（遅刻・早退・中抜け）を、同じ月の休日出勤・平日残業で充当する（割増・36協定の時間数は変えない）'],
  ['offset_order', 'holiday_first', '充当の順：holiday_first＝休日出勤→残業、overtime_first＝残業→休日出勤'],
  ['flex_frame_mode', 'calendar', 'フレックスの法定総枠：calendar=40h×暦日÷7、workdays=所定労働日数×8h'],
  ['w40_counts_in_limit', 'TRUE', '36協定の月上限に週40時間超を含める'],
  ['fiscal_start_month', '4', '年度の起算月'],
  ['close_deadline_bizday', '3', '前月分の確定期限（第何営業日）'],
  ['operation_start', '', '運用開始日（yyyy-MM-dd）。これより前の日は記録なし・打刻漏れを判定せず、前月の確定依頼も出さない'],
  ['notify_hour', '7', '打刻漏れ・乖離・確定依頼のメールを送る時刻（時）'],
  ['mail_enabled', 'TRUE', 'メール通知を送る'],
  ['print_approver_name', 'TRUE', '帳票の承認印欄に承認者名と承認日を印字する'],
  ['form_sheet_name', '入力用', '帳票テンプレート（template/form_template.xlsx）の転記先シート名'],
  ['form_first_day_row', '14', '1日の行'],
  ['form_page1_last_row', '28', '1ページ目の最終行（15日）'],
  ['form_last_row', '50', '印刷範囲の最終行'],
  ['form_first_col', '5', '印刷範囲の最初の列（E=5）'],
  ['form_last_col', '24', '印刷範囲の最後の列（X=24）'],
];

var DEFAULT_AGREEMENT_ROWS = [
  ['limit_general_min', '2520', '月の上限（一般）42時間'],
  ['limit_restricted_min', '2400', '月の上限（管理職・営業・裁量労働）40時間'],
  ['over_limit_max_count', '6', '上限を超えてよい月数（年）'],
  ['annual_limit_min', '43200', '年間累計の上限 720時間'],
  ['annual_warn_min', '36000', '年間警告 600時間'],
  ['caution_ratio', '0.75', '注意（本人）'],
  ['warn_ratio', '0.9', '警告（本人・承認者）'],
  ['single_month_cap_min', '6000', '単月100時間（時間外＋休日労働）'],
  ['avg_cap_min', '4800', '2〜6ヶ月平均80時間（時間外＋休日労働）'],
  ['health_min', '4800', '健康：時間外＋休日労働 月80時間超で医師面接の案内']
];

// 帳票（勤務表兼残業表「入力用」シート）の番地。日別の項目は1日の行のセルを書き、31日分を下へ
var DEFAULT_FORM_MAP_ROWS = [
  ['month', 'B6', '記録月（日付）'],
  ['division', 'S6', '事業本部'],
  ['section', 'U6', '部門名'],
  ['emp_no', 'S7', '社員番号'],
  ['name', 'V7', '氏名'],
  ['sched', 'B9', '所定労働時間（時短者）'],
  ['day_mark', 'D14', '休日マーク ○'],
  ['pre_start', 'G14', '①開始（早出）'],
  ['pre_end', 'H14', '①終了（終業予定）'],
  ['pre_reason', 'I14', '①理由'],
  ['pre_stamp', 'K14', '①承認印'],
  ['attendance', 'L14', '②出勤状況'],
  ['paid_days', 'M14', '②有休日数'],
  ['other_days', 'N14', '②他の休'],
  ['work_start', 'O14', '②開始 a'],
  ['work_end', 'P14', '②終了 b'],
  ['extra_break', 'Q14', '③休憩等 c'],
  ['ot_day', 'R14', '④当日（見做し・フレックスのみ値を書く）'],
  ['ot_cum', 'S14', '④累計（見做し・フレックスのみ値を書く）'],
  ['night_w40', 'T14', '深夜・週40時間超 当日'],
  ['note', 'V14', '⑥備考'],
  ['total_ot', 'R49', '当月残業時間（照合に使用）'],
  ['total_premium', 'T49', '当月割増（照合に使用）']
];
