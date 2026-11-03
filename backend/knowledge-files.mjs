import { randomUUID } from 'node:crypto';
import { modelFingerprint } from './models.mjs';

// Each version is an immutable manifest. Removing a file never removes old evidence.
export function createKnowledgeFiles(db, transaction, ApiError) {
  const columns = new Set(db.prepare('PRAGMA table_info(knowledge_records)').all().map(row => row.name));
  transaction(() => {
    for (const column of ['document_id', 'source_sheet', 'file_name']) if (!columns.has(column)) db.exec(`ALTER TABLE knowledge_records ADD COLUMN ${column} TEXT`);
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_version_files (
      version_id TEXT NOT NULL REFERENCES knowledge_versions(id), document_id TEXT NOT NULL,
      file_id TEXT NOT NULL REFERENCES files(id), parsed_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(version_id,document_id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_purged_documents (
      project_id TEXT NOT NULL REFERENCES knowledge_projects(id), document_id TEXT NOT NULL,
      purged_at TEXT NOT NULL, PRIMARY KEY(project_id,document_id));
      CREATE TABLE IF NOT EXISTS knowledge_file_cleanup (file_id TEXT PRIMARY KEY REFERENCES files(id));
      INSERT OR IGNORE INTO schema_migrations VALUES (8,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=7').get()) {
      for (const version of db.prepare('SELECT v.*,f.name FROM knowledge_versions v JOIN files f ON f.id=v.file_id').all()) {
        const parsed = { summary: JSON.parse(version.summary_json), sheets: JSON.parse(version.sheets_json), diagnostics: JSON.parse(version.diagnostics_json) };
        db.prepare('INSERT INTO knowledge_version_files VALUES (?,?,?,?,0)').run(version.id, version.project_id, version.file_id, JSON.stringify(parsed));
        db.prepare('UPDATE knowledge_records SET document_id=?,source_sheet=sheet,file_name=? WHERE version_id=?').run(version.project_id, version.name, version.id);
      }
      db.exec("INSERT INTO schema_migrations VALUES (7,strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
    }
  });
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  function manifest(versionId) {
    return db.prepare(`SELECT m.*,f.name,f.sha256,f.bytes,f.created_at FROM knowledge_version_files m JOIN files f ON f.id=m.file_id WHERE version_id=? AND NOT EXISTS (SELECT 1 FROM knowledge_purged_documents p WHERE p.document_id=m.document_id) ORDER BY m.rowid`).all(versionId)
      .map(row => ({ ...row, parsed: JSON.parse(row.parsed_json) }));
  }
  function enrich(project) {
    const files = manifest(project.versionId);
    const index = db.prepare(`SELECT i.* FROM knowledge_indexes i JOIN knowledge_versions v ON v.id=i.version_id WHERE v.project_id=? AND i.status='ready' ORDER BY i.created_at DESC,i.rowid DESC LIMIT 1`).get(project.id);
    const indexedFiles = index ? manifest(index.version_id) : [];
    const indexConfig = index ? JSON.parse(index.config_json) : null;
    const indexModel = index ? db.prepare('SELECT * FROM model_configs WHERE id=?').get(index.model_id) : null;
    const metadata = indexModel ? JSON.parse(indexModel.metadata_json) : null;
    const compatible = Boolean(indexModel && indexModel.type === 'embedding' && !metadata.deletedAt && modelFingerprint(metadata) === indexConfig.modelFingerprint && indexConfig.policyVersion === 'qa-v1');
    const job = hasTable('training_jobs') ? db.prepare('SELECT * FROM training_jobs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(project.id) : null;
    const jobScopes = job ? JSON.parse(job.config_json).sheets : [];
    const descriptors = files.map(file => {
      const scopes = file.parsed.sheets.filter(s => s.headerRow !== null).map(s => s.scope || s.name);
      const same = compatible && indexedFiles.find(old => old.document_id === file.document_id && old.file_id === file.file_id && !old.deleted);
      const learnedCount = same && hasTable('index_vectors') ? db.prepare('SELECT COUNT(*) count FROM index_vectors v JOIN knowledge_records r ON r.id=v.record_id WHERE v.index_id=? AND r.document_id=?').get(index.id, file.document_id).count : 0;
      const included = job?.version_id === project.versionId && scopes.some(scope => jobScopes.includes(scope));
      const old = indexedFiles.some(item => item.document_id === file.document_id && !item.deleted);
      let status = same && learnedCount > 0 ? 'learned' : old ? 'outdated' : 'unlearned';
      if (included && job.status === 'running') status = 'learning';
      else if (included && job.status === 'failed') status = 'failed';
      return { id: file.document_id, fileId: file.file_id, name: file.name, bytes: file.bytes, sha256: file.sha256, createdAt: file.created_at,
        summary: file.parsed.summary, sheets: file.parsed.sheets, status, learnedCount, error: included && job.status === 'failed' ? job.error : null, deleted: Boolean(file.deleted) };
    });
    const sheetDetails = project.sheetDetails.map(sheet => sheet.documentId ? sheet : { ...sheet,documentId:project.id,sourceSheet:sheet.name,fileName:project.fileName,label:`${project.fileName} / ${sheet.name}` });
    return { ...project, sheetDetails, files: descriptors.filter(f => !f.deleted), trashFiles: descriptors.filter(f => f.deleted), fileCount: descriptors.filter(f => !f.deleted).length };
  }
  function assertVersion(id, expected) {
    const project = db.prepare('SELECT * FROM knowledge_projects WHERE id=? AND deleted_at IS NULL').get(id);
    if (!project) throw new ApiError(404, '知识库不存在或已删除。');
    if (project.current_version_id !== expected) throw new ApiError(409, '知识库已更新，请刷新后重试。');
    if (hasTable('training_jobs') && db.prepare("SELECT 1 FROM training_jobs WHERE project_id=? AND status='running'").get(id)) throw new ApiError(409, '知识库正在训练，请等待完成或取消训练后修改文件。');
    return project;
  }
  const emptySummary = () => ({ questionCount: 0, answeredCount: 0, missingCount: 0, skippedCount: 0, reasons: {} });
  function publish(id, files) {
    const active = files.filter(f => !f.deleted);
    const summary = emptySummary(), sheets = [], diagnostics = [];
    for (const file of active) {
      for (const key of ['questionCount', 'answeredCount', 'missingCount', 'skippedCount']) summary[key] += file.parsed.summary[key] || 0;
      for (const [reason, count] of Object.entries(file.parsed.summary.reasons || {})) summary.reasons[reason] = (summary.reasons[reason] || 0) + count;
      sheets.push(...file.parsed.sheets.map(sheet => ({ ...sheet, name: sheet.scope || sheet.name, sourceSheet: sheet.sourceSheet || sheet.name, fileName: file.name, documentId: file.document_id, label: `${file.name} / ${sheet.sourceSheet || sheet.name}` })));
      diagnostics.push(...file.parsed.diagnostics.map(item => ({ ...item, fileName: file.name })));
    }
    const versionId = randomUUID(), time = new Date().toISOString();
    const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM knowledge_versions WHERE project_id=?').get(id).n;
    let fileId = active[0]?.file_id || files[0]?.file_id;
    if (!fileId) { fileId = randomUUID(); db.prepare('INSERT INTO files VALUES (?,?,?,?,?)').run(fileId, '暂无文件', '', 0, time); }
    db.prepare('INSERT INTO knowledge_versions VALUES (?,?,?,?,?,?,?,?)').run(versionId,id,number,fileId,JSON.stringify(summary),JSON.stringify(sheets),JSON.stringify(diagnostics),time);
    const insert = db.prepare('INSERT INTO knowledge_records (id,version_id,sheet,line,chapter,question,answer,question_cell,answer_cell,status,document_id,source_sheet,file_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const file of files) {
      const { records, ...metadata } = file.parsed;
      db.prepare('INSERT INTO knowledge_version_files VALUES (?,?,?,?,?)').run(versionId,file.document_id,file.file_id,JSON.stringify(metadata),file.deleted ? 1 : 0);
      if (file.deleted) continue;
      const rows = records || db.prepare('SELECT sheet,line,chapter,question,answer,question_cell questionCell,answer_cell answerCell,status,source_sheet sourceSheet FROM knowledge_records WHERE version_id=? AND document_id=?').all(file.version_id,file.document_id);
      for (const row of rows) insert.run(randomUUID(),versionId,row.scope || row.sheet,row.line,row.chapter,row.question,row.answer,row.questionCell,row.answerCell,row.status,file.document_id,row.sourceSheet || row.sheet,file.name);
    }
    db.prepare('UPDATE knowledge_projects SET current_version_id=? WHERE id=?').run(versionId,id);
    return versionId;
  }
  function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new ApiError(400, '知识库名称应为 1–100 个字。');
    return value.trim();
  }
  return {
    enrich, manifest, assertVersion,
    create(value) { return transaction(() => { const title = name(value), id = randomUUID(); db.prepare('INSERT INTO knowledge_projects VALUES (?,?,NULL,NULL,?)').run(id,title,new Date().toISOString()); publish(id,[]); return id; }); },
    rename(id, input) { transaction(() => { assertVersion(id,input.expectedVersionId); db.prepare('UPDATE knowledge_projects SET name=? WHERE id=?').run(name(input.name),id); }); },
    purge(id, documentId, input) { transaction(() => {
      const project=assertVersion(id,input.expectedVersionId);
      const file=manifest(project.current_version_id).find(f=>f.document_id===documentId && f.deleted);
      if(!file)throw new ApiError(404,'已删除文件不存在，或已被彻底删除。');
      if(input.confirmed!==true)throw new ApiError(400,'请确认彻底删除此文件，此操作无法撤销。');
      if(hasTable('assessment_runs') && db.prepare("SELECT 1 FROM assessment_runs r JOIN assessment_tasks t ON t.id=r.task_id WHERE r.project_id=? AND t.status='running'").get(id))throw new ApiError(409,'该知识库正在用于自评，请等待完成或停止任务后再彻底删除。');
      db.prepare('INSERT INTO knowledge_purged_documents VALUES (?,?,?)').run(id,documentId,new Date().toISOString());
      const records='SELECT r.id FROM knowledge_records r JOIN knowledge_versions v ON v.id=r.version_id WHERE v.project_id=? AND r.document_id=?';
      if(hasTable('index_vectors'))db.prepare(`DELETE FROM index_vectors WHERE record_id IN (${records})`).run(id,documentId);
      // Only records linked to historical assessment evidence remain for auditing.
      db.prepare(`DELETE FROM knowledge_records WHERE id IN (${records}) AND id NOT IN (SELECT record_id FROM result_sources)`).run(id,documentId);
      const fileIds=db.prepare('SELECT DISTINCT m.file_id FROM knowledge_version_files m JOIN knowledge_versions v ON v.id=m.version_id WHERE v.project_id=? AND m.document_id=?').all(id,documentId);
      for(const {file_id:fileId} of fileIds){
        const shared=db.prepare('SELECT 1 FROM knowledge_version_files m WHERE m.file_id=? AND NOT EXISTS (SELECT 1 FROM knowledge_purged_documents p WHERE p.document_id=m.document_id)').get(fileId);
        const inputFile=db.prepare('SELECT 1 FROM assessment_tasks WHERE input_file_id=?').get(fileId) || (hasTable('assessment_inputs') && db.prepare('SELECT 1 FROM assessment_inputs WHERE id=?').get(fileId));
        if(!shared && !inputFile)db.prepare('INSERT OR IGNORE INTO knowledge_file_cleanup VALUES (?)').run(fileId);
      }
    }); },
    commit(importId, options) { return transaction(() => {
      const project = assertVersion(options.projectId,options.expectedVersionId);
      const staged = db.prepare('SELECT i.*,f.name,f.sha256 FROM knowledge_imports i JOIN files f ON f.id=i.id WHERE i.id=?').get(importId);
      if (!staged) throw new ApiError(404, '待导入文件不存在，请重新上传。');
      if (staged.committed_version_id) throw new ApiError(409, '该文件已完成导入。');
      const files = manifest(project.current_version_id);
      const previous = options.mode === 'replace-file' ? files.find(f => f.document_id === options.documentId && !f.deleted) : null;
      if (options.mode === 'replace-file' && !previous) throw new ApiError(404, '要替换的文件不存在。');
      if (files.some(f => !f.deleted && f.sha256 === staged.sha256)) throw new ApiError(409, '当前知识库已存在相同内容的文件，无需重复上传。');
      if (files.some(f => !f.deleted && f.name === staged.name && f !== previous)) throw new ApiError(409, '已有同名文件，请使用“替换文件”更新。');
      const documentId = previous?.document_id || randomUUID();
      const parsed = JSON.parse(staged.parsed_json);
      // Scope is internal and stable; sourceSheet remains the original workbook sheet name.
      parsed.sheets = parsed.sheets.map(s => ({ ...s, scope: `${documentId}/${s.name}`, sourceSheet: s.name }));
      parsed.records = parsed.records.map(r => ({ ...r, scope: `${documentId}/${r.sheet}`, sourceSheet: r.sheet }));
      const entry = { document_id: documentId,file_id: importId,name: staged.name,parsed,deleted: 0 };
      const next = previous ? files.map(f => f === previous ? entry : f) : [...files,entry];
      const versionId = publish(project.id,next);
      db.prepare('UPDATE knowledge_imports SET committed_version_id=? WHERE id=?').run(versionId,importId);
      return project.id;
    }); },
    mutate(id, documentId, input, restore = false) { transaction(() => {
      const project = assertVersion(id,input.expectedVersionId), files = manifest(project.current_version_id);
      const file = files.find(f => f.document_id === documentId && Boolean(f.deleted) === restore);
      if (!file) throw new ApiError(404, restore ? '已删除文件不存在。' : '文件不存在。');
      if (restore && files.some(f => !f.deleted && (f.sha256 === file.sha256 || f.name === file.name))) throw new ApiError(409, '存在同名或相同内容文件，请先处理冲突。');
      file.deleted = restore ? 0 : 1;
      // Deleted manifests retain their source version, including across restarts.
      if (restore) {
        const source = db.prepare('SELECT version_id FROM knowledge_version_files WHERE document_id=? AND file_id=? AND deleted=0 ORDER BY rowid DESC LIMIT 1').get(documentId,file.file_id);
        file.version_id = source.version_id;
      }
      publish(id,files);
    }); },
  };
}
