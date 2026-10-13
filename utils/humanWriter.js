const DEFAULTS = { minIntervalMs: 1200, globalIntervalMs: 900, duplicateWindowMs: 8000, maxPerMinute: 20 };

function createHumanWriter({ logger = console, ...options } = {}) {
  const config = { ...DEFAULTS, ...options };
  let queue = Promise.resolve();
  let lastGlobalSend = 0;
  const lastThreadSend = new Map();
  const recentMessages = new Map();
  const sentAt = [];
  let pausedUntil = 0;

  function prune(now) {
    for (const [key, at] of recentMessages) if (now - at > config.duplicateWindowMs) recentMessages.delete(key);
    while (sentAt.length && now - sentAt[0] >= 60000) sentAt.shift();
    if (recentMessages.size > 2000) {
      const entries = [...recentMessages.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of entries.slice(0, recentMessages.size - 1500)) recentMessages.delete(key);
    }
  }

  function contentKey(value) {
    try { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : JSON.stringify(value); }
    catch { return String(value); }
  }

  function wrap(api) {
    return new Proxy(api, {
      get(target, property) {
        if (property === 'sendMessage' && typeof target.sendMessage === 'function') {
          return (...args) => {
            const threadID = String(args[1] ?? 'unknown');
            const key = threadID + ':' + contentKey(args[0]);
            const now = Date.now();
            prune(now);
            if (recentMessages.has(key)) {
              logger.warn?.('OUTBOUND_DUPLICATE_SUPPRESSED', { threadID });
              return Promise.resolve({ suppressed: true, reason: 'duplicate' });
            }
            if (sentAt.length >= config.maxPerMinute) {
              logger.warn?.('OUTBOUND_RATE_LIMITED', { threadID, window: '60s' });
              return Promise.resolve({ suppressed: true, reason: 'local-rate-limit' });
            }
            if (now < pausedUntil) {
              logger.warn?.('OUTBOUND_PAUSED', { threadID, until: new Date(pausedUntil).toISOString() });
              return Promise.resolve({ suppressed: true, reason: 'temporary-pause' });
            }
            recentMessages.set(key, now);
            const send = async () => {
              const at = Date.now();
              const wait = Math.max(0, config.globalIntervalMs - (at - lastGlobalSend),
                config.minIntervalMs - (at - (lastThreadSend.get(threadID) || 0)));
              if (wait) await new Promise(resolve => setTimeout(resolve, wait));
              const started = Date.now();
              prune(started);
              if (sentAt.length >= config.maxPerMinute) {
                recentMessages.delete(key);
                logger.warn?.('OUTBOUND_RATE_LIMITED', { threadID, window: '60s' });
                return { suppressed: true, reason: 'local-rate-limit' };
              }
              try {
                const result = await Reflect.apply(target.sendMessage, target, args);
                lastGlobalSend = Date.now();
                lastThreadSend.set(threadID, lastGlobalSend);
                sentAt.push(lastGlobalSend);
                return result;
              } catch (error) {
                recentMessages.delete(key);
                const message = String(error?.message || error);
                if (/rate.?limit|too many|temporar|spam|blocked|try again/i.test(message)) {
                  pausedUntil = Date.now() + 60000;
                  logger.warn?.('OUTBOUND_PAUSED_AFTER_PLATFORM_ERROR', { threadID, pauseMs: 60000 });
                }
                logger.warn?.('OUTBOUND_SEND_FAILED', { threadID, error: message.slice(0, 180) });
                throw error;
              }
            };
            const result = queue.then(send, send);
            queue = result.catch(() => {});
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  return { wrap, getState: () => ({ queued: false, paused: Date.now() < pausedUntil, pausedUntil: pausedUntil || null, sendsLastMinute: sentAt.length }) };
}

module.exports = { createHumanWriter, DEFAULTS };
