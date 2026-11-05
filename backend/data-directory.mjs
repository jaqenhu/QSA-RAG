import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const receiptName = '.qsa-data-migration.json';
const quote = name => `"${name.replaceAll('"', '""')}"`;
const entries = path => existsSync(path) ? readdirSync(path) : [];
const identity = path => {
  let ancestor = resolve(path);
  const tail = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) { tail.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const value = join(realpathSync(ancestor), ...tail);
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const inside = (parent, child) => { const part = relative(parent, child); return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };

function receipt(path) {
  if (!existsSync(join(path, receiptName))) return null;
  try {
    const value = JSON.parse(readFileSync(join(path, receiptName), 'utf8'));
    if (value.version !== 1 || typeof value.source !== 'string' || typeof value.destination !== 'string') throw new Error();
    return value;
  } catch { throw new Error(`数据迁移记录损坏，请先检查备份：${path}`); }
}

function assertStopped(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_lease'").get()) return;
  for (const { pid } of db.prepare('SELECT pid FROM service_lease').all()) {
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('旧数据目录仍有 QSA 服务运行，请等待任务结束并关闭原服务后重试迁移。');
  }
}

function checkDatabase(db) {
  if (db.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok')) throw new Error('数据库完整性检查失败，迁移已停止，请从完整备份恢复。');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库存在外键异常，迁移已停止，请先检查原数据。');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) throw new Error('旧目录不是有效的 QSA 数据库，迁移已停止。');
}

// Include rowids: version/file ordering must survive relocation as well as values.
export function databaseFingerprint(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const hash = createHash('sha256').update(JSON.stringify(schema));
  const tables = {};
  for (const { name, sql } of schema.filter(row => row.type === 'table')) {
    const withRowid = !/\bWITHOUT\s+ROWID\b/i.test(sql || '');
    hash.update(JSON.stringify({ table: name, withRowid }));
    const statement = db.prepare(`SELECT ${withRowid ? 'rowid AS __qsa_rowid__,' : ''}* FROM ${quote(name)} ORDER BY ${withRowid ? 'rowid' : db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => quote(row.name)).join(',')}`);
    statement.setReadBigInts(true);
    let count = 0;
    for (const row of statement.iterate()) {
      hash.update(JSON.stringify(Object.values(row), (_, value) => typeof value === 'bigint' ? { integer: value.toString() } : ArrayBuffer.isView(value) ? { blob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex') } : value));
      hash.update('\n'); count++;
    }
    tables[name] = count;
    hash.update(JSON.stringify({ rows: count }));
  }
  for (const pragma of ['user_version', 'application_id']) hash.update(JSON.stringify(db.prepare(`PRAGMA ${pragma}`).get()));
  return { sha256: hash.digest('hex'), tables };
}

function copyTree(source, destination, top = true) {
  if (lstatSync(source).isSymbolicLink()) throw new Error(`数据目录含符号链接，需手动迁移：${source}`);
  mkdirSync(destination);
  for (const name of readdirSync(source)) {
    // SQLite recreates shared memory; the stable WAL is copied with the main DB.
    if (top && [receiptName, 'qsa.sqlite-shm', 'qsa.sqlite-journal'].includes(name)) continue;
    const from = join(source, name), to = join(destination, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`数据目录含符号链接，需手动迁移：${from}`);
    if (stat.isDirectory()) copyTree(from, to, false);
    else if (stat.isFile()) {
      copyFileSync(from, to);
      if (fileHash(from) !== fileHash(to)) throw new Error(`文件复制校验失败：${from}`);
    } else throw new Error(`数据目录包含无法自动复制的文件：${from}`);
  }
}

function fileHash(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
  const file = openSync(path, 'r');
  try {
    let bytes;
    while ((bytes = readSync(file, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(file); }
}

function writeReceipt(path, record) {
  const temporary = join(path, `.qsa-data-migration-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(record, null, 2), { flag: 'wx', flush: true });
  renameSync(temporary, join(path, receiptName));
}

export function defaultDataDirectory({ env = process.env, platform = process.platform, userHome = homedir() } = {}) {
  const base = platform === 'win32' ? env.LOCALAPPDATA || join(userHome, 'AppData', 'Local') : join(userHome, '.local', 'share');
  if (!isAbsolute(base)) throw new Error('本机应用数据路径必须是绝对路径，请检查 LOCALAPPDATA。');
  return join(base, 'QSA-RAG', 'data');
}

// Called before opening the application's store. Explicit paths never import data.
export function prepareDataDirectory({ dataDir, appRoot, env = process.env, platform = process.platform, userHome } = {}) {
  const configured = dataDir ?? env.QSA_DATA_DIR;
  if (configured) return { directory: resolve(configured), migrated: false, custom: true };
  const directory = resolve(defaultDataDirectory({ env, platform, userHome }));
  const source = join(resolve(appRoot), '.data');
  const sourceId = identity(source), destinationId = identity(directory);
  if (inside(sourceId, destinationId) || inside(destinationId, sourceId)) throw new Error('新旧数据目录不能相同或互相包含，请检查应用数据路径。');
  const previous = receipt(source);
  const existing = receipt(directory);
  if (previous && (previous.source !== sourceId || previous.destination !== destinationId)) throw new Error('旧数据已有其他迁移记录，请先核对正在使用的数据目录。');
  if (existing && existing.destination !== destinationId) throw new Error('数据目录的迁移记录与当前位置不一致，请检查备份和数据路径。');
  if (existing && !existsSync(join(directory, 'qsa.sqlite'))) throw new Error('迁移后的数据库缺失，请恢复完整备份；不会从旧目录重新导入。');
  const legacy = entries(source).filter(name => name !== receiptName);
  if (entries(directory).length) {
    if (!existsSync(join(directory, 'qsa.sqlite'))) throw new Error(`目标目录已有其他文件，未覆盖：${directory}`);
    if (legacy.length && existing?.source !== sourceId) throw new Error(`新旧目录都有数据，未自动合并或覆盖。请先确认使用哪一份：${source}；${directory}`);
    // Recover a crash after promotion but before recording the retained snapshot.
    if (legacy.length && existing?.source === sourceId && !previous) writeReceipt(source, existing);
    return { directory, migrated: false, custom: false };
  }
  if (previous) throw new Error(`迁移后的数据目录缺失或为空，请恢复完整备份：${directory}；不会重新导入旧快照。`);
  if (!legacy.length) return { directory, migrated: false, custom: false };
  if (!existsSync(join(source, 'qsa.sqlite'))) throw new Error(`旧数据目录没有 qsa.sqlite，未创建空库，请先核对：${source}`);

  // Preflight is read-only, so a running service is rejected without touching it.
  const probe = new DatabaseSync(join(source, 'qsa.sqlite'), { readOnly: true });
  try { assertStopped(probe); } finally { probe.close(); }
  const db = new DatabaseSync(join(source, 'qsa.sqlite'));
  const parent = dirname(directory);
  const staging = join(parent, `.data-migration-${randomUUID()}`);
  let promoted = false;
  try {
    // EXCLUSIVE retains locks after COMMIT until close, including in WAL mode.
    // This freezes DB writes/checkpoints while the DB, WAL and files are copied.
    db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    assertStopped(db);
    checkDatabase(db);
    // Another migrator may have completed while this connection waited for locks.
    if (entries(directory).length) {
      if (receipt(directory)?.source === sourceId && existsSync(join(directory, 'qsa.sqlite'))) return { directory, migrated: false, custom: false };
      throw new Error(`迁移期间目标目录已有数据，未覆盖：${directory}`);
    }
    const before = databaseFingerprint(db);
    mkdirSync(parent, { recursive: true });
    copyTree(source, staging);
    const copied = new DatabaseSync(join(staging, 'qsa.sqlite'), { readOnly: true });
    try {
      checkDatabase(copied);
      if (databaseFingerprint(copied).sha256 !== before.sha256) throw new Error('迁移后的数据库记录不一致，未启用副本。');
    } finally { copied.close(); }
    const record = { version: 1, source: sourceId, destination: destinationId, migratedAt: new Date().toISOString(), database: before };
    writeReceipt(staging, record);
    if (existsSync(directory)) rmdirSync(directory); // Only succeeds for an empty directory.
    renameSync(staging, directory);
    promoted = true;
    writeReceipt(source, record);
    return { directory, migrated: true, custom: false, source, database: before };
  } catch (error) {
    if (error.errcode === 5 || error.errcode === 6) throw new Error('旧数据库仍被占用，请关闭原 QSA 服务及数据库工具后重试迁移。', { cause: error });
    throw error;
  } finally {
    db.close();
    // Only our unique, unpublished staging directory can be removed on failure.
    if (!promoted && dirname(staging) === parent && staging.startsWith(parent + sep) && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
