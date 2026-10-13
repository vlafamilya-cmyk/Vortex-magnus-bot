const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadConfig() {
  const rootDir = path.join(__dirname, '..');
  const base = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
  const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let sessionSecret = process.env.SESSION_SECRET || '';
  const secretFile = path.join(dataDir, 'session-secret');
  if (!sessionSecret) {
    try { sessionSecret = fs.readFileSync(secretFile, 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!sessionSecret || sessionSecret.length < 32) {
      sessionSecret = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(secretFile, sessionSecret, { mode: 0o600, flag: 'w' });
      try { fs.chmodSync(secretFile, 0o600); } catch {}
    }
  }
  const envAdmins = (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const savedAdminsExist = Array.isArray(saved.adminIDs);
  const adminIDs = savedAdminsExist ? saved.adminIDs.map(String) : [...(base.adminIDs || []).map(String), ...envAdmins];
  return {
    ...base, ...saved,
    botName: process.env.BOT_NAME || saved.botName || base.botName || 'VORTEX',
    prefix: process.env.PREFIX || saved.prefix || base.prefix || '*',
    adminIDs: [...new Set(adminIDs)],
    ownerID: String(process.env.OWNER_ID || saved.ownerID || base.ownerID || ''),
    adminDashboardPassword: process.env.ADMIN_DASHBOARD_PASSWORD || '',
    dataDir,
    port: Number(process.env.PORT) || 3000,
    dashboardPassword: process.env.DASHBOARD_PASSWORD || 'vortex110',
    sessionSecret,
    appStateJson: process.env.APPSTATE_JSON || '',
    appStateFile: process.env.APPSTATE_FILE || ''
  };
}
function validateConfig(c) {
  if (!c || typeof c.prefix !== 'string' || !c.prefix.trim() || c.prefix.length > 12) throw new Error('Invalid prefix');
  if (!Array.isArray(c.adminIDs) || c.adminIDs.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id))) throw new Error('Invalid admin IDs');
  if (c.ownerID && !/^\d{1,30}$/.test(String(c.ownerID))) throw new Error('Invalid owner ID');
  if (c.ownerID && c.adminIDs.includes(String(c.ownerID))) c.adminIDs = c.adminIDs.filter(id => id !== String(c.ownerID));
  return true;
}
module.exports = { loadConfig, validateConfig };
