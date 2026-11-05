import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopUpdates } from '../desktop/updates.mjs';
import { BackendHost } from '../desktop/backend-host.mjs';

function updater() {
  return Object.assign(new EventEmitter(), { installs: 0, checks: 0, quitAndInstall(...options) { this.installs++; this.installOptions = options; }, async checkForUpdates() { this.checks++; this.emit('update-not-available'); } });
}

test('下载完成后任务忙碌时拒绝安装，空闲后先安全停止后台再安装', async () => {
  const adapter = updater(), controller = new DesktopUpdates(adapter, { packaged: true, version: '0.7.0-beta.1' });
  const calls = [];
  const host = { async stop(onlyIfIdle) { calls.push(onlyIfIdle); return calls.length > 1; } };
  assert.equal(adapter.autoInstallOnAppQuit, false);
  assert.equal(adapter.channel, 'beta'); assert.equal(adapter.allowPrerelease, true);
  assert.equal(adapter.allowDowngrade, false);
  assert.equal(await controller.install(host), false);
  adapter.emit('update-downloaded', { version: '0.7.0-beta.2' });
  assert.equal(await controller.install(host), false);
  assert.equal(adapter.installs, 0);
  assert.equal(await controller.install(host), true);
  assert.deepEqual(calls, [true, true]); assert.equal(adapter.installs, 1);
  assert.deepEqual(adapter.installOptions, [true, true]);
});

test('后台关闭失败不安装；开发模式不查询，正式版只查询稳定通道', async () => {
  const adapter = updater(), controller = new DesktopUpdates(adapter, { packaged: true, version: '0.7.0' });
  assert.equal(adapter.channel, 'latest'); assert.equal(adapter.allowPrerelease, false);
  adapter.emit('update-downloaded', { version: '0.7.1' });
  await assert.rejects(controller.install({ stop: async () => { throw new Error('cannot stop'); } }), /cannot stop/);
  assert.equal(adapter.installs, 0);
  const development = new DesktopUpdates(updater(), { packaged: false, version: '0.7.0-beta.1' });
  assert.equal(await development.check(), 'development'); assert.equal(development.updater.checks, 0);
});

test('更新请求失败可重试，已有下载时不并行检查', async () => {
  const adapter = updater(), controller = new DesktopUpdates(adapter, { packaged: true, version: '0.7.0-beta.1' });
  adapter.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal(await controller.check(), 'error');
  adapter.checkForUpdates = async () => { adapter.emit('update-not-available'); };
  assert.equal(await controller.check(), 'current');
  adapter.emit('update-available', { version: '0.7.0-beta.2' });
  assert.equal(await controller.check(), 'downloading');
});

test('后台拒绝空闲退出后仍可通信，安全退出清理请求且不误报崩溃', async () => {
  const child = new EventEmitter(), host = new BackendHost(child); let busy = true, failures = 0;
  host.on('failure', () => failures++);
  child.postMessage = ({ id, action }) => setImmediate(() => {
    const stopping = action.startsWith('stop');
    child.emit('message', { id, value: stopping ? { stopped: !busy } : { busy } });
    if (stopping && !busy) setImmediate(() => child.emit('exit', 0));
  });
  assert.equal(await host.stop(true), false);
  assert.equal((await host.request('status')).busy, true);
  busy = false;
  assert.equal(await host.stop(true), true);
  assert.equal(host.pending.size, 0); assert.equal(failures, 0);
});

test('启动失败保留具体错误，退出码不覆盖原因，并记录启动 stderr', async () => {
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const host = new BackendHost(child), failures = [];
  host.on('failure', error => failures.push(error.message));
  child.stderr.emit('data', Buffer.from('ERR_MODULE_NOT_FOUND: missing dependency'));
  child.emit('message', { type: 'startup-error', message: '具体启动错误' });
  child.emit('exit', 1); await host.exit;
  assert.deepEqual(failures, ['具体启动错误']);
  assert.match(host.startupStderr, /ERR_MODULE_NOT_FOUND/);
});

test('安全退出事件早于最后一条 IPC 回包时仍能正常完成关闭', async () => {
  const child = new EventEmitter(), host = new BackendHost(child);
  child.postMessage = () => setImmediate(() => child.emit('exit', 0));
  assert.equal(await host.stop(), true);
  assert.equal(host.pending.size, 0);
});

test('后台确认数据已保存但进程未结束时清理进程，未确认时不强制结束', async () => {
  const child = new EventEmitter(), host = new BackendHost(child, { exitTimeout: 10 }); let killed = false;
  child.postMessage = ({ id }) => setImmediate(() => child.emit('message', { id, value: { stopped: true } }));
  child.kill = () => { killed = true; child.emit('exit', 0); };
  assert.equal(await host.stop(), true); assert.equal(killed, true);
  const unsafeChild = new EventEmitter(), unsafeHost = new BackendHost(unsafeChild); let unsafeKill = false;
  unsafeChild.kill = () => { unsafeKill = true; };
  unsafeHost.request = async () => { throw new Error('not acknowledged'); };
  await assert.rejects(unsafeHost.stop(), /not acknowledged/); assert.equal(unsafeKill, false);
  unsafeHost.stopping = true; unsafeChild.emit('exit', 0);
});
