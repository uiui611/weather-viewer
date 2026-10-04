import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notifyDeployment } from './notify-deployment.mjs';

const env = {
  DEPLOY_SERVICE_ID: 'weather-viewer',
  DEPLOY_WEBHOOK_URL: 'https://deploy.mizu-mizu.info/v1/deployments',
  DEPLOY_OIDC_AUDIENCE: 'https://deploy.mizu-mizu.info',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?existing=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
};
const token = 'test-token';

test('sends a masked OIDC token and service, accepting any HTTP 2xx without reading the body', async () => {
  for (const status of [200, 202, 204]) {
    const requests = [];
    const logs = [];
    await notifyDeployment({
      env,
      log: (line) => logs.push(line),
      fetchImpl: async (url, options) => {
        requests.push({ url: new URL(url), options });
        return requests.length === 1
          ? new Response(JSON.stringify({ value: token }))
          : { ok: true, status, json: () => assert.fail('Do not inspect the webhook body') };
      },
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.searchParams.get('audience'), env.DEPLOY_OIDC_AUDIENCE);
    assert.equal(requests[0].url.searchParams.get('existing'), '1');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer request-secret');
    assert.equal(requests[1].url.href, env.DEPLOY_WEBHOOK_URL);
    assert.equal(requests[1].options.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(requests[1].options.body), { service: 'weather-viewer' });
    assert.ok(logs.includes(`::add-mask::${token}`));
  }
});

test('a rejected webhook is reported without retries or response body logging', async () => {
  let calls = 0;
  const logs = [];
  await assert.rejects(notifyDeployment({
    env,
    log: (line) => logs.push(line),
    fetchImpl: async () => ++calls === 1
      ? new Response(JSON.stringify({ value: token }))
      : new Response('private response body', { status: 503 }),
  }), /Deployment webhook rejected the request/);
  assert.equal(calls, 2);
  assert.ok(logs.includes('Deployment webhook returned HTTP 503.'));
  assert.ok(logs.every((line) => !line.includes('private response body')));
});

test('CLI failures produce a generic warning without exposing request details', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./notify-deployment.mjs', import.meta.url))], {
    env: { ...process.env, ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'invalid-request-secret' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::warning::Deployment notification failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /invalid-request-secret/);
});
