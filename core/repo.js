/**
 * データの読み書き（PostgreSQL の写しをメモリに持ち、変更は Host.ops に積んでコミット時にDBへ書く）
 * 呼び出し側の互換のため、行の識別子は _row（＝DBの id）
 * 1回の処理内では読み込み結果をキャッシュし、書き込むとそのテーブルのキャッシュを捨てる
 */
var Repo = (function () {
  var cache = {};

  function table(name) {
    if (!SCHEMA[name]) throw new Error('テーブル ' + name + ' がありません');
    var t = Host.db.tables[name];
    if (!t) throw new Error('テーブル ' + name + ' が読み込まれていません');
    return t;
  }
  function clone(r) { var o = {}; for (var k in r) o[k] = r[k]; return o; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function conv(v, type) {
    if (v === '' || v == null) return type === 'n' ? null : (type === 'b' ? false : '');
    if (type === 'n') { var n = Number(v); return isNaN(n) ? null : n; }
    if (type === 'b') return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
    return String(v);
  }
  // 保存する形（SCHEMA の列だけ、型をそろえる）
  function norm(name, o) {
    var r = {};
    SCHEMA[name].forEach(function (c) { r[c[0]] = conv(o[c[0]], c[1]); });
    return r;
  }
  function all(name) {
    if (cache[name]) return cache[name];
    var rows = table(name).rows.map(function (r) { var o = clone(r); o._row = r._id; delete o._id; return o; });
    cache[name] = rows;
    return rows;
  }
  function append(name, objs) {
    if (!objs || !objs.length) return;
    var t = table(name);
    objs.forEach(function (o) {
      var r = norm(name, o);
      r._id = ++t.seq;
      t.rows.push(r);
      Host.ops.push({ op: 'insert', table: name, row: r });
    });
    delete cache[name];
  }
  function update(name, obj) {
    if (!obj._row) throw new Error('update: _row がありません');
    var t = table(name), i = indexOf(t, obj._row);
    if (i < 0) throw new Error('update: ' + name + ' の行 ' + obj._row + ' がありません');
    var r = norm(name, obj); r._id = obj._row;
    t.rows[i] = r;
    Host.ops.push({ op: 'update', table: name, row: r });
    delete cache[name];
  }
  function indexOf(t, id) {
    for (var i = 0; i < t.rows.length; i++) if (t.rows[i]._id === id) return i;
    return -1;
  }
  function find(name, keys) {
    return all(name).filter(function (r) {
      for (var k in keys) if (String(r[k]) !== String(keys[k])) return false;
      return true;
    })[0] || null;
  }
  function upsert(name, keys, obj) {
    var found = find(name, keys);
    if (found) {
      for (var k in obj) found[k] = obj[k];
      update(name, found);
      return found;
    }
    var o = {}; for (k in keys) o[k] = keys[k]; for (k in obj) o[k] = obj[k];
    append(name, [o]);
    return o;
  }
  // 条件に合う行を消して、新しい行を足す（daily・monthly の再計算、マスタの保存）
  function replaceWhere(name, removeFn, newRows) {
    var t = table(name), keep = [], removed = [];
    t.rows.forEach(function (r) {
      var o = clone(r); o._row = r._id; delete o._id;
      if (removeFn(o)) removed.push(r._id); else keep.push(r);
    });
    t.rows = keep;
    if (removed.length) Host.ops.push({ op: 'delete', table: name, ids: removed });
    delete cache[name];
    append(name, newRows || []);
  }
  function kv(name) {
    var o = {};
    all(name).forEach(function (r) { if (r.key) o[r.key] = r.value; });
    return o;
  }
  function clearCache() { cache = {}; }
  function url() { return '/export/data.xlsx'; }

  return {
    all: all, append: append, update: update, find: find, upsert: upsert,
    replaceWhere: replaceWhere, kv: kv, clearCache: clearCache, url: url, pad: pad, norm: norm
  };
})();
