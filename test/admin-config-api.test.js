const express = require('express');
const request = require('supertest');
const { createApiRouter } = require('../api-router');

describe('Admin appearance and PIN API', () => {
  let app;
  let configStore;

  beforeEach(() => {
    configStore = {
      load: jest.fn().mockReturnValue({
        xboxIp: '192.168.0.100', xboxPort: 21070, theme: 'strata',
        adminPinSalt: 'salt', adminPinHash: 'secret-hash'
      }),
      save: jest.fn(config => config),
      setAdminPin: jest.fn(pin => ({ enabled: Boolean(pin) })),
      verifyAdminPin: jest.fn(pin => pin === '2468')
    };
    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({ db: {}, configStore, xboxService: {} }));
  });

  it('returns the global theme and PIN enabled state without exposing the digest', async () => {
    const response = await request(app).get('/api/config').expect(200);
    expect(response.body).toEqual({
      xboxIp: '192.168.0.100', xboxPort: 21070, theme: 'strata', adminPinEnabled: true
    });
  });

  it('updates the global theme while preserving existing server settings', async () => {
    const response = await request(app)
      .post('/api/config').send({ theme: 'default' }).expect(200);
    expect(configStore.save).toHaveBeenCalledWith(expect.objectContaining({
      xboxIp: '192.168.0.100', xboxPort: 21070, theme: 'default', adminPinHash: 'secret-hash'
    }));
    expect(response.body.theme).toBe('default');
  });

  it('accepts only a four-digit PIN or an empty value to turn it off', async () => {
    await request(app).post('/api/admin/pin').send({ pin: '123' }).expect(400);
    expect(configStore.setAdminPin).not.toHaveBeenCalled();
    await request(app).post('/api/admin/pin').send({ pin: '0427' }).expect(200, { enabled: true });
    await request(app).post('/api/admin/pin').send({ pin: '' }).expect(200, { enabled: false });
  });

  it('verifies PINs without exposing configured PIN data', async () => {
    await request(app).post('/api/admin/pin/verify').send({ pin: '2468' }).expect(200, { valid: true });
    await request(app).post('/api/admin/pin/verify').send({ pin: '0000' }).expect(200, { valid: false });
  });
});
