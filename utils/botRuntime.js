const fs = require('node:fs/promises');
const path = require('node:path');
const { loadCommands } = require('./commandLoader');
const { validateAppState } = require('./appState');
const { atomicWrite } = require('./atomicFile');
const { ReconnectManager } = require('./reconnect');
const { AppStateRefreshManager } = require('./appStateRefresh');
const { NicknameGuard } = require('./nicknameGuard');
const { createHumanWriter } = require('./humanWriter');

function createBotRuntime({ config, logger }) {
  const cmdsDir = path.join(__dirname, '..', 'cmds');
  let loaded = loadCommands(cmdsDir, logger);
  let api = null;
  let status = 'offline';
  let lastError = null;
  let lastConnect = null;
  let lastDisconnect = null;
  let reconnects = 0;
  let startedAt = Date.now();
  let connecting = false;
  let appStatePresent = false;
  let appState = null;
  let reconnectManager;
  let appStateRefreshManager;
  let mqttStatus = 'offline';
  let manualDisconnect = false;
  const nicknameGuard = new NicknameGuard({ getApi: () => api, logger, nickname: '𝑽𝑶𝑹𝑻𝑬𝑿 →' });
  const humanWriter = createHumanWriter({ logger, minIntervalMs: 1200, globalIntervalMs: 900, duplicateWindowMs: 8000, maxPerMinute: 20 });
  const seenCommandMessages = new Map();

  const runtime = {
    getState() {
      return {
        bot: config.botName, prefix: config.prefix, status, fcaStatus: status, mqttStatus,
        connected: status === 'connected', uptimeMs: Date.now() - startedAt,
        commands: loaded.unique.length, reconnectAttempts: reconnects,
        lastConnection: lastConnect, lastDisconnect, lastError,
        appStateConfigured: appStatePresent,
        appStateRefresh: appStateRefreshManager ? appStateRefreshManager.getState() : {
          successCount: 0, failureCount: 0, lastAttemptAt: null, lastSuccessAt: null,
          lastFailureAt: null, lastError: null, nextRefreshAt: null, refreshing: false,
          intervalMs: 3 * 60 * 60 * 1000
        },
        outboundProtection: humanWriter.getState(), botID: null, version: require('../package.json').version
      };
    },
    getCommands() {
      return loaded.unique.map(c => ({
        name: c.name, aliases: c.aliases, description: c.description || '',
        adminOnly: !!c.adminOnly, file: c.file, status: 'loaded'
      }));
    },
    getCommandSource(name) {
      const c = loaded.unique.find(x => x.name === name || x.aliases.includes(name));
      if (!c) throw new Error('Command not found');
      return require('node:fs').readFileSync(path.join(cmdsDir, c.file), 'utf8');
    },
    refreshCommands() {
      loaded = loadCommands(cmdsDir, logger);
      return { count: loaded.unique.length, errors: loaded.errors };
    },
    async setAdminIDs(ids) {
      if (!Array.isArray(ids) || ids.some(id => !/^\\d{1,30}$/.test(String(id)))) throw new Error('Invalid admin IDs');
      config.adminIDs = [...new Set(ids.map(String).filter(id => id !== String(config.ownerID || '')))];
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(config.dataDir, 'settings.json'), JSON.stringify({
        botName: config.botName, prefix: config.prefix, language: config.language, adminIDs: config.adminIDs
      }, null, 2), 0o600);
      return { admins: [...config.adminIDs] };
    },
    async saveAppState(raw, connect = false) {
      const parsed = validateAppState(raw);
      const file = path.join(config.dataDir, 'appstate.json');
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(file, JSON.stringify(parsed), 0o600);
      appState = parsed;
      appStatePresent = true;
      if (connect) await runtime.connect();
      return { valid: true, connected: status === 'connected' };
    },
    async connect() {
      if (connecting || status === 'connected') return { status, mqttStatus };
      if (reconnectManager && manualDisconnect) {
        reconnectManager.start();
        manualDisconnect = false;
      }
      connecting = true;
      status = 'connecting';
      mqttStatus = 'connecting';
      lastError = null;
      try {
        if (!appState) {
          let raw = config.appStateJson;
          if (!raw && config.appStateFile) raw = await fs.readFile(config.appStateFile, 'utf8');
          if (!raw) {
            try { raw = await fs.readFile(path.join(config.dataDir, 'appstate.json'), 'utf8'); } catch {}
          }
          if (!raw) throw new Error('No AppState configured');
          appState = validateAppState(raw);
          appStatePresent = true;
        }
        const mod = require('@dongdev/fca-unofficial');
        const login = typeof mod === 'function' ? mod : (mod.login || mod.default?.login || mod.default);
        if (typeof login !== 'function') throw new Error('Installed FCA package does not expose a supported login() API');
        await new Promise((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => finish(new Error('FCA login timed out')), 30000);
          function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            err ? reject(err) : resolve(value);
          }
          try {
            login({ appState }, { listenEvents: true, autoReconnect: false, logLevel: 'error' }, (err, client) => {
              if (err) return finish(new Error('FCA login failed: ' + String(err.message || err).slice(0, 300)));
              if (!client || typeof client.listenMqtt !== 'function') return finish(new Error('FCA returned an unsupported client'));
              api = client;
              try {
                client.setOptions?.({ listenEvents: true, autoReconnect: false, logLevel: 'error' });
                const listener = client.listenMqtt((e, event) => {
                  if (e) {
                    logger.warn('FCA_EVENT_ERROR', { error: String(e.message || e).slice(0, 200) });
                    if (api === client) runtime.disconnected('mqtt-event-error');
                    return;
                  }
                  if (event) {
                    mqttStatus = 'connected';
                    runtime.handleEvent(event).catch(x => logger.error('EVENT_HANDLER_FAILED', { error: String(x.message || x).slice(0, 200) }));
                  }
                });
                if (listener?.on) {
                  listener.on('error', e => {
                    mqttStatus = 'error';
                    logger.warn('MQTT_ERROR', { error: String(e.message || e).slice(0, 200) });
                  });
                  listener.on('close', () => {
                    mqttStatus = 'offline';
                    if (api === client) runtime.disconnected('mqtt-close');
                  });
                  listener.on('end', () => {
                    mqttStatus = 'offline';
                    if (api === client) runtime.disconnected('mqtt-end');
                  });
                }
                mqttStatus = 'connected';
              } catch (e) { return finish(e); }
              status = 'connected';
              lastConnect = new Date().toISOString();
              lastError = null;
              finish(null, client);
            });
          } catch (e) { finish(e); }
        });
        reconnectManager?.reset();
        return { status };
      } catch (e) {
        status = 'offline';
        mqttStatus = 'offline';
        lastError = String(e.message || e).slice(0, 300);
        lastDisconnect = new Date().toISOString();
        logger.error('FCA_CONNECT_FAILED', { error: lastError });
        throw e;
      } finally {
        connecting = false;
      }
    },
    async disconnected(reason) {
      if (status === 'offline' && !api) return;
      lastDisconnect = new Date().toISOString();
      status = 'offline';
      mqttStatus = 'offline';
      api = null;
      lastError = String(reason || 'connection lost').slice(0, 200);
      logger.warn('FCA_DISCONNECTED', { reason: lastError });
      reconnects++;
      if (!manualDisconnect) reconnectManager?.schedule();
    },
    async handleEvent(event) {
      nicknameGuard.handle(event).catch(e => logger.warn('NICKNAME_GUARD_FAILED', { error: String(e.message || e).slice(0, 200) }));
      if (!event || event.type !== 'message' || !event.body || !event.threadID) return;
      const body = String(event.body);
      if (!body.startsWith(config.prefix)) return;
      const [rawName, ...args] = body.slice(config.prefix.length).trim().split(/\\s+/);
      if (!rawName) return;
      const cmd = loaded.commands.get(rawName.toLowerCase());
      if (!cmd) return;
      const sender = String(event.senderID || '');
      const isOwner = !!config.ownerID && sender === String(config.ownerID);
      const isAdmin = isOwner || config.adminIDs.includes(sender);
      if (event.messageID) {
        const now = Date.now();
        for (const [key, at] of seenCommandMessages) if (now - at > 300000) seenCommandMessages.delete(key);
        const dedupeKey = String(event.threadID) + ':' + String(event.messageID);
        if (seenCommandMessages.has(dedupeKey)) {
          logger.warn('DUPLICATE_COMMAND_SUPPRESSED', { command: cmd.name, threadID: String(event.threadID) });
          return;
        }
        seenCommandMessages.set(dedupeKey, now);
        if (seenCommandMessages.size > 2000) {
          const oldest = [...seenCommandMessages.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500);
          for (const [key] of oldest) seenCommandMessages.delete(key);
        }
      }
      if (cmd.adminOnly && !isAdmin) {
        humanWriter.wrap(api).sendMessage('⛔ هذا الأمر للمسؤولين فقط.', event.threadID, event.messageID).catch(() => {});
        return;
      }
      const ctx = { ...event, args, commandName: rawName, startedAt: Date.now(), config, runtime, isOwner, isAdmin };
      try {
        await cmd.execute(humanWriter.wrap(api), ctx);
        logger.command('COMMAND_OK', { name: cmd.name, senderID: sender, role: isOwner ? 'owner' : isAdmin ? 'admin' : 'user' });
      } catch (e) {
        logger.error('COMMAND_FAILED', { name: cmd.name, error: String(e.message || e).slice(0, 200) });
      }
    },
    async disconnect() {
      manualDisconnect = true;
      reconnectManager?.stop();
      if (api && typeof api.logout === 'function') {
        try { await api.logout(); } catch (e) { logger.warn('FCA_LOGOUT_FAILED', { error: e.message }); }
      }
      api = null;
      status = 'offline';
      mqttStatus = 'offline';
      lastDisconnect = new Date().toISOString();
      return { status, mqttStatus };
    },
    async refreshAppStateNow() {
      if (!appStateRefreshManager) throw new Error('AppState refresh manager is not ready');
      return appStateRefreshManager.refresh({ manual: true });
    },
    async stop() {
      appStateRefreshManager?.stop();
      await runtime.disconnect();
    },
    async start() {
      appStateRefreshManager = new AppStateRefreshManager({
        dataDir: config.dataDir,
        getApi: () => api,
        ensureConnected: async () => { if (!api) await runtime.connect(); },
        setAppState: value => { appState = value; appStatePresent = true; },
        logger
      });
      await appStateRefreshManager.init();
      reconnectManager = new ReconnectManager({
        connect: () => runtime.connect(), logger,
        baseMs: config.connection?.baseBackoffMs || 2000,
        maxMs: config.connection?.maxBackoffMs || 60000
      });
      reconnectManager.start();
      manualDisconnect = false;
      try { await runtime.connect(); } catch { reconnectManager.schedule(); }
    },
    get api() { return api; },
    async editCommand(name, source) {
      if (!/^[a-z0-9_-]{1,32}\.js$/i.test(name)) throw new Error('Invalid command filename');
      const vm = require('node:vm');
      new vm.Script(source, { filename: name });
      const target = path.resolve(cmdsDir, name);
      if (path.dirname(target) !== path.resolve(cmdsDir)) throw new Error('Invalid path');
      await fs.mkdir(path.join(config.dataDir, 'backups'), { recursive: true, mode: 0o700 });
      try {
        const old = await fs.readFile(target, 'utf8');
        await atomicWrite(path.join(config.dataDir, 'backups', `${name}.${Date.now()}.bak`), old);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await atomicWrite(target, source, 0o600);
      const result = runtime.refreshCommands();
      if (result.errors.some(e => e.file === name)) throw new Error('Command failed validation after save');
      return result;
    },
    async deleteCommand(name) {
      if (!/^[a-z0-9_-]{1,32}\.js$/i.test(name)) throw new Error('Invalid command filename');
      const target = path.resolve(cmdsDir, name);
      if (path.dirname(target) !== path.resolve(cmdsDir)) throw new Error('Invalid path');
      await fs.unlink(target);
      return runtime.refreshCommands();
    }
  };
  return runtime;
}
module.exports = { createBotRuntime };
