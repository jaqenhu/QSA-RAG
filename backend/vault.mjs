import { spawn } from 'node:child_process';
import { pythonScript } from './python-path.mjs';
import { ApiError } from './store.mjs';

export function createVault(python = 'python') {
  async function transform(mode, value) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-X', 'utf8', pythonScript('protect_secret.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let result = '', settled = false;
      const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
      const fail = () => finish(new ApiError(503, '本机密钥保护不可用。请使用当前 Windows 用户运行服务，或重新填写密钥。'));
      const timer = setTimeout(() => { child.kill(); fail(); }, 10000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { result += chunk; if (result.length > 40000) { child.kill(); fail(); } });
      child.on('error', fail); child.stdin.on('error', fail);
      child.on('close', () => { try { const data = JSON.parse(result); if (!data.ok || typeof data.value !== 'string') return fail(); finish(null, data.value); } catch { fail(); } });
      child.stdin.end(JSON.stringify({ mode, value }));
    });
  }
  return {
    encrypt: async value => `dpapi:${await transform('encrypt', value)}`,
    decrypt: value => { if (!value?.startsWith('dpapi:')) throw new ApiError(503, '密钥保存格式无效，请重新填写。'); return transform('decrypt', value.slice(6)); },
  };
}
