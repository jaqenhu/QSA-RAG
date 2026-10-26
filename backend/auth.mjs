import { randomBytes, randomUUID, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './store.mjs';

const scrypt = promisify(derive);
const cookieName = 'qsa_session';
const sessionAge = 8 * 60 * 60 * 1000;
const windowAge = 15 * 60 * 1000;
const work = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const digest = value => createHash('sha256').update(value).digest('hex');
const publicUser = row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role });
export const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

function validatePassword(value) {
  if (typeof value !== 'string' || [...value].length < 12 || [...value].length > 128 || !value.trim()) {
    throw new ApiError(400, '密码应为 12–128 个字符，可使用较长的易记短语。');
  }
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, work);
  return `scrypt$32768$8$3$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const parts = stored?.split('$');
  const valid = parts?.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$3' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
  // Unknown users and pending accounts take the same expensive path.
  const actual = await scrypt(password, valid ? parts[4] : '0'.repeat(32), 64, work);
  return timingSafeEqual(actual, Buffer.from(valid ? parts[5] : '0'.repeat(128), 'hex')) && valid;
}

export function createAuth(store, { now = Date.now } = {}) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role='admin'),state TEXT NOT NULL CHECK(state IN ('setup_pending','active','disabled')),
    password_hash TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_audit (
      id INTEGER PRIMARY KEY,event TEXT NOT NULL,user_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_login_limits (
      address TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
  store.transaction(() => {
    if (!db.prepare('SELECT id FROM auth_users LIMIT 1').get()) {
      db.prepare("INSERT INTO auth_users VALUES (?, 'admin', '系统管理员', 'admin', 'setup_pending', NULL, ?, ?)").run(randomUUID(), now(), now());
    }
  });
  const pending = () => db.prepare("SELECT * FROM auth_users WHERE username='admin' AND state='setup_pending'").get();
  const audit = (event, userId = null) => db.prepare('INSERT INTO auth_audit (event,user_id,created_at) VALUES (?,?,?)').run(event, userId, now());
  function token(request) {
    const values = (request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return null;
    const value = values[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  function session(request) {
    const value = token(request);
    if (!value) return null;
    return db.prepare("SELECT u.* FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.state='active'").get(digest(value), now()) || null;
  }
  function issue(request, response, user) {
    const value = randomBytes(32).toString('base64url');
    store.transaction(() => {
      db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now());
      const previous = token(request);
      if (previous) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest(previous));
      db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run(digest(value), user.id, now(), now() + sessionAge);
    });
    response.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionAge / 1000}${request.socket.encrypted ? '; Secure' : ''}`);
    return publicUser(user);
  }
  let authenticating = 0;
  async function limited(request, operation) {
    const address = request.socket.remoteAddress || 'unknown';
    db.prepare('DELETE FROM auth_login_limits WHERE expires_at<=?').run(now());
    const limit = db.prepare('SELECT * FROM auth_login_limits WHERE address=?').get(address);
    if (limit?.attempts >= 10) throw new ApiError(429, '尝试次数过多，请在 15 分钟后重试。');
    if (authenticating >= 2) throw new ApiError(429, '正在验证登录，请稍后重试。');
    db.prepare(`INSERT INTO auth_login_limits VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET attempts=attempts+1`).run(address, now() + windowAge);
    authenticating++;
    try { return await operation(); }
    finally { authenticating--; }
  }
  return {
    status(request) { const user = session(request); return { setupRequired: Boolean(pending()), setupAllowed: isLoopback(request.socket.remoteAddress), username: 'admin', user: user ? publicUser(user) : null }; },
    requireAdmin(request) {
      const user = session(request);
      if (!user) throw new ApiError(401, '请先登录。');
      if (user.role !== 'admin') throw new ApiError(403, '需要管理员权限。');
      return publicUser(user);
    },
    async setup(request, response, data) {
      if (!isLoopback(request.socket.remoteAddress)) throw new ApiError(403, '请在部署电脑本机设置初始密码。');
      if (!pending()) throw new ApiError(409, '管理员已设置密码，请直接登录。');
      validatePassword(data.password);
      if (data.password !== data.confirmPassword) throw new ApiError(400, '两次输入的密码不一致。');
      return limited(request, async () => {
        const passwordHash = await hashPassword(data.password);
        const user = store.transaction(() => {
          const row = pending();
          if (!row) throw new ApiError(409, '管理员已设置密码，请直接登录。');
          db.prepare("UPDATE auth_users SET state='active',password_hash=?,updated_at=? WHERE id=? AND state='setup_pending'").run(passwordHash, now(), row.id);
          audit('admin_activated', row.id);
          db.prepare('DELETE FROM auth_login_limits WHERE address=?').run(request.socket.remoteAddress || 'unknown');
          return row;
        });
        return { user: issue(request, response, user) };
      });
    },
    async login(request, response, data) {
      if (typeof data.username !== 'string' || typeof data.password !== 'string' || data.username.length > 64 || data.password.length > 512) throw new ApiError(400, '请输入有效的账号和密码。');
      return limited(request, async () => {
        const row = db.prepare('SELECT * FROM auth_users WHERE username=?').get(data.username.trim());
        const valid = await verifyPassword(data.password, row?.password_hash);
        if (!valid || row?.state !== 'active') { audit('login_failed'); throw new ApiError(401, '账号或密码不正确。'); }
        audit('login_succeeded', row.id);
        db.prepare('DELETE FROM auth_login_limits WHERE address=?').run(request.socket.remoteAddress || 'unknown');
        return { user: issue(request, response, row) };
      });
    },
    logout(request, response) {
      const user = session(request), value = token(request);
      if (value) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest(value));
      if (user) audit('logged_out', user.id);
      response.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${request.socket.encrypted ? '; Secure' : ''}`);
      return { loggedOut: true };
    },
  };
}
