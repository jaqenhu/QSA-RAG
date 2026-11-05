import { EventEmitter } from 'node:events';

export class DesktopUpdates extends EventEmitter {
  constructor(updater, { packaged, version }) {
    super(); this.updater = updater; this.packaged = packaged; this.state = 'idle'; this.version = version;
    updater.autoDownload = true;
    // Installation always goes through the backend's atomic stop-if-idle gate.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = version.includes('-');
    updater.channel = version.includes('-') ? 'beta' : 'latest';
    updater.allowDowngrade = false;
    const states = { 'checking-for-update': 'checking', 'update-available': 'downloading', 'update-not-available': 'current', 'update-downloaded': 'downloaded', error: 'error' };
    for (const [event, state] of Object.entries(states)) updater.on(event, info => { this.state = state; this.info = event === 'error' ? undefined : info; this.emit('change', state); });
    updater.on('download-progress', progress => { this.progress = progress.percent; this.emit('progress', progress.percent); });
  }
  async check() {
    if (!this.packaged) return 'development';
    if (['checking', 'downloading', 'downloaded'].includes(this.state)) return this.state;
    try { await this.updater.checkForUpdates(); }
    catch { this.state = 'error'; this.emit('change', 'error'); }
    return this.state;
  }
  async install(host) {
    if (this.state !== 'downloaded') return false;
    if (!await host.stop(true)) return false;
    this.emit('install');
    this.updater.quitAndInstall(true, true);
    return true;
  }
}
