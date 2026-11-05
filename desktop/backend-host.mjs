import { EventEmitter } from 'node:events';

export class BackendHost extends EventEmitter {
  constructor(child, { exitTimeout = 5000 } = {}) {
    super(); this.child = child; this.pending = new Map(); this.sequence = 0; this.stopping = false; this.exited = false;
    this.startupStderr = ''; this.failureReported = false;
    this.exitTimeout = exitTimeout;
    child.stderr?.on('data', chunk => { if (!this.url) this.startupStderr = (this.startupStderr + chunk.toString('utf8')).slice(-12000); });
    this.exit = new Promise(resolve => child.once('exit', code => {
      this.exited = true;
      for (const { action, resolve, reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        // Windows can deliver process exit before the last queued IPC reply.
        if (this.stopping && code === 0 && action.startsWith('stop')) resolve({ stopped: true });
        else reject(new Error('本机服务已关闭。'));
      }
      this.pending.clear();
      if (!this.stopping && !this.failureReported) this.fail(new Error(`本机服务意外退出（${code}），请重新打开应用。`));
      resolve(code);
    }));
    child.on('message', message => {
      if (message.type === 'ready') { Object.assign(this, message); this.emit('ready', message); }
      else if (message.type === 'startup-error') this.fail(new Error(message.message));
      else {
        const item = this.pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timer); this.pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error)); else item.resolve(message.value);
      }
    });
  }
  fail(error) {
    if (this.failureReported) return;
    this.failureReported = true;
    this.emit('failure', error);
  }
  request(action, timeout = 10000) {
    if (this.exited) return Promise.reject(new Error('本机服务已关闭。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本机服务响应超时，请稍后重试。')); }, timeout);
      this.pending.set(id, { action, resolve, reject, timer });
      try { this.child.postMessage({ id, action }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async stop(onlyIfIdle = false) {
    if (this.exited) return true;
    this.stopping = true;
    try {
      const result = await this.request(onlyIfIdle ? 'stop-if-idle' : 'stop', 120000);
      if (!result.stopped) { this.stopping = false; return false; }
      let timer;
      const exited = await Promise.race([this.exit.then(() => true), new Promise(done => { timer = setTimeout(() => done(false), this.exitTimeout); })]);
      clearTimeout(timer);
      if (!exited) {
        // A stopped:true reply guarantees handlers/jobs finished and SQLite
        // closed. Only then is it safe to end a lingering utility process.
        this.child.kill();
        try {
          await Promise.race([this.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('后台已保存数据，但进程尚未退出，请重试关闭。')), this.exitTimeout); })]);
        } finally { clearTimeout(timer); }
      }
      return true;
    } catch (error) { this.stopping = false; throw error; }
  }
}
