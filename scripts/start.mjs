// Double-click entry point. Never installs dependencies or changes system settings.
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本，请更新后重试。');
  const port = process.env.PORT === undefined ? 4174 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的端口号。');

  // Respect an explicit interpreter; otherwise prefer the project's own environment.
  const localPython = join(root, '.venv', 'Scripts', 'python.exe');
  const candidates = process.env.QSA_PYTHON
    ? [[process.env.QSA_PYTHON]]
    : [...(existsSync(localPython) ? [[localPython]] : []), ['python'], ['py', '-3']];
  let python;
  for (const [command, ...args] of candidates) {
    const probe = spawnSync(command, [...args, '-c', 'import sys; print(sys.executable); sys.exit(0 if sys.version_info >= (3,10) else 1)'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (probe.status === 0 && probe.stdout?.trim()) { python = probe.stdout.trim(); break; }
  }
  if (!python) throw new Error('找不到可用的 Python ≥3.10。请安装 Python，或检查 QSA_PYTHON 指向的可执行文件。');
  const dependencies = spawnSync(python, ['-c', 'import openpyxl, defusedxml; from importlib.metadata import version; v=lambda n:tuple(int(x) for x in version(n).split(".")[:3]); assert (3,1,5)<=v("openpyxl")<(4,); assert (0,7,1)<=v("defusedxml")<(1,)'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (dependencies.status !== 0) throw new Error(`Python 依赖缺失或版本不符。请在项目目录的 PowerShell 执行：\n& "${python}" -m pip install -r requirements.txt`);
  try { await import('ai'); await import('@ai-sdk/openai-compatible'); }
  catch { throw new Error('Node.js 依赖缺失或无法加载。请在项目目录执行 npm ci。'); }
  process.env.QSA_PYTHON = python;

  const { createApp } = await import('../server.mjs');
  const app = createApp();
  await new Promise((done, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', done);
  }).catch(error => {
    app.store.close();
    if (error.code === 'EADDRINUSE') throw new Error(`端口 ${port} 已被占用。请检查是否已启动 QSA，或设置其他 PORT；不会自动关闭已有服务。`);
    throw error;
  });
  const url = `http://127.0.0.1:${port}`;
  console.log(`\nQSA 已启动：${url}\nPython：${python}\n请保持此窗口开启。输入 q 并按回车，或按 Ctrl+C，停止服务。\n`);

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    console.log('\n正在停止服务，请稍候……');
    const closed = new Promise(done => app.server.close(done));
    await app.assessment.shutdown();
    await app.indexer.shutdown();
    await closed;
    app.store.close();
    process.exit(0);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', value => { if (value.trim().toLowerCase() === 'q') void stop(); });

  // Only open the browser after this instance has successfully bound its port.
  if (process.env.QSA_NO_BROWSER !== '1') {
    const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log(`浏览器未能自动打开，请手动访问 ${url}`));
    browser.on('exit', code => { if (code) console.log(`浏览器未能自动打开，请手动访问 ${url}`); });
    browser.unref();
  }
}

main().catch(error => {
  console.error(`\n启动失败：${error.message}\n`);
  process.exitCode = 1;
});
