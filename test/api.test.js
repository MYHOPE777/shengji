const test = require('node:test');
const assert = require('node:assert/strict');

const { app } = require('../server');

async function withServer(callback) {
  const listener = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    const address = listener.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
}

test('GET /api/health reports service status without exposing credentials', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.demoMode, 'boolean');
    assert.equal('ALIYUN_ACCESS_KEY_SECRET' in body, false);
  });
});

test('GET /api/config exposes only safe provider and limit metadata', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.demoMode, 'boolean');
    assert.equal(body.provider, 'aliyun-filetrans');
    assert.equal(typeof body.limits.maxFileSize, 'number');
    assert.equal('ALIYUN_ACCESS_KEY_ID' in body, false);
    assert.equal('ALIYUN_ACCESS_KEY_SECRET' in body, false);
  });
});

test('job endpoints return clear errors for missing resources and files', async () => {
  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/jobs/does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, '任务不存在');

    const emptyUpload = await fetch(`${baseUrl}/api/jobs`, { method: 'POST' });
    assert.equal(emptyUpload.status, 400);
    assert.match((await emptyUpload.json()).error, /上传/);
  });
});
