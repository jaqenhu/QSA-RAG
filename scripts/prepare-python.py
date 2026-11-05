"""Build-only tool: stage a hash-pinned, isolated Python runtime for Windows x64."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / '.build'
TARGET = BUILD / 'python-win-x64'
CACHE = ROOT / '.build-cache' / 'python'
LOCK = ROOT / 'desktop' / 'runtime-lock.json'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(256 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def download(item):
    if not item['url'].startswith(('https://www.python.org/', 'https://files.pythonhosted.org/')):
        raise RuntimeError('Runtime downloads must use official HTTPS sources')
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (item['sha256'] + '.zip')
    if path.exists() and digest(path) == item['sha256']:
        return path
    temporary = path.with_suffix('.part')
    with urllib.request.urlopen(item['url'], timeout=60) as response, temporary.open('wb') as output:
        shutil.copyfileobj(response, output)
    if digest(temporary) != item['sha256']:
        raise RuntimeError('Downloaded runtime hash mismatch')
    temporary.replace(path)
    return path


def extract(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            path = (destination / item.filename).resolve()
            if not path.is_relative_to(destination.resolve()):
                raise RuntimeError('Unsafe archive entry')
        z.extractall(destination)


def remove_staging(path):
    resolved = path.resolve()
    if resolved.parent != BUILD.resolve() or not resolved.name.startswith('python-'):
        raise RuntimeError('Refusing cleanup outside the runtime build directory')
    shutil.rmtree(resolved)


def verify(path):
    if os.name == 'nt':
        result = subprocess.run([str(path / 'python.exe'), '-X', 'utf8', '-c',
                                 'import sys,openpyxl,defusedxml,et_xmlfile,ctypes,ssl; print(sys.version.split()[0],openpyxl.__version__)'],
                                check=True, capture_output=True, text=True)
        print('Embedded runtime verified:', result.stdout.strip())


def main():
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    fingerprint = hashlib.sha256(LOCK.read_bytes()).hexdigest()
    marker = TARGET / 'qsa-runtime.json'
    if marker.exists() and json.loads(marker.read_text(encoding='utf-8')).get('lockSha256') == fingerprint:
        verify(TARGET)
        return
    BUILD.mkdir(exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='python-staging-', dir=BUILD))
    try:
        extract(download(lock['python']), staging)
        for wheel in lock['wheels']:
            extract(download(wheel), staging / 'Lib' / 'site-packages')
        pth = next(staging.glob('python*._pth'))
        standard_library = next(staging.glob('python3*.zip')).name
        pth.write_text(standard_library + '\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
        (staging / 'qsa-runtime.json').write_text(json.dumps({'lockSha256': fingerprint, **lock}, indent=2), encoding='utf-8')
        verify(staging)
        # Only generated runtime files under .build may be replaced.
        if TARGET.exists():
            remove_staging(TARGET)
        staging.replace(TARGET)
    finally:
        if staging.exists():
            remove_staging(staging)


if __name__ == '__main__':
    main()
