const crypto = require('crypto');
const fs = require('fs');
const { isIPv4 } = require('node:net');
const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;

const DEFAULT_CONFIG = Object.freeze({
  xboxIp: '192.168.0.100',
  xboxPort: 21070,
  theme: 'default',
  eventsBindAddress: '0.0.0.0',
  eventsPort: 21070,
  pauseAfterAttempt: false,
  adminPinHash: null,
  adminPinSalt: null
});

class ConfigStore {
  constructor(configPath) {
    this.configPath = configPath;
    this.DEFAULT_CONFIG = DEFAULT_CONFIG;
  }

  load() {
    try {
      if (!fs.existsSync(this.configPath)) {
        return this.save(DEFAULT_CONFIG);
      }

      const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      const pinValid = typeof cfg.adminPinSalt === 'string' && /^[a-f0-9]{32}$/i.test(cfg.adminPinSalt)
        && typeof cfg.adminPinHash === 'string' && /^[a-f0-9]{64}$/i.test(cfg.adminPinHash);
      return {
        xboxIp: cfg.xboxIp || DEFAULT_CONFIG.xboxIp,
        xboxPort: Number(cfg.xboxPort) || DEFAULT_CONFIG.xboxPort,
        theme: cfg.theme === 'strata' ? 'strata' : 'default',
        eventsBindAddress: isIPv4(cfg.eventsBindAddress || '') ? cfg.eventsBindAddress : DEFAULT_CONFIG.eventsBindAddress,
        eventsPort: validPort(cfg.eventsPort) ? cfg.eventsPort : DEFAULT_CONFIG.eventsPort,
        pauseAfterAttempt: cfg.pauseAfterAttempt === true,
        adminPinSalt: pinValid ? cfg.adminPinSalt : null,
        adminPinHash: pinValid ? cfg.adminPinHash : null
      };
    } catch (error) {
      console.warn('Could not read config file, using default config.', error.message);
      return this.save(DEFAULT_CONFIG);
    }
  }

  save(config) {
    const safeConfig = {
      xboxIp: config.xboxIp || DEFAULT_CONFIG.xboxIp,
      xboxPort: Number(config.xboxPort) || DEFAULT_CONFIG.xboxPort,
      theme: config.theme === 'strata' ? 'strata' : 'default',
      eventsBindAddress: isIPv4(config.eventsBindAddress || '') ? config.eventsBindAddress : DEFAULT_CONFIG.eventsBindAddress,
      eventsPort: validPort(config.eventsPort) ? config.eventsPort : DEFAULT_CONFIG.eventsPort,
      pauseAfterAttempt: config.pauseAfterAttempt === true,
      adminPinSalt: config.adminPinSalt || null,
      adminPinHash: config.adminPinHash || null
    };
    fs.writeFileSync(this.configPath, JSON.stringify(safeConfig, null, 2), 'utf-8');
    return safeConfig;
  }

  setAdminPin(pin) {
    const config = this.load();
    if (!pin) {
      config.adminPinSalt = null;
      config.adminPinHash = null;
    } else {
      if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits.');
      config.adminPinSalt = crypto.randomBytes(16).toString('hex');
      config.adminPinHash = crypto.createHash('sha256').update(`${config.adminPinSalt}:${pin}`).digest('hex');
    }
    const saved = this.save(config);
    return { enabled: Boolean(saved.adminPinHash) };
  }

  verifyAdminPin(pin) {
    const { adminPinSalt, adminPinHash } = this.load();
    if (!adminPinHash || !/^\d{4}$/.test(String(pin || ''))) return false;
    const candidate = crypto.createHash('sha256').update(`${adminPinSalt}:${pin}`).digest();
    const expected = Buffer.from(adminPinHash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  }
}

module.exports = ConfigStore;
