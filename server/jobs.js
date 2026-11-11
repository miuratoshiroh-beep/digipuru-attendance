/**
 * 定時処理（日本時間）
 *  - 夜間処理：毎日 2:10
 *  - 朝の通知：毎時3分に確認し、設定 notify_hour の時台なら実行
 * 同じ日の同じ処理は job_runs で1回に限る（再起動・デプロイ時の二重送信を防ぐ）
 */
const cron = require('node-cron');
const { formatDate } = require('./engine');

function startJobs({ engine, store, log, now }) {
  const clock = now || (() => new Date());
  const today = () => formatDate(clock(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const hour = () => Number(formatDate(clock(), 'Asia/Tokyo', 'H'));

  async function runOnce(job, fnName) {
    const key = today();
    if (!(await store.claimJob(job, key))) return null;
    try {
      const res = await engine.internal('system', c => c[fnName]());
      await store.finishJob(job, key, JSON.stringify(res));
      log('info', job + ' done', JSON.stringify(res));
      return res;
    } catch (e) {
      await store.finishJob(job, key, 'ERROR ' + e.message);
      log('error', job + ' failed', e);
      return null;
    }
  }
  async function nightly() { return runOnce('nightly', 'nightlyJob'); }
  async function morningIfDue() {
    const h = await engine.internal('system', c => c.notifyHour());
    if (hour() !== Number(h)) return null;
    return runOnce('morning', 'morningJob');
  }

  const tasks = [
    cron.schedule('10 2 * * *', () => { nightly(); }, { timezone: 'Asia/Tokyo' }),
    cron.schedule('3 * * * *', () => { morningIfDue(); }, { timezone: 'Asia/Tokyo' })
  ];
  // 起動が夜間処理の時刻より後で、今日まだ動いていなければ追いかけて実行する
  if (hour() >= 3) setTimeout(() => { nightly(); }, 15000);
  return { nightly, morningIfDue, stop: () => tasks.forEach(t => t.stop()) };
}

module.exports = { startJobs };
