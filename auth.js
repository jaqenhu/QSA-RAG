(() => {
  const nativeFetch = window.fetch.bind(window);
  const page = document.getElementById('auth-page');
  const form = document.getElementById('auth-form');
  const username = document.getElementById('auth-username');
  const password = document.getElementById('auth-password');
  const confirm = document.getElementById('auth-confirm');
  const submit = document.getElementById('auth-submit');
  const error = document.getElementById('auth-error');
  const retry = document.getElementById('auth-retry');
  let setup = false, loaded = false, busy = false, redirecting = false;
  function message(value) { error.textContent = value; error.hidden = !value; }
  function clearPasswords() { password.value = ''; confirm.value = ''; }
  async function api(path, body) {
    const response = await nativeFetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
    return data;
  }
  // Business scripts are loaded only after a server-verified session exists.
  async function enter(user) {
    document.getElementById('signed-in-user').textContent = `${user.displayName} · ${user.username}`;
    if (!loaded) {
      for (const name of ['app', 'knowledge', 'models', 'training', 'settings', 'records', 'assessment']) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = `./${name}.js`;
          script.onload = resolve;
          script.onerror = () => reject(new Error('工作台加载失败，请刷新页面。'));
          document.head.append(script);
        });
      }
      loaded = true;
    }
    clearPasswords(); page.hidden = true; document.body.classList.remove('auth-locked');
  }
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
    if (response.status === 401 && url.origin === location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && !redirecting) {
      redirecting = true; location.reload();
    }
    return response;
  };
  async function initialise() {
    try {
      if (location.protocol === 'file:') throw new Error('请启动本地服务，再打开 http://127.0.0.1:4173。');
      const state = await api('/api/auth/status');
      if (state.user) { await enter(state.user); return; }
      setup = state.setupRequired;
      document.getElementById('auth-title').textContent = setup ? '设置管理员密码' : '账号登录';
      document.getElementById('auth-intro').textContent = setup ? '首次使用，请为管理员账号设置密码。' : '使用管理员账号登录。';
      username.value = state.username; username.readOnly = setup;
      password.autocomplete = setup ? 'new-password' : 'current-password';
      password.minLength = setup ? 12 : 1;
      document.getElementById('auth-password-label').textContent = setup ? '设置密码' : '密码';
      document.getElementById('auth-password-hint').hidden = !setup;
      document.getElementById('auth-confirm-field').hidden = !setup; confirm.required = setup;
      submit.textContent = setup ? '设置密码并进入' : '登录';
      form.hidden = false;
      if (setup && !state.setupAllowed) { submit.disabled = true; message('请在部署电脑本机完成首次密码设置。'); }
      password.focus();
    } catch (reason) {
      document.getElementById('auth-intro').textContent = reason.message || '无法连接本地服务，请确认服务已启动。';
      form.hidden = true; retry.hidden = false;
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (setup && password.value !== confirm.value) { message('两次输入的密码不一致。'); confirm.focus(); return; }
    busy = true; submit.disabled = true; message('');
    const label = submit.textContent; submit.textContent = setup ? '正在设置…' : '正在登录…';
    try {
      const data = await api(setup ? '/api/auth/setup' : '/api/auth/login', { username: username.value, password: password.value, ...(setup ? { confirmPassword: confirm.value } : {}) });
      clearPasswords(); await enter(data.user);
    } catch (reason) { clearPasswords(); message(reason.message || '操作失败，请重试。'); password.focus(); }
    finally { busy = false; submit.disabled = false; submit.textContent = label; }
  });
  document.getElementById('auth-logout').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await api('/api/auth/logout', {}); location.reload(); }
    catch { button.disabled = false; if (typeof showToast === 'function') showToast('退出失败，请检查连接后重试。'); }
  });
  retry.addEventListener('click', () => location.reload());
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  initialise();
})();
