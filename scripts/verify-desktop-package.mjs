import { createRequire } from 'node:module';
import { normalize, posix, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const archive = resolve(process.argv[2] || 'release/win-unpacked/resources/app.asar');
const paths = new Set(asar.listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\//, '')));
const visited = new Set(), missing = [];
function locate(name, from) {
  let directory = from;
  while (true) {
    const candidate = posix.join(directory, 'node_modules', name, 'package.json');
    if (paths.has(candidate)) return candidate;
    if (!directory || directory === '.') return null;
    directory = posix.dirname(directory);
  }
}
function visit(manifest) {
  if (visited.has(manifest)) return;
  visited.add(manifest);
  const pkg = JSON.parse(asar.extractFile(archive, normalize(manifest)).toString());
  const mandatory = { ...pkg.dependencies, ...pkg.peerDependencies };
  for (const name of Object.keys(mandatory)) {
    if (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional) continue;
    const found = locate(name, manifest === 'package.json' ? '' : posix.dirname(manifest));
    if (!found) missing.push(`${pkg.name}: ${name}`); else visit(found);
  }
}
visit('package.json');
const privateFiles = [...paths].filter(path => /^(\.data|\.data-backups|\.test-data|\.env|outputs|\.git|tests|\.venv)(\/|$)/.test(path) || /qsa\.sqlite|\.xlsx$/.test(path));
if (missing.length || privateFiles.length) throw new Error(`安装包校验失败：${JSON.stringify({ missing, privateFiles })}`);
console.log(JSON.stringify({ archive, runtimePackagesVerified: visited.size, missingDependencies: 0, privateFiles: 0 }));
