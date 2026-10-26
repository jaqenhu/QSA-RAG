"""Preserve the current local data before provisioning authentication; print no records."""
import datetime
import hashlib
import json
import shutil
import sqlite3
from pathlib import Path


def business_snapshot(connection):
    result = {}
    tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'auth_%' AND name NOT IN ('schema_migrations','service_lease') ORDER BY name").fetchall()
    for (table,) in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        values = []
        for row in connection.execute(f'SELECT * FROM {quoted}'):
            encoded = json.dumps(row, ensure_ascii=False, default=lambda value: value.hex() if isinstance(value, bytes) else str(value), separators=(',', ':')).encode('utf-8')
            values.append(hashlib.sha256(encoded).hexdigest())
        result[table] = {"rows": len(values), "sha256": hashlib.sha256(''.join(sorted(values)).encode()).hexdigest()}
    return result


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    source = root / '.data'
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = root / '.data-backups' / ('before-auth-' + stamp)
    with sqlite3.connect((source / 'qsa.sqlite').as_uri() + '?mode=ro', uri=True) as connection:
        for table in ['assessment_tasks', 'training_jobs']:
            if connection.execute(f"SELECT COUNT(*) FROM {table} WHERE status='running'").fetchone()[0]:
                raise SystemExit('发现运行中任务，请先等待完成再部署账号。')
        shutil.copytree(source, destination, ignore=shutil.ignore_patterns('qsa.sqlite', 'qsa.sqlite-wal', 'qsa.sqlite-shm'))
        with sqlite3.connect(destination / 'qsa.sqlite') as backup:
            connection.backup(backup)
            if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise SystemExit('备份校验失败。')
            snapshot = business_snapshot(backup)
        (destination / 'business-snapshot.json').write_text(json.dumps(snapshot, indent=2), encoding='utf-8')
    print(json.dumps({"backup": str(destination), "tables": len(snapshot), "verified": True}, ensure_ascii=False))
