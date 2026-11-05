"""Download Electron from its official release and verify the npm-pinned hash."""
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / 'node_modules' / 'electron'


def main():
    version = json.loads((PACKAGE / 'package.json').read_text(encoding='utf-8'))['version']
    target = PACKAGE / 'dist'
    if (target / 'version').exists() and (target / 'version').read_text().strip().lstrip('v') == version and (target / 'electron.exe').exists():
        (PACKAGE / 'path.txt').write_text('electron.exe', encoding='utf-8')
        return
    name = f'electron-v{version}-win32-x64.zip'
    expected = json.loads((PACKAGE / 'checksums.json').read_text(encoding='utf-8'))[name]
    cache = ROOT / '.build-cache' / 'electron-archives'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / name
    def digest(path):
        h = hashlib.sha256()
        with path.open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    if not archive.exists() or digest(archive) != expected:
        temporary = archive.with_suffix('.part')
        request = urllib.request.Request(f'https://github.com/electron/electron/releases/download/v{version}/{name}', headers={'User-Agent': 'QSA-desktop-build'})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        if digest(temporary) != expected:
            raise RuntimeError('Electron archive hash mismatch')
        temporary.replace(archive)
    if target.exists():
        if target.resolve().parent != PACKAGE.resolve():
            raise RuntimeError('Refusing to replace an external Electron directory')
        shutil.rmtree(target)
    target.mkdir()
    with zipfile.ZipFile(archive) as z:
        if any(not (target / item.filename).resolve().is_relative_to(target.resolve()) for item in z.infolist()):
            raise RuntimeError('Unsafe Electron archive entry')
        z.extractall(target)
    (PACKAGE / 'path.txt').write_text('electron.exe', encoding='utf-8')
    print('Electron runtime verified:', version)


if __name__ == '__main__':
    main()
