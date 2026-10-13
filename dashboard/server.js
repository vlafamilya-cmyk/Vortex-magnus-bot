const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('node:path');
const fs = require('node:fs/promises');
const { validateAppState } = require('../utils/appState');
const { atomicWrite } = require('../utils/atomicFile');
const { validateConfig } = require('../utils/config');

async function startDashboard({ config, logger, runtime }) {
  if (!config.dashboardPassword || !config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error('Dashboard password or session secret is not configured correctly.');
  }
  validateConfig(config);
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"],
    styleSrc: ["'self'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:']
  } } }));
  app.use(express.json({ limit: '256kb' }));
  app.use(session({
    name: 'vortex.sid', secret: config.sessionSecret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
  }));

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
  const requireAuth = (req, res, next) => {
    if (!req.session?.authenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!['owner', 'admin'].includes(req.session.role)) req.session.role = 'admin';
    next();
  };
  const csrf = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Origin rejected' });
    if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) return res.status(403).json({ error: 'CSRF validation failed' });
    next();
  };

  app.get('/health', (req, res) => res.json({ status: 'ok', bot: 'VORTEX' }));
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
  app.post('/api/login', loginLimiter, (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = password && password === config.dashboardPassword ? 'owner' :
      (config.adminDashboardPassword && password === config.adminDashboardPassword ? 'admin' : '');
    if (!role) {
      logger.warn('DASHBOARD_LOGIN_FAILED');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      req.session.authenticated = true;
      req.session.role = role;
      req.session.csrfToken = require('node:crypto').randomBytes(24).toString('hex');
      res.json({ ok: true, role, csrfToken: req.session.csrfToken });
    });
  });
  app.post('/api/logout', requireAuth, csrf, (req, res) => req.session.destroy(() => res.json({ ok: true })));
  app.get('/api/session', requireAuth, (req, res) => res.json({ authenticated: true, role: req.session.role, ownerID: config.ownerID || '', csrfToken: req.session.csrfToken }));

  app.use('/api', requireAuth, csrf);
  app.use('/api', (req, res, next) => {
    if (req.session.role === 'owner') return next();
    const pathOnly = req.originalUrl.split('?')[0];
    if (pathOnly === '/api/logout') return next();
    const readOnly = req.method === 'GET' && (
      ['/api/status', '/api/commands'].includes(pathOnly) ||
      pathOnly === '/api/events' || pathOnly === '/api/logs'
    );
    if (readOnly) return next();
    return res.status(403).json({ error: 'Owner access required' });
  });
  app.get('/api/status', (req, res) => res.json(runtime.getState()));
  app.get('/api/commands', (req, res) => res.json({ commands: runtime.getCommands() }));
  app.get('/api/commands/:name/source', (req, res) => {
    try { res.json({ source: runtime.getCommandSource(req.params.name) }); }
    catch { res.status(404).json({ error: 'Command not found' }); }
  });
  app.post('/api/commands/refresh', (req, res) => res.json(runtime.refreshCommands()));
  app.post('/api/commands/:file/save', async (req, res) => {
    try {
      if (typeof req.body?.source !== 'string' || req.body.source.length > 50000) return res.status(400).json({ error: 'Invalid source' });
      res.json(await runtime.editCommand(req.params.file, req.body.source));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/commands/:file', async (req, res) => {
    try { res.json(await runtime.deleteCommand(req.params.file)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/appstate/validate', (req, res) => {
    try { validateAppState(req.body?.appState); res.json({ valid: true }); }
    catch (e) { res.status(400).json({ valid: false, error: e.message }); }
  });
  app.post('/api/appstate/save', async (req, res) => {
    try {
      validateAppState(req.body?.appState);
      res.json(await runtime.saveAppState(req.body.appState, false));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/appstate/connect', async (req, res) => {
    try {
      validateAppState(req.body?.appState);
      await runtime.saveAppState(req.body.appState, false);
      res.json(await runtime.connect());
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/appstate/refresh', async (req, res) => {
    try {
      const result = await runtime.refreshAppStateNow();
      res.json({ success: true, state: result.state });
    } catch (e) {
      res.status(503).json({ success: false, error: String(e.message || e).slice(0, 240), state: runtime.getState().appStateRefresh });
    }
  });

  app.post('/api/connection/connect', async (req, res) => {
    try { res.json(await runtime.connect()); }
    catch (e) { res.status(503).json({ error: e.message }); }
  });
  app.post('/api/connection/reconnect', async (req, res) => {
    try { await runtime.disconnect(); res.json(await runtime.connect()); }
    catch (e) { res.status(503).json({ error: e.message }); }
  });
  app.post('/api/connection/disconnect', async (req, res) => res.json(await runtime.disconnect()));

  app.get('/api/admins', (req, res) => res.json({ ownerID: config.ownerID || '', admins: config.adminIDs }));
  app.post('/api/admins', (req, res) => {
    const id = String(req.body?.id || '');
    if (!/^\d{1,30}$/.test(id)) return res.status(400).json({ error: 'Invalid numeric ID' });
    if (id === String(config.ownerID || '')) return res.status(400).json({ error: 'Owner cannot be added to the admin list' });
    if (!config.adminIDs.includes(id)) config.adminIDs.push(id);
    persistConfig(config).then(() => res.json({ ownerID: config.ownerID || '', admins: config.adminIDs })).catch(() => res.status(500).json({ error: 'Save failed' }));
  });
  app.delete('/api/admins/:id', (req, res) => {
    const id = String(req.params.id);
    if (id === String(config.ownerID || '')) return res.status(400).json({ error: 'Owner cannot be removed from the admin list' });
    config.adminIDs = config.adminIDs.filter(x => x !== id);
    persistConfig(config).then(() => res.json({ admins: config.adminIDs })).catch(() => res.status(500).json({ error: 'Save failed' }));
  });
  app.get('/api/settings', (req, res) => res.json({ botName: config.botName, prefix: config.prefix, language: config.language, dashboard: config.dashboard }));
  app.put('/api/settings', async (req, res) => {
    const { botName, prefix, language } = req.body || {};
    if (typeof botName !== 'string' || !botName.trim() || botName.length > 40 ||
        typeof prefix !== 'string' || !prefix.trim() || prefix.length > 12 || !['ar', 'en'].includes(language)) {
      return res.status(400).json({ error: 'Invalid settings' });
    }
    const old = { botName: config.botName, prefix: config.prefix, language: config.language };
    Object.assign(config, { botName: botName.trim(), prefix, language });
    try {
      await persistConfig(config);
      res.json({ botName: config.botName, prefix: config.prefix, language: config.language });
    } catch {
      Object.assign(config, old);
      res.status(500).json({ error: 'Settings save failed' });
    }
  });

  const logBuffer = [];
  const original = { info: logger.info, warn: logger.warn, error: logger.error, command: logger.command, mqtt: logger.mqtt };
  for (const [kind, fn] of Object.entries(original)) logger[kind] = (...args) => {
    logBuffer.push({ time: new Date().toISOString(), type: kind.toUpperCase(), message: String(args[0]), details: args[1] || {} });
    if (logBuffer.length > 500) logBuffer.shift();
    fn(...args);
  };
  app.get('/api/logs', (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    const type = String(req.query.type || '').toUpperCase();
    res.json({ logs: logBuffer.filter(l => (!q || l.message.toLowerCase().includes(q)) && (!type || l.type === type)).slice(-200) });
  });
  app.delete('/api/logs', (req, res) => { logBuffer.length = 0; res.json({ ok: true }); });
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = () => res.write(`data: ${JSON.stringify(runtime.getState())}\n\n`);
    send();
    const timer = setInterval(send, 5000);
    req.on('close', () => clearInterval(timer));
  });
  app.use(express.static(path.join(__dirname, 'public'), { index: false, fallthrough: true }));
  app.get('/', (req, res) => req.session?.authenticated ? res.sendFile(path.join(__dirname, 'public', 'index.html')) : res.redirect('/login'));
  app.get('/{*splat}', (req, res) => req.session?.authenticated ? res.sendFile(path.join(__dirname, 'public', 'index.html')) : res.redirect('/login'));
  app.use((err, req, res, next) => {
    logger.error('DASHBOARD_ERROR', { error: err.message });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(config.port, '0.0.0.0', () => resolve(s));
    s.once('error', reject);
  });
  logger.info('DASHBOARD_LISTENING', { port: config.port });
  return server;

  async function persistConfig(c) {
    const file = path.join(c.dataDir, 'settings.json');
    await atomicWrite(file, JSON.stringify({ botName: c.botName, prefix: c.prefix, language: c.language, adminIDs: c.adminIDs }, null, 2), 0o600);
  }
}
module.exports = { startDashboard };
