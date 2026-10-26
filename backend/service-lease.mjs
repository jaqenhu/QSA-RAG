import { randomUUID } from 'node:crypto';
import { ApiError } from './store.mjs';

// One writer service per data directory. A second launch must not mark a live
// service's training jobs as interrupted, even if it chooses another port.
export function claimService(store) {
  const db = store.db;
  db.exec('CREATE TABLE IF NOT EXISTS service_lease (id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL)');
  const token = randomUUID();
  store.transaction(() => {
    const previous = db.prepare('SELECT * FROM service_lease WHERE id=1').get();
    if (previous) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new ApiError(409, '此数据目录已有 QSA 服务运行，请先关闭原服务。');
    }
    db.prepare('INSERT OR REPLACE INTO service_lease VALUES (1,?,?)').run(process.pid, token);
  });
  const close = store.close;
  let closed = false;
  store.close = () => {
    if (closed) return;
    closed = true;
    try { db.prepare('DELETE FROM service_lease WHERE id=1 AND token=?').run(token); }
    finally { close(); }
  };
}
