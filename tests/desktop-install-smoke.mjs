import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { databaseFingerprint } from '../backend/data-directory.mjs';

assert.equal(process.platform, 'win32');
// Never replace an existing user installation or shortcut during acceptance tests.
const preflight = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  String.raw`$apps = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object DisplayName -eq "QSA-RAG"; $desktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "QSA-RAG.lnk"; $menuLink = Join-Path ([Environment]::GetFolderPath("Programs")) "QSA-RAG.lnk"; if ($apps -or (Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $menuLink)) { exit 2 }`], { windowsHide: true });
assert.equal(preflight.status, 0, '已有 QSA-RAG 安装或快捷方式，跳过安装验收以保留现状');
const parent = resolve(tmpdir());
const folder = mkdtempSync(join(parent, 'desktop-install-'));
const installDirectory = join(folder, '安装 中文');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const installer = resolve(`release/QSA-RAG-${version}-win-x64-setup.exe`);
assert.ok(existsSync(installer));
console.log('正在安装到隔离验收目录。');
const installed = spawnSync(installer, ['/S', `/D=${installDirectory}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 180000 });
assert.equal(installed.status, 0, installed.error?.message);
assert.ok(existsSync(join(installDirectory, 'QSA-RAG.exe')));
let verified = false, data, before;
try {
  const smoke = spawnSync(process.execPath, ['tests/desktop-smoke.mjs'], { env: { ...process.env, QSA_DESKTOP_EXE: join(installDirectory, 'QSA-RAG.exe') }, stdio: 'inherit', windowsHide: true, timeout: 180000 });
  assert.equal(smoke.status, 0);
  const report = JSON.parse(readFileSync('outputs/desktop-smoke.json', 'utf8'));
  data = report.isolatedDataDirectory;
  const db = new DatabaseSync(join(data, 'qsa.sqlite'), { readOnly: true });
  try { before = databaseFingerprint(db); } finally { db.close(); }
  verified = true;
} finally {
  assert.ok(resolve(installDirectory).startsWith(parent + '\\'), '只卸载本次隔离安装');
  const uninstallers = readdirSync(installDirectory).filter(name => /^Uninstall.*\.exe$/i.test(name));
  assert.equal(uninstallers.length, 1);
  console.log('正在卸载验收实例并核对业务数据保留。');
  const result = spawnSync(join(installDirectory, uninstallers[0]), ['/S', `_?=${installDirectory}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 120000 });
  assert.equal(result.status, 0, result.error?.message);
}
assert.equal(verified, true);
assert.ok(existsSync(join(data, 'qsa.sqlite')));
const db = new DatabaseSync(join(data, 'qsa.sqlite'), { readOnly: true });
try { assert.deepEqual(databaseFingerprint(db), before); } finally { db.close(); }
const report = { version, installer, installedToChinesePath: true, fullDesktopFlowVerified: true, gracefulExit: true, uninstallPreservedAllBusinessData: true, isolatedInstallationRemoved: !existsSync(join(installDirectory, 'QSA-RAG.exe')) };
writeFileSync('outputs/desktop-install-smoke.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
