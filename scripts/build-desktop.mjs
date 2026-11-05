import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createReadStream, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const signed = process.argv.includes('--signed');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (!signed && !pkg.version.includes('-')) throw new Error('无签名构建只能使用测试版版本号。');
const env = { ...process.env, ELECTRON_CACHE: resolve(root, '.build-cache/electron'), ELECTRON_BUILDER_CACHE: resolve(root, '.build-cache/builder'), QSA_SIGNED_BUILD: signed ? '1' : '0' };
if (!signed) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.env.QSA_BUILD_PYTHON || 'python', ['scripts/prepare-electron.py']);
run(process.env.QSA_BUILD_PYTHON || 'python', ['scripts/prepare-python.py']);
run(process.execPath, ['scripts/create-desktop-icon.mjs']);
for (const name of ['latest.yml', 'beta.yml', 'alpha.yml', 'SHA256SUMS.txt']) {
  const path = resolve(root, 'release', name);
  if (existsSync(path)) unlinkSync(path);
}
run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--config', 'electron-builder.cjs', '--win', '--x64', ...(process.argv.includes('--dir') ? ['--dir'] : []), '--publish', 'never']);
run(process.execPath, ['scripts/verify-desktop-package.mjs']);
if (!process.argv.includes('--dir')) {
  const lines = [];
  for (const name of readdirSync(resolve(root, 'release')).filter(name => (name.startsWith(`QSA-RAG-${pkg.version}-`) && (name.endsWith('.exe') || name.endsWith('.blockmap'))) || /^(beta|latest)\.yml$/.test(name)).sort()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(resolve(root, 'release', name))) hash.update(chunk);
    lines.push(`${hash.digest('hex')} *${name}`);
  }
  writeFileSync(resolve(root, 'release/SHA256SUMS.txt'), lines.join('\n') + '\n');
}
