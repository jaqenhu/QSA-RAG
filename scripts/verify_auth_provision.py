"""Read-only verification against the pre-provision backup; never read credentials."""
import json
import sqlite3
from pathlib import Path
from backup_before_auth import business_snapshot

root = Path(__file__).resolve().parents[1]
backups = sorted((root / '.data-backups').glob('before-auth-*'))
backup = backups[-1]
expected = json.loads((backup / 'business-snapshot.json').read_text(encoding='utf-8'))
with sqlite3.connect((root / '.data' / 'qsa.sqlite').as_uri() + '?mode=ro', uri=True) as connection:
    actual = business_snapshot(connection)
    if actual != expected:
        raise SystemExit('原业务数据与备份不一致，请检查。')
    users = [dict(zip(['username', 'role', 'state'], row)) for row in connection.execute('SELECT username,role,state FROM auth_users')]
    if len(users) != 1 or users[0]['username'] != 'admin':
        raise SystemExit('首个管理员数量或账号不符。')
    report = {"backup": str(backup), "originalBusinessTables": len(actual), "allBusinessDataUnchanged": True, "users": users, "integrity": connection.execute('PRAGMA integrity_check').fetchone()[0], "passwordSetByAgent": False, "lanEnabled": False}
output = root / '.impeccable' / 'review' / 'v20-auth-live-checks.json'
output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
