import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function createStore(directory) {
  mkdirSync(join(directory, 'files'), { recursive: true });
  const db = new DatabaseSync(join(directory, 'qsa.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT, deleted_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES knowledge_projects(id), number INTEGER NOT NULL, file_id TEXT NOT NULL REFERENCES files(id), summary_json TEXT NOT NULL, sheets_json TEXT NOT NULL, diagnostics_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,number));
    CREATE TABLE IF NOT EXISTS knowledge_records (id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES knowledge_versions(id), sheet TEXT NOT NULL, line INTEGER NOT NULL, chapter TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, question_cell TEXT NOT NULL, answer_cell TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(version_id,sheet,line));
    CREATE INDEX IF NOT EXISTS records_version_sheet ON knowledge_records(version_id,sheet,line);
    CREATE TABLE IF NOT EXISTS knowledge_imports (id TEXT PRIMARY KEY REFERENCES files(id), parsed_json TEXT NOT NULL, committed_version_id TEXT REFERENCES knowledge_versions(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_configs (id TEXT PRIMARY KEY, type TEXT NOT NULL, metadata_json TEXT NOT NULL, secret_ref TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_indexes (id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES knowledge_versions(id), model_id TEXT NOT NULL REFERENCES model_configs(id), dimensions INTEGER NOT NULL, config_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assessment_tasks (id TEXT PRIMARY KEY, input_file_id TEXT NOT NULL REFERENCES files(id), knowledge_version_id TEXT NOT NULL REFERENCES knowledge_versions(id), model_snapshot_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS assessment_results (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES assessment_tasks(id), input_sheet TEXT NOT NULL, input_row INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS result_sources (result_id TEXT NOT NULL REFERENCES assessment_results(id), record_id TEXT NOT NULL REFERENCES knowledge_records(id), excerpt TEXT NOT NULL, PRIMARY KEY(result_id,record_id));
    INSERT OR IGNORE INTO schema_migrations VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const versionQuery = `SELECT p.id,p.name,p.deleted_at,p.created_at,v.id version_id,v.number,v.summary_json,v.sheets_json,v.created_at updated_at,f.name file_name,f.sha256
    FROM knowledge_projects p JOIN knowledge_versions v ON v.id=p.current_version_id JOIN files f ON f.id=v.file_id`;
  function project(row) {
    const sheets = JSON.parse(row.sheets_json);
    return { id: row.id, name: row.name, versionId: row.version_id, version: row.number,
      fileName: row.file_name, sha256: row.sha256, summary: JSON.parse(row.summary_json), sheetDetails: sheets,
      sheets: Object.fromEntries(sheets.filter(s => s.headerRow !== null).map(s => [s.name, s.questionCount])),
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }
  function getProject(id, includeDeleted = false) {
    const row = db.prepare(`${versionQuery} WHERE p.id=? ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}`).get(id);
    if (!row) throw new ApiError(404, '知识库不存在或已删除，请刷新项目列表。');
    return project(row);
  }
  function getVersion(id, versionId) {
    getProject(id);
    const version = db.prepare('SELECT * FROM knowledge_versions WHERE project_id=? AND id=?').get(id, versionId);
    if (!version) throw new ApiError(404, '知识库版本不存在。');
    return version;
  }
  return {
    db, close: () => db.close(), transaction,
    list: () => db.prepare(`${versionQuery} WHERE p.deleted_at IS NULL ORDER BY p.created_at,p.id`).all().map(project),
    trash: () => db.prepare(`${versionQuery} WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC,p.id`).all().map(project),
    getProject,
    stage(file, parsed) {
      transaction(() => {
        db.prepare('INSERT INTO files VALUES (?,?,?,?,?)').run(file.id, file.name, file.sha256, file.bytes, file.createdAt);
        db.prepare('INSERT INTO knowledge_imports VALUES (?,?,NULL,?)').run(file.id, JSON.stringify(parsed), file.createdAt);
      });
    },
    commit(importId, options) {
      return transaction(() => {
        const item = db.prepare('SELECT i.*,f.name,f.sha256 FROM knowledge_imports i JOIN files f ON f.id=i.id WHERE i.id=?').get(importId);
        if (!item) throw new ApiError(404, '待导入文件不存在，请重新选择文件。');
        if (item.committed_version_id) throw new ApiError(409, '该文件已完成导入，请刷新知识库列表。');
        const parsed = JSON.parse(item.parsed_json);
        let id, number;
        const time = new Date().toISOString();
        if (options.mode === 'replace') {
          const old = getProject(options.projectId);
          if (old.versionId !== options.expectedVersionId) throw new ApiError(409, '知识库已发生变化，请重新核对替换目标。');
          if (old.sha256 === item.sha256) throw new ApiError(409, '文件与当前版本完全相同，无需重复替换。');
          id = old.id; number = old.version + 1;
        } else {
          id = randomUUID(); number = 1;
          db.prepare('INSERT INTO knowledge_projects VALUES (?,?,NULL,NULL,?)').run(id, options.name || item.name, time);
        }
        const versionId = randomUUID();
        db.prepare('INSERT INTO knowledge_versions VALUES (?,?,?,?,?,?,?,?)').run(versionId, id, number, item.id,
          JSON.stringify(parsed.summary), JSON.stringify(parsed.sheets), JSON.stringify(parsed.diagnostics), time);
        const insert = db.prepare('INSERT INTO knowledge_records VALUES (?,?,?,?,?,?,?,?,?,?)');
        for (const r of parsed.records) insert.run(randomUUID(), versionId, r.sheet, r.line, r.chapter, r.question, r.answer, r.questionCell, r.answerCell, r.status);
        db.prepare('UPDATE knowledge_projects SET current_version_id=? WHERE id=?').run(versionId, id);
        db.prepare('UPDATE knowledge_imports SET committed_version_id=? WHERE id=?').run(versionId, importId);
        return getProject(id);
      });
    },
    remove(id, expectedVersionId) {
      return transaction(() => {
        const current = getProject(id);
        if (current.versionId !== expectedVersionId) throw new ApiError(409, '知识库已更新，请刷新后重新确认删除。');
        db.prepare('UPDATE knowledge_projects SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id);
        return { id };
      });
    },
    restore(id) {
      getProject(id, true);
      db.prepare('UPDATE knowledge_projects SET deleted_at=NULL WHERE id=?').run(id);
      return getProject(id);
    },
    records(id, params) {
      const current = getProject(id);
      const versionId = params.get('version') || current.versionId;
      const version = getVersion(id, versionId);
      const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 30));
      const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
      if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit)) throw new ApiError(400, '分页参数无效。');
      const sheet = (params.get('sheet') || '').slice(0, 100);
      const search = (params.get('q') || '').trim().slice(0, 200).toLowerCase();
      const status = params.get('status') || 'all';
      const clauses = ['version_id=?'];
      const args = [versionId];
      if (sheet) { clauses.push('sheet=?'); args.push(sheet); }
      if (search) { clauses.push('(instr(lower(question),?)>0 OR instr(lower(answer),?)>0 OR instr(lower(chapter),?)>0)'); args.push(search, search, search); }
      if (status === 'missing') clauses.push("status='missing'");
      const where = clauses.join(' AND ');
      const total = db.prepare(`SELECT COUNT(*) count FROM knowledge_records WHERE ${where}`).get(...args).count;
      const rows = db.prepare(`SELECT id,sheet,line,chapter,question,answer,question_cell questionCell,answer_cell answerCell,status FROM knowledge_records WHERE ${where} ORDER BY sheet,line LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
      return { records: rows, total, page, limit, versionId, summary: JSON.parse(version.summary_json) };
    },
    versions(id) {
      getProject(id);
      return db.prepare('SELECT id,number,file_id fileId,summary_json,created_at createdAt FROM knowledge_versions WHERE project_id=? ORDER BY number DESC').all(id)
        .map(({ summary_json, ...row }) => ({ ...row, summary: JSON.parse(summary_json) }));
    },
    diagnostics(id, versionId) {
      const version = getVersion(id, versionId || getProject(id).versionId);
      return { summary: JSON.parse(version.summary_json), sheets: JSON.parse(version.sheets_json), diagnostics: JSON.parse(version.diagnostics_json) };
    },
  };
}
