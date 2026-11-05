import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { defaultDataDirectory, prepareDataDirectory, databaseFingerprint } from '../backend/data-directory.mjs';
import { createApp } from '../server.mjs';
import { createVault } from '../backend/vault.mjs';

function fixture(t) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, 'data-location-'));
  const appRoot = join(folder, '程序 中文'), local = join(folder, '用户数据');
  mkdirSync(appRoot); mkdirSync(local);
  const options = { appRoot, platform: 'win32', env: { LOCALAPPDATA: local } };
  const source = join(appRoot, '.data'), destination = join(local, 'QSA-RAG', 'data');
  t.after(() => { assert.ok(folder.startsWith(parent)); rmSync(folder, { recursive: true, force: true }); });
  return { folder, appRoot, local, options, source, destination };
}

async function seed(t, source) {
  const app = createApp({ dataDir: source });
  const secret = process.platform === 'win32' && process.env.QSA_TEST_DPAPI === '1' ? await createVault().encrypt('fixture-key-for-relocation') : 'fixture-ciphertext';
  const project = app.store.create('迁移前的知识库');
  app.store.db.prepare('INSERT INTO model_configs VALUES (?,?,?,?,?)').run('fixture-model', 'generation', '{"name":"模型配置"}', secret, '2026-11-04');
  app.store.db.prepare('INSERT INTO files VALUES (?,?,?,?,?)').run('fixture-file', '历史原表.xlsx', 'fixture', 7, '2026-11-04');
  app.store.db.prepare('INSERT INTO assessment_tasks VALUES (?,?,?,?,?,?,?)').run('fixture-task', 'fixture-file', project.versionId, '{}', 'success', '2026-11-04', '2026-11-04');
  app.store.db.prepare('INSERT INTO assessment_inputs VALUES (?,?,?)').run('fixture-file', '{}', '2026-11-04');
  const snapshot = { input: { id: 'fixture-file', name: '历史原表.xlsx' }, knowledge: { id: project.id, name: project.name }, model: { id: 'fixture-model', name: '模型配置', modelId: 'fixture-model-id' } };
  app.store.db.prepare('INSERT INTO assessment_runs (task_id,project_id,index_id,input_id,snapshot_json,total,processed,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('fixture-task', project.id, 'fixture-index', 'fixture-file', JSON.stringify(snapshot), 0, 0, '2026-11-04');
  writeFileSync(join(source, 'files', 'fixture-file.xlsx'), 'fixture');
  mkdirSync(join(source, 'backups')); writeFileSync(join(source, 'backups', 'before.sqlite'), 'retained-backup');
  app.store.close();
  return { secret, project };
}

test('Windows 默认目录独立于程序；显式参数和环境配置优先，均不触发迁移', t => {
  const f = fixture(t);
  assert.equal(defaultDataDirectory(f.options), f.destination);
  assert.equal(defaultDataDirectory({ platform: 'win32', env: {}, userHome: f.folder }), join(f.folder, 'AppData', 'Local', 'QSA-RAG', 'data'));
  assert.throws(() => defaultDataDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'relative' } }), /绝对路径/);
  const env = { ...f.options.env, QSA_DATA_DIR: join(f.folder, '指定目录') };
  assert.equal(prepareDataDirectory({ ...f.options, env }).directory, env.QSA_DATA_DIR);
  assert.equal(prepareDataDirectory({ ...f.options, env, dataDir: f.source }).directory, f.source);
  assert.equal(existsSync(f.destination), false);
  assert.equal(prepareDataDirectory(f.options).directory, f.destination);
  assert.equal(existsSync(f.destination), false, '路径解析不应创建空库');
});

test('迁移保留全部记录、rowid、原文件、备份和密文，重启不会重复导入', async t => {
  const f = fixture(t), { secret } = await seed(t, f.source);
  const beforeDb = new DatabaseSync(join(f.source, 'qsa.sqlite'), { readOnly: true });
  const before = databaseFingerprint(beforeDb); beforeDb.close();
  const result = prepareDataDirectory(f.options);
  assert.equal(result.migrated, true);
  assert.equal(result.database.sha256, before.sha256);
  assert.equal(readFileSync(join(f.destination, 'files', 'fixture-file.xlsx'), 'utf8'), 'fixture');
  assert.equal(readFileSync(join(f.destination, 'backups', 'before.sqlite'), 'utf8'), 'retained-backup');
  assert.equal(readFileSync(join(f.source, 'files', 'fixture-file.xlsx'), 'utf8'), 'fixture');
  const moved = new DatabaseSync(join(f.destination, 'qsa.sqlite'));
  assert.deepEqual(databaseFingerprint(moved), before);
  assert.equal(moved.prepare('SELECT secret_ref FROM model_configs').get().secret_ref, secret);
  if (process.platform === 'win32' && process.env.QSA_TEST_DPAPI === '1') assert.equal(await createVault().decrypt(secret), 'fixture-key-for-relocation');
  moved.prepare('UPDATE knowledge_projects SET name=?').run('迁移后新增改动'); moved.close();
  assert.equal(prepareDataDirectory(f.options).migrated, false);
  const restarted = createApp({ dataDir: f.destination });
  assert.equal(restarted.store.list()[0].name, '迁移后新增改动');
  assert.equal(restarted.store.db.prepare('SELECT count(*) n FROM assessment_tasks').get().n, 1);
  restarted.store.close();
  assert.equal(readdirSync(join(f.local, 'QSA-RAG')).some(name => name.startsWith('.data-migration-')), false);
});

test('createApp 读取外部数据配置，迁移后的知识库和历史通过 HTTP 可读', async t => {
  const f = fixture(t); await seed(t, f.source); prepareDataDirectory(f.options);
  const previous = process.env.LOCALAPPDATA, previousCustom = process.env.QSA_DATA_DIR;
  process.env.LOCALAPPDATA = f.local; process.env.QSA_DATA_DIR = f.destination;
  let app;
  try { app = createApp(); }
  finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    if (previousCustom === undefined) delete process.env.QSA_DATA_DIR; else process.env.QSA_DATA_DIR = previousCustom;
  }
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await (await fetch(base + '/api/knowledge')).json()).projects[0].name, '迁移前的知识库');
    assert.equal((await (await fetch(base + '/api/assessment/tasks')).json()).tasks.length, 1);
    assert.equal((await fetch(base + '/.qsa-data-migration.json')).status, 404);
  } finally { await new Promise(done => app.server.close(done)); app.store.close(); }
});

test('检测到活跃服务时拒绝迁移，不创建目标目录', async t => {
  const f = fixture(t); await seed(t, f.source);
  const app = createApp({ dataDir: f.source });
  try { assert.throws(() => prepareDataDirectory(f.options), /关闭原服务/); }
  finally { app.store.close(); }
  assert.equal(existsSync(f.destination), false);
  assert.equal(prepareDataDirectory(f.options).migrated, true);
});

test('没有服务租约但数据库仍被其他进程写锁占用时拒绝迁移', async t => {
  const f = fixture(t); await seed(t, f.source);
  const db = new DatabaseSync(join(f.source, 'qsa.sqlite')); db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => prepareDataDirectory(f.options), /数据库仍被占用/); }
  finally { db.exec('ROLLBACK'); db.close(); }
  assert.equal(existsSync(f.destination), false);
});

test('复制 SQLite WAL 中尚未 checkpoint 的记录，忽略共享内存文件', async t => {
  const f = fixture(t); await seed(t, f.source);
  // A crashed process leaves committed rows in the WAL without a service lease.
  const child = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');db.prepare('UPDATE knowledge_projects SET name=?').run('WAL 中的新记录');process.exit(0);`, join(f.source, 'qsa.sqlite')], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(existsSync(join(f.source, 'qsa.sqlite-wal')));
  prepareDataDirectory(f.options);
  const db = new DatabaseSync(join(f.destination, 'qsa.sqlite'));
  try { assert.equal(db.prepare('SELECT name FROM knowledge_projects').get().name, 'WAL 中的新记录'); }
  finally { db.close(); }
});

test('目标已有独立数据时拒绝覆盖，也不合并新旧数据库', async t => {
  const f = fixture(t); await seed(t, f.source); await seed(t, f.destination);
  assert.throws(() => prepareDataDirectory(f.options), /新旧目录都有数据/);
  assert.equal(existsSync(join(f.source, '.qsa-data-migration.json')), false);
});

test('目标是空目录时允许迁移；迁移后目录丢失时拒绝从旧快照重建', async t => {
  const f = fixture(t); await seed(t, f.source); mkdirSync(f.destination, { recursive: true });
  prepareDataDirectory(f.options);
  renameSync(f.destination, join(f.local, 'QSA-RAG', 'saved-data'));
  assert.throws(() => prepareDataDirectory(f.options), /恢复完整备份/);
  assert.equal(existsSync(f.destination), false);
});

test('发布副本后意外退出可补齐旧目录记录，重复迁移仍被阻止', async t => {
  const f = fixture(t); await seed(t, f.source); prepareDataDirectory(f.options);
  rmSync(join(f.source, '.qsa-data-migration.json'));
  assert.equal(prepareDataDirectory(f.options).migrated, false);
  assert.ok(existsSync(join(f.source, '.qsa-data-migration.json')));
  renameSync(f.destination, join(f.local, 'QSA-RAG', 'saved-data'));
  assert.throws(() => prepareDataDirectory(f.options), /恢复完整备份/);
});

test('外键损坏时停止，原数据和目标保持原状', async t => {
  const f = fixture(t); await seed(t, f.source);
  const db = new DatabaseSync(join(f.source, 'qsa.sqlite'));
  db.exec("PRAGMA foreign_keys=OFF; UPDATE assessment_tasks SET input_file_id='missing-file'"); db.close();
  assert.throws(() => prepareDataDirectory(f.options), /外键异常/);
  assert.equal(existsSync(f.destination), false);
  assert.equal(existsSync(join(f.source, '.qsa-data-migration.json')), false);
});

test('原目录只有残缺文件、数据库损坏或目标含其他文件时停止，不创建空库', t => {
  const f = fixture(t); mkdirSync(f.source); writeFileSync(join(f.source, 'orphan.xlsx'), 'keep');
  assert.throws(() => prepareDataDirectory(f.options), /没有 qsa.sqlite/);
  writeFileSync(join(f.source, 'qsa.sqlite'), 'broken');
  assert.throws(() => prepareDataDirectory(f.options));
  assert.equal(existsSync(f.destination), false);
  mkdirSync(f.destination, { recursive: true }); writeFileSync(join(f.destination, 'keep.txt'), 'keep');
  assert.throws(() => prepareDataDirectory(f.options), /已有其他文件/);
  assert.equal(readFileSync(join(f.destination, 'keep.txt'), 'utf8'), 'keep');
});
