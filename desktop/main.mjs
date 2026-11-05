import { app, BrowserWindow, dialog, Menu, shell, utilityProcess, screen } from 'electron';
import updaterPackage from 'electron-updater';
import { join } from 'node:path';
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { BackendHost } from './backend-host.mjs';
import { DesktopUpdates } from './updates.mjs';

app.setName('QSA-RAG');
app.setAppUserModelId('com.jaqenhu.qsa-rag');
// Keep desktop preferences separate from the shared business data directory.
if (process.env.QSA_DESKTOP_TEST_HOME) app.setPath('userData', process.env.QSA_DESKTOP_TEST_HOME);
else app.setPath('userData', join(app.getPath('appData'), 'QSA-RAG'));

let window, host, updates, allowExit = false, quitting = false, interactiveUpdate = false;
const log = message => {
  const folder = join(app.getPath('userData'), 'logs'); mkdirSync(folder, { recursive: true });
  appendFileSync(join(folder, 'desktop.log'), `${new Date().toISOString()} ${message}\n`);
};
const message = options => dialog.showMessageBox(window && !window.isDestroyed() ? window : undefined, { title: 'QSA-RAG', ...options });

async function quit() {
  if (quitting || allowExit) return;
  quitting = true;
  log('quit requested');
  try {
    if (host && !host.exited) {
      const status = await host.request('status');
      if (status.training || status.assessments || status.foregroundRequests) {
        const choice = await message({ type: 'question', message: '还有任务或文件正在处理', detail: '停止并退出会保留已完成结果。也可以继续等待任务完成。', buttons: ['继续等待', '停止并退出'], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) return;
      }
      window?.setTitle('QSA-RAG · 正在关闭…');
      await host.stop();
    }
    log('backend closed safely');
    allowExit = true; app.quit();
  } catch (error) {
    log(`quit failed: ${error.message}`); window?.setTitle('QSA-RAG');
    await message({ type: 'error', message: '暂时无法安全退出，请稍后重试。' });
  }
  finally { quitting = false; }
}

async function installUpdate() {
  if (quitting) return;
  quitting = true;
  try {
    if (!await updates.install(host)) await message({ type: 'info', message: '请等待当前任务或文件处理完成，再安装更新。' });
  } catch { await message({ type: 'error', message: '更新暂时无法安装，请稍后重试。' }); }
  finally { quitting = false; }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '应用', submenu: [
      { label: '打开数据目录', click: () => { void shell.openPath(host.dataDirectory); } },
      { type: 'separator' },
      { id: 'qsa-check-updates', label: updates.state === 'downloading' ? '正在下载更新…' : updates.state === 'checking' ? '正在检查更新…' : '检查更新', enabled: !['checking', 'downloading'].includes(updates.state), click: async () => {
        interactiveUpdate = true;
        const state = await updates.check();
        if (state === 'development') { interactiveUpdate = false; await message({ message: '开发模式下不检查更新，请使用已安装的桌面版。' }); }
        else if (state === 'downloaded') {
          interactiveUpdate = false;
          const choice = await message({ message: '新版本已下载，是否现在安装？', buttons: ['稍后安装', '现在安装'], defaultId: 0, cancelId: 0 });
          if (choice.response === 1) await installUpdate();
        }
      } },
      { id: 'qsa-install-update', label: '安装已下载的更新', enabled: updates.state === 'downloaded', click: () => { void installUpdate(); } },
      { type: 'separator' }, { id: 'qsa-quit', label: '退出', accelerator: 'Alt+F4', click: () => { void quit(); } },
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
    { label: '帮助', submenu: [{ label: '关于 QSA-RAG', click: () => { void message({ message: 'QSA-RAG', detail: `版本 ${app.getVersion()}${app.getVersion().includes('-') ? '（测试版）' : ''}\n本地知识库管理与供应商自评工作台` }); } }] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('before-quit', event => { if (!allowExit) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => { if (allowExit) app.quit(); });
  app.whenReady().then(async () => {
    mkdirSync(app.getPath('userData'), { recursive: true });
    const root = app.getAppPath();
    const python = app.isPackaged ? join(process.resourcesPath, 'python', 'python.exe') : join(root, '.build', 'python-win-x64', 'python.exe');
    if (!existsSync(python)) throw new Error('未找到内置运行环境，请先准备桌面版依赖或重新安装。');
    const env = { ...process.env, QSA_PYTHON: python, QSA_NO_BROWSER: '1' };
    if (app.isPackaged) env.QSA_PYTHON_SCRIPTS = join(process.resourcesPath, 'python-scripts');
    // Child utility process reuses Electron's Node.js; no extra Node install needed.
    host = new BackendHost(utilityProcess.fork(join(root, 'desktop', 'backend-worker.mjs'), [], { env, cwd: app.getPath('userData'), stdio: 'pipe', serviceName: 'QSA 本机服务' }));
    host.child.stdout.on('data', () => {});
    let starting = true;
    host.on('failure', async error => {
      if (starting) return;
      log('backend stopped unexpectedly');
      await message({ type: 'error', message: error.message }); allowExit = true; app.quit();
    });
    const timer = setTimeout(() => { if (starting) host.emit('failure', new Error('本机服务启动超时。')); }, 120000);
    try { await new Promise((done, reject) => { host.once('ready', done); host.once('failure', reject); }); }
    finally { clearTimeout(timer); starting = false; }
    log(`ready version=${app.getVersion()} node=${host.node} python=${host.python}`);
    if (process.env.QSA_DESKTOP_TEST_HOME) writeFileSync(join(app.getPath('userData'), 'runtime-state.json'), JSON.stringify({ pid: process.pid, version: app.getVersion(), url: host.url, dataDirectory: host.dataDirectory, node: host.node, python: host.python }));
    const size = screen.getPrimaryDisplay().workAreaSize;
    window = new BrowserWindow({ width: Math.min(1400, size.width), height: Math.min(940, size.height), minWidth: 900, minHeight: 640, title: 'QSA-RAG', icon: join(root, 'desktop', 'icon.png'), show: false, backgroundColor: '#f7f8f6', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
    window.on('close', event => { if (!allowExit) { event.preventDefault(); void quit(); } });
    window.webContents.on('page-title-updated', event => event.preventDefault());
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== host.url) event.preventDefault(); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    updates = new DesktopUpdates(updaterPackage.autoUpdater, { packaged: app.isPackaged, version: app.getVersion() });
    updates.on('install', () => { allowExit = true; });
    updates.on('change', async state => {
      buildMenu();
      if (state !== 'downloading') window?.setProgressBar(-1);
      if (state === 'downloaded') {
        interactiveUpdate = false;
        const choice = await message({ message: `新版本 ${updates.info.version} 已下载`, detail: '完成当前任务后可安装并重新打开应用。', buttons: ['稍后安装', '现在安装'], defaultId: 0, cancelId: 0 });
        if (choice.response === 1) await installUpdate();
      } else if (interactiveUpdate && ['current', 'error'].includes(state)) {
        interactiveUpdate = false;
        await message({ type: state === 'error' ? 'warning' : 'info', message: state === 'error' ? '暂时无法检查更新，请稍后重试。' : '当前已经是最新版本。' });
      }
    });
    updates.on('progress', percent => window?.setProgressBar(percent / 100));
    buildMenu();
    window.once('ready-to-show', () => window.show());
    await window.loadURL(host.url);
    if (!process.env.QSA_DESKTOP_TEST_HOME) setTimeout(() => { if (!quitting && !allowExit) void updates.check(); }, 15000).unref();
  }).catch(async error => {
    log(`startup failed: ${error.message}`);
    if (host?.startupStderr) log(`backend startup diagnostics: ${host.startupStderr}`);
    await message({ type: 'error', message: 'QSA-RAG 未能启动', detail: error.message });
    try { if (host && !host.exited) await host.stop(); } catch {}
    allowExit = true; app.quit();
  });
}
