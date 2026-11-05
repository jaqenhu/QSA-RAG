import { createApp } from '../server.mjs';
import { spawnSync } from 'node:child_process';
import { pythonScript } from '../backend/python-path.mjs';
import { closeService } from '../backend/close-service.mjs';

let service, stopping = false, stopPromise;
const reply = (id, value) => process.parentPort.postMessage({ id, value });
async function stop() {
  stopping = true;
  stopPromise ||= closeService(service);
  await stopPromise;
}

process.parentPort.on('message', async ({ data }) => {
  const { id, action } = data || {};
  if (!id || !service) return;
  try {
    if (action === 'status') return reply(id, { ...service.activity(), stopping });
    if (!['stop', 'stop-if-idle'].includes(action)) return;
    if (action === 'stop-if-idle' && (stopping || service.activity().busy)) return reply(id, { stopped: false, busy: true });
    // No await between the idle check and server.close(): no new work can race in.
    await stop();
    reply(id, { stopped: true });
    setImmediate(() => process.exit(0));
  } catch { process.parentPort.postMessage({ id, error: '本机服务未能安全停止，请稍后重试。' }); }
});

try {
  const python = process.env.QSA_PYTHON;
  const probe = spawnSync(python, ['-X', 'utf8', '-c', 'import sys, openpyxl, defusedxml, ctypes, runpy; runpy.run_path(sys.argv[1]); print(sys.version.split()[0])', pythonScript('assessment_workbook.py')], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (probe.status !== 0) throw new Error('内置 Excel 运行环境不可用，请重新安装应用。');
  service = createApp({ python });
  await new Promise((done, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', done); });
  process.parentPort.postMessage({ type: 'ready', url: `http://127.0.0.1:${service.server.address().port}`, dataDirectory: service.dataDirectory, node: process.versions.node, python: probe.stdout.trim() });
} catch (error) {
  process.parentPort.postMessage({ type: 'startup-error', message: error.message });
  try { service?.store.close(); } catch {}
  setImmediate(() => process.exit(1));
}
