import { randomBytes } from 'node:crypto';

// Fixture-only client: exercises the real setup/login endpoints; no production bypass.
const password = randomBytes(24).toString('base64url');
const sessions = new Map();
async function credentials(base) {
  if (!sessions.has(base)) sessions.set(base, (async () => {
    const state = await (await globalThis.fetch(base + '/api/auth/status')).json();
    const response = await globalThis.fetch(base + (state.setupRequired ? '/api/auth/setup' : '/api/auth/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password, confirmPassword: password }),
    });
    if (!response.ok) throw new Error(`Fixture login failed: ${response.status}`);
    return response.headers.get('set-cookie').split(';')[0];
  })());
  return sessions.get(base);
}
export async function authenticatedFetch(input, options = {}) {
  const url = new URL(input);
  if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/v1/')) return globalThis.fetch(input, options);
  const headers = new Headers(options.headers);
  headers.set('Cookie', await credentials(url.origin));
  return globalThis.fetch(input, { ...options, headers });
}
export async function authorizeBrowser(page, base) {
  const cookie = await credentials(base);
  const separator = cookie.indexOf('=');
  await page.context().addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base, httpOnly: true, sameSite: 'Strict' }]);
  for (const method of ['goto', 'reload']) {
    const navigate = page[method].bind(page);
    page[method] = async (...args) => {
      const result = await navigate(...args);
      await page.locator('#auth-page').waitFor({ state: 'hidden' });
      return result;
    };
  }
}
