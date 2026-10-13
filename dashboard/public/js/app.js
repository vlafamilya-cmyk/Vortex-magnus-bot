let csrfToken = '';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
async function api(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  opts.headers = { ...(opts.headers || {}) };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.headers['X-CSRF-Token'] = csrfToken; }
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/login'; throw Error('Authentication required'); }
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}
function notice(msg, err = false) {
  const n = $('#notice'); n.textContent = msg; n.hidden = false;
  n.className = 'notice ' + (err ? 'danger' : 'success');
  setTimeout(() => n.hidden = true, 4500);
}
function fmt(t) { return t ? new Date(t).toLocaleString() : '—'; }
function duration(ms) {
  let s = Math.max(0, Math.floor((ms || 0) / 1000)), h = Math.floor(s / 3600);
  s %= 3600; const m = Math.floor(s / 60); s %= 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
function ensureAppStateRefreshPanel() {
  const section = $('#appstate');
  if (!section || $('#appstate-refresh-panel')) return;
  const heading = section.querySelector('.section-heading');
  const panel = document.createElement('div');
  panel.id = 'appstate-refresh-panel';
  panel.className = 'panel';
  panel.style.marginBottom = '16px';
  panel.innerHTML = `
    <div class="panel-head"><div><p class="eyebrow">SESSION MAINTENANCE</p><h3>Cookie / AppState refresh</h3></div><span id="appstate-refresh-running" class="muted">Scheduled every 3 hours</span></div>
    <div class="stats-grid">
      <article class="stat-card"><span>Successful refreshes</span><strong id="appstate-refresh-success">0</strong><small>Saved AppState snapshots</small></article>
      <article class="stat-card"><span>Failed refreshes</span><strong id="appstate-refresh-failures">0</strong><small>Attempts that did not complete</small></article>
    </div>
    <div class="detail-row"><span>Last attempt</span><b id="appstate-refresh-last-attempt">—</b></div>
    <div class="detail-row"><span>Last success</span><b id="appstate-refresh-last-success">—</b></div>
    <div class="detail-row"><span>Last failure</span><b id="appstate-refresh-last-failure">—</b></div>
    <div class="detail-row"><span>Last error</span><b id="appstate-refresh-last-error">None</b></div>
    <div class="detail-row"><span>Next refresh in</span><b id="appstate-refresh-countdown">—</b></div>
    <div class="button-row"><button id="refresh-appstate-now" class="primary">Refresh now ↻</button></div>
    <p class="muted">Only refresh statistics are shown here. Cookie values and AppState are never displayed or logged.</p>`;
  if (heading) heading.after(panel); else section.prepend(panel);
  $('#refresh-appstate-now').addEventListener('click', async () => {
    const button = $('#refresh-appstate-now');
    button.disabled = true; button.textContent = 'Refreshing…';
    try {
      const d = await api('/api/appstate/refresh', { method: 'POST', body: '{}' });
      notice('AppState refresh completed and saved.');
      updateAppStateRefresh(d.state);
      await status();
    } catch (e) {
      notice(e.message, true);
      await status().catch(() => {});
    } finally { button.disabled = false; button.textContent = 'Refresh now ↻'; }
  });
}
let appStateRefreshSnapshot = null;
function updateAppStateRefresh(s) {
  if (!s) return;
  appStateRefreshSnapshot = s;
  ensureAppStateRefreshPanel();
  $('#appstate-refresh-success').textContent = String(s.successCount || 0);
  $('#appstate-refresh-failures').textContent = String(s.failureCount || 0);
  $('#appstate-refresh-last-attempt').textContent = fmt(s.lastAttemptAt);
  $('#appstate-refresh-last-success').textContent = fmt(s.lastSuccessAt);
  $('#appstate-refresh-last-failure').textContent = fmt(s.lastFailureAt);
  $('#appstate-refresh-last-error').textContent = s.lastError || 'None';
  $('#appstate-refresh-running').textContent = s.refreshing ? 'Refresh in progress…' : 'Scheduled every 3 hours';
  updateAppStateCountdown();
}
function updateAppStateCountdown() {
  const target = appStateRefreshSnapshot?.nextRefreshAt;
  const node = $('#appstate-refresh-countdown');
  if (node) node.textContent = target ? duration(Date.parse(target) - Date.now()) : '—';
}
async function status() {
  const s = await api('/api/status');
  $('#bot-status').textContent = s.status;
  $('#bot-detail').textContent = s.appStateConfigured ? 'AppState configured' : 'Waiting for session';
  $('#fca-status').textContent = s.fcaStatus;
  $('#mqtt-status').textContent = 'MQTT: ' + (s.mqttStatus || 'unknown');
  $('#command-count').textContent = s.commands;
  $('#uptime').textContent = duration(s.uptimeMs);
  $('#reconnects').textContent = s.reconnectAttempts;
  $('#top-state').textContent = s.status;
  $('#last-connection').textContent = fmt(s.lastConnection);
  $('#last-disconnect').textContent = fmt(s.lastDisconnect);
  $('#last-error').textContent = s.lastError || 'None';
  $('#connection-status').textContent = s.status;
  $('#connection-retries').textContent = s.reconnectAttempts;
  $('#connection-last').textContent = fmt(s.lastConnection);
  $('#bot-details').innerHTML = [['Name', s.bot], ['Prefix', s.prefix], ['Status', s.status], ['Version', s.version],
    ['Uptime', duration(s.uptimeMs)], ['Loaded commands', s.commands], ['Last error', s.lastError || 'None'],
    ['Last reconnect', fmt(s.lastDisconnect)]].map(([k, v]) => `<div class="detail-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('');
  $('#footer-version').textContent = 'v' + s.version;
  updateAppStateRefresh(s.appStateRefresh);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function commands() {
  const d = await api('/api/commands');
  $('#commands-table').innerHTML = d.commands.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.aliases.join(', '))}</td><td>${esc(c.description)}</td><td>${c.adminOnly ? 'Yes' : 'No'}</td><td>${esc(c.file)}</td><td><button class="mini" data-edit="${esc(c.name)}">Edit</button> <button class="mini danger-text" data-delete="${esc(c.file)}">Delete</button></td></tr>`).join('');
}
async function admins() {
  const d = await api('/api/admins');
  $('#admin-list').innerHTML = d.admins.map(id => `<span class="pill">${esc(id)} <button data-remove-admin="${esc(id)}" aria-label="Remove admin ${esc(id)}">×</button></span>`).join('') || '<p class="muted">No admin IDs configured.</p>';
}
async function settings() {
  const s = await api('/api/settings'); $('#bot-name').value = s.botName; $('#prefix').value = s.prefix; $('#language').value = s.language || 'ar';
}
async function logs() {
  const q = encodeURIComponent($('#log-search').value), t = encodeURIComponent($('#log-type').value);
  const d = await api(`/api/logs?q=${q}&type=${t}`);
  $('#logs-list').innerHTML = d.logs.slice().reverse().map(l => `<div class="log-row"><time>${esc(fmt(l.time))}</time><b class="log-${esc(l.type.toLowerCase())}">${esc(l.type)}</b><span>${esc(l.message)}</span></div>`).join('') || '<p class="muted">No logs captured in this process.</p>';
}
async function refreshAll() {
  try { await Promise.all([status(), commands(), admins(), settings(), logs()]); }
  catch (e) { if (!String(e.message).includes('Authentication')) notice(e.message, true); }
}
async function action(name) {
  try {
    if (name === 'refresh') { await refreshAll(); return notice('Dashboard refreshed.'); }
    const d = await api('/api/connection/' + name, { method: 'POST', body: '{}' });
    notice('Connection status: ' + (d.status || 'updated')); await status();
  } catch (e) { notice(e.message, true); }
}
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-action]'); if (a) action(a.dataset.action);
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    try { $('#command-file').value = edit.dataset.edit + '.js'; $('#command-source').value = (await api('/api/commands/' + encodeURIComponent(edit.dataset.edit) + '/source')).source; $('#editor-wrap').hidden = false; }
    catch (x) { notice(x.message, true); }
  }
  const del = e.target.closest('[data-delete]');
  if (del && confirm('Delete command ' + del.dataset.delete + '?')) {
    try { await api('/api/commands/' + encodeURIComponent(del.dataset.delete), { method: 'DELETE' }); await commands(); notice('Command deleted.'); }
    catch (x) { notice(x.message, true); }
  }
  const rm = e.target.closest('[data-remove-admin]');
  if (rm && confirm('Remove this admin?')) {
    try { await api('/api/admins/' + encodeURIComponent(rm.dataset.removeAdmin), { method: 'DELETE' }); await admins(); notice('Admin removed.'); }
    catch (x) { notice(x.message, true); }
  }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { location.href = '/login'; }
});
$('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$$('#nav a').forEach(a => a.addEventListener('click', () => {
  const id = a.getAttribute('href').slice(1);
  $$('.page').forEach(p => p.classList.toggle('active', p.id === id));
  $$('#nav a').forEach(n => n.classList.toggle('active', n === a));
  $('#page-title').textContent = a.textContent.trim().replace(/^[^a-zA-Z]+/, '');
  $('#sidebar').classList.remove('open');
}));
ensureAppStateRefreshPanel();
$('#validate-appstate').addEventListener('click', async () => {
  try {
    const appState = JSON.parse($('#appstate-input').value);
    await api('/api/appstate/validate', { method: 'POST', body: JSON.stringify({ appState }) });
    $('#appstate-result').textContent = 'Valid AppState format. Content was not logged.';
    notice('AppState format is valid.');
  } catch (e) { $('#appstate-result').textContent = e.message; notice(e.message, true); }
});
$('#save-appstate').addEventListener('click', () => saveAppState(false));
$('#connect-appstate').addEventListener('click', () => saveAppState(true));
async function saveAppState(connect) {
  try {
    const appState = JSON.parse($('#appstate-input').value);
    const d = await api('/api/appstate/' + (connect ? 'connect' : 'save'), { method: 'POST', body: JSON.stringify({ appState }) });
    $('#appstate-input').value = '';
    $('#appstate-result').textContent = connect ? 'Connection attempt completed.' : 'AppState saved securely.';
    notice(connect ? 'Connection attempt completed.' : 'AppState saved securely.');
    await status();
  } catch (e) { notice(e.message, true); }
}
$('#refresh-commands').addEventListener('click', async () => {
  try { await api('/api/commands/refresh', { method: 'POST', body: '{}' }); await commands(); notice('Commands refreshed.'); }
  catch (e) { notice(e.message, true); }
});
$('#new-command').addEventListener('click', () => {
  $('#command-file').value = '';
  $('#command-source').value = "module.exports = { name: 'example', aliases: [], description: 'Example command', async execute(api, event) { return api.sendMessage('VORTEX', event.threadID, event.messageID); } };";
  $('#editor-wrap').hidden = false;
});
$('#cancel-editor').addEventListener('click', () => $('#editor-wrap').hidden = true);
$('#save-command').addEventListener('click', async () => {
  try {
    const file = $('#command-file').value;
    await api('/api/commands/' + encodeURIComponent(file) + '/save', { method: 'POST', body: JSON.stringify({ source: $('#command-source').value }) });
    $('#editor-wrap').hidden = true; await commands(); notice('Command validated and saved.');
  } catch (e) { notice(e.message, true); }
});
$('#admin-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/admins', { method: 'POST', body: JSON.stringify({ id: $('#admin-id').value }) }); $('#admin-id').value = ''; await admins(); notice('Admin saved.'); }
  catch (x) { notice(x.message, true); }
});
$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ botName: $('#bot-name').value, prefix: $('#prefix').value, language: $('#language').value }) }); notice('Settings saved.'); await status(); }
  catch (x) { notice(x.message, true); }
});
$('#log-search').addEventListener('input', () => logs().catch(() => {}));
$('#log-type').addEventListener('change', () => logs().catch(() => {}));
$('#clear-logs').addEventListener('click', async () => {
  try { await api('/api/logs', { method: 'DELETE' }); await logs(); notice('Logs cleared.'); }
  catch (e) { notice(e.message, true); }
});
(async () => {
  try {
    const s = await fetch('/api/session');
    if (!s.ok) { location.href = '/login'; return; }
    const d = await s.json(); csrfToken = d.csrfToken; sessionStorage.setItem('vortex-csrf', csrfToken);
    await refreshAll();
    setInterval(() => status().catch(() => {}), 5000);
    setInterval(() => logs().catch(() => {}), 7000);
    setInterval(updateAppStateCountdown, 1000);
  } catch { location.href = '/login'; }
})();
