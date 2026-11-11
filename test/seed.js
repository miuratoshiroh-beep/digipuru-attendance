// テスト・デモ用の初期データ（架空の社員）
const EMPLOYEES = [
  { emp_id: 'E001', emp_no: '700', name: '大川 浩', email: 'admin@g.takayoshi.co.jp', division: 'デジプル', section: '経営', role: 'admin', work_type: 'manager', limit_class: 'restricted', sched_start: '8:30', sched_end: '17:30', sched_min: 480, deemed_min: 480, active: true },
  { emp_id: 'E002', emp_no: '701', name: '佐々木 遼', email: 'sasaki.ryo@g.takayoshi.co.jp', division: 'デジプル', section: 'Vibeコーディング・財務課', role: 'staff', approver_email: 'kacho@g.takayoshi.co.jp', work_type: 'fixed', limit_class: 'general', sched_start: '8:30', sched_end: '17:30', sched_min: 480, deemed_min: 480, active: true },
  { emp_id: 'E003', emp_no: '702', name: '小林 美咲', email: 'kobayashi.misaki@g.takayoshi.co.jp', division: 'デジプル', section: 'Vibeコーディング・財務課', role: 'staff', approver_email: 'kacho@g.takayoshi.co.jp', work_type: 'flex', limit_class: 'general', sched_start: '8:30', sched_end: '17:30', sched_min: 480, deemed_min: 480, active: true },
  { emp_id: 'E004', emp_no: '703', name: '長谷川 拓海', email: 'hasegawa.takumi@g.takayoshi.co.jp', division: 'デジプル', section: 'Vibeコーディング・財務課', role: 'staff', approver_email: 'kacho@g.takayoshi.co.jp', work_type: 'disc', limit_class: 'restricted', sched_start: '8:30', sched_end: '17:30', sched_min: 480, deemed_min: 480, active: true },
  { emp_id: 'E005', emp_no: '710', name: '課長 一郎', email: 'kacho@g.takayoshi.co.jp', division: 'デジプル', section: 'Vibeコーディング・財務課', role: 'approver', approver_email: 'admin@g.takayoshi.co.jp', work_type: 'manager', limit_class: 'restricted', sched_start: '8:30', sched_end: '17:30', sched_min: 480, deemed_min: 480, active: true }
];
const HOLIDAYS = [
  { date: '2026-10-12', kind: 'company', name: 'スポーツの日' },
  { date: '2026-11-03', kind: 'company', name: '文化の日' },
  { date: '2026-11-23', kind: 'company', name: '勤労感謝の日' }
];
function seed(gas) {
  gas.direct(c => {
    c.Repo.append('employees', EMPLOYEES);
    c.Repo.append('holidays', HOLIDAYS);
  });
}
module.exports = { seed, EMPLOYEES, HOLIDAYS };
