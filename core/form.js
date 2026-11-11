/**
 * 帳票『勤務表兼残業表』の転記データを作る（Excel への書き込みとPDF化は server/forms.js）
 * - 転記位置は form_map テーブル（コードに番地を書かない）
 * - 固定時間制の④（R・S列）と45・49行は書式の数式に計算させ、PDF化の前に読み戻して照合する
 */
var Form = (function () {

  function a1(cell) {
    var m = String(cell).trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!m) throw UserError('form_map のセル番地「' + cell + '」が正しくありません');
    var col = 0;
    for (var i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
    return { row: Number(m[2]), col: col, a1: m[1] + m[2] };
  }
  function mapOf() {
    var map = {};
    Repo.all('form_map').forEach(function (r) { if (r.item && r.cell) map[r.item] = a1(r.cell); });
    ['month', 'name', 'work_start', 'work_end', 'total_ot', 'total_premium'].forEach(function (k) {
      if (!map[k]) throw UserError('form_map に「' + k + '」の番地がありません');
    });
    return map;
  }

  /** 社員ごとの転記データ。サーバーはこれを Excel に書き、PDF にする */
  function prepare(c, ym, emps) {
    var map = mapOf(), r = c.rules;
    var jobs = emps.map(function (emp) {
      var model = Calc.formModel(emp, Domain.month(c, emp, ym), { printApprover: r.print_approver_name });
      return { emp_id: emp.emp_id, name: emp.name, label: (emp.emp_no ? emp.emp_no + '_' : '') + emp.name, model: model };
    });
    return {
      ym: ym,
      name: '勤務表兼残業表_' + ym + (emps.length === 1 ? '_' + (emps[0].emp_no ? emps[0].emp_no + '_' : '') + emps[0].name : ''),
      map: map,
      layout: {
        sheet: r.form_sheet_name || '入力用', firstDayRow: r.form_first_day_row, page1LastRow: r.form_page1_last_row,
        lastRow: r.form_last_row, firstCol: r.form_first_col, lastCol: r.form_last_col
      },
      jobs: jobs
    };
  }

  /** 照合（帳票の数式が計算した当月残業時間・当月割増と、システムの値を比べる） */
  function verify(model, r49, t49) {
    var problems = [];
    var expOt = model.totals.formOt / 60, expPr = model.totals.premium / 60;
    r49 = Number(r49) || 0; t49 = Number(t49) || 0;
    if (model.mode !== 'flex' && Math.abs(r49 - expOt) > 0.01) problems.push('当月残業時間：帳票 ' + r49.toFixed(2) + 'h／システム ' + expOt.toFixed(2) + 'h');
    if (Math.abs(t49 - expPr) > 0.01) problems.push('当月割増：帳票 ' + t49.toFixed(2) + 'h／システム ' + expPr.toFixed(2) + 'h');
    return problems;
  }

  return { prepare: prepare, verify: verify, a1: a1, mapOf: mapOf };
})();
