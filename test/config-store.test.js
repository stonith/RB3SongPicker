const fs = require('fs');
const os = require('os');
const path = require('path');
const ConfigStore = require('../config-store');

describe('ConfigStore theme and Admin PIN settings', () => {
  let directory;
  let store;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb3-config-'));
    store = new ConfigStore(path.join(directory, 'config.json'));
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('defaults to the original theme with PIN disabled', () => {
    expect(store.load()).toMatchObject({ theme: 'default', adminPinHash: null, adminPinSalt: null });
  });

  it('persists the selected theme and normalizes unknown values to Default', () => {
    store.save({ theme: 'strata' });
    expect(store.load().theme).toBe('strata');
    store.save({ theme: 'unknown' });
    expect(store.load().theme).toBe('default');
  });

  it('stores only a salted digest and verifies a valid PIN', () => {
    store.setAdminPin('0427');
    const config = store.load();
    expect(config.adminPinHash).not.toContain('0427');
    expect(config.adminPinSalt).toMatch(/^[a-f0-9]{32}$/);
    expect(store.verifyAdminPin('0427')).toBe(true);
    expect(store.verifyAdminPin('1111')).toBe(false);
  });

  it('rejects malformed PINs and clears the gate when disabled', () => {
    expect(() => store.setAdminPin('123')).toThrow('PIN must be exactly 4 digits.');
    store.setAdminPin('1234');
    store.setAdminPin('');
    expect(store.load()).toMatchObject({ adminPinHash: null, adminPinSalt: null });
    expect(store.verifyAdminPin('1234')).toBe(false);
  });
});
