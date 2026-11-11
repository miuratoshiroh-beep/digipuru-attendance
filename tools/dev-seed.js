// ローカル確認用の架空データ（DEV_SEED=tools/dev-seed.js で起動時に入れる）
const { EMPLOYEES, HOLIDAYS } = require('../test/seed');
module.exports = async function (engine) {
  await engine.internal('system', c => {
    if (c.Repo.all('employees').length) return;
    c.Repo.append('employees', EMPLOYEES);
    c.Repo.append('holidays', HOLIDAYS);
  });
};
