import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCurrentMain, notifyDeployment } from './notify-deployment.mjs';

const env = {
  DEPLOY_SERVICE_ID: 'weather-viewer',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?existing=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'uiui611/weather-viewer',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_TOKEN: 'github-secret',
};
const jwt = 'header.payload.signature';

function fakeRequests(responses) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      assert.ok(options.signal);
      assert.equal(options.redirect, 'manual');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'Unexpected extra request');
      return response;
    },
  };
}

test('202 is sufficient; JWT is masked and only service is sent', async () => {
  const mock = fakeRequests([
    new Response(JSON.stringify({ value: jwt }), { status: 200 }),
    { status: 202, json: () => { throw new Error('Must not wait for or read an update result'); } },
  ]);
  const logs = [];
  await notifyDeployment({ env, ...mock, log: (line) => logs.push(line) });
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].url.searchParams.get('audience'), 'https://deploy.mizu-mizu.info');
  assert.equal(mock.requests[0].url.searchParams.get('existing'), '1');
  assert.equal(mock.requests[1].url.href, 'https://deploy.mizu-mizu.info/v1/deployments');
  assert.equal(mock.requests[1].options.headers.Authorization, `Bearer ${jwt}`);
  assert.deepEqual(JSON.parse(mock.requests[1].options.body), { service: 'weather-viewer' });
  assert.equal(logs[0], `::add-mask::${jwt}`);
  assert.ok(logs.slice(1).every((line) => !line.includes(jwt) && !line.includes('request-secret')));
});

test('authentication failure is not retried and response bodies are not logged', async () => {
  const mock = fakeRequests([
    new Response(JSON.stringify({ value: jwt }), { status: 200 }),
    new Response(`untrusted response ${jwt}`, { status: 401 }),
  ]);
  await assert.rejects(notifyDeployment({ env, ...mock, log: () => {}, sleep: () => { throw new Error('No retry'); } }),
    { message: 'Deployment webhook returned HTTP 401' });
  assert.equal(mock.requests.length, 2);
});

test('temporary webhook failure is retried with a fresh token', async () => {
  const secondJwt = 'header.second.signature';
  const mock = fakeRequests([
    new Response(JSON.stringify({ value: jwt }), { status: 200 }),
    new Response('', { status: 502 }),
    new Response(JSON.stringify({ value: secondJwt }), { status: 200 }),
    new Response('', { status: 202 }),
  ]);
  const delays = [];
  await notifyDeployment({ env, ...mock, log: () => {}, sleep: async (delay) => delays.push(delay) });
  assert.deepEqual(delays, [2_000]);
  assert.equal(mock.requests[3].options.headers.Authorization, `Bearer ${secondJwt}`);
});

test('network exceptions are sanitized and retries are bounded', async () => {
  const mock = fakeRequests(Array.from({ length: 3 }, () => new Error(`Authorization: ${jwt}`)));
  const logs = [];
  const delays = [];
  await assert.rejects(notifyDeployment({
    env, ...mock, log: (line) => logs.push(line), sleep: async (delay) => delays.push(delay),
  }), { message: 'Request failed or timed out' });
  assert.deepEqual(delays, [2_000, 4_000]);
  assert.equal(mock.requests.length, 3);
  assert.ok(logs.every((line) => !line.includes(jwt)));
});

test('a redirect or generic HTTP 200 does not count as webhook acceptance', async () => {
  for (const status of [200, 301]) {
    const mock = fakeRequests([
      new Response(JSON.stringify({ value: jwt }), { status: 200 }),
      new Response('', { status }),
    ]);
    await assert.rejects(notifyDeployment({ env, ...mock, log: () => {} }),
      { message: `Deployment webhook returned HTTP ${status}` });
    assert.equal(mock.requests.length, 2);
  }
});

test('main head verification rejects an old rerun before publication', async () => {
  const mock = fakeRequests([new Response(JSON.stringify({ object: { sha: 'b'.repeat(40) } }), { status: 200 })]);
  await assert.rejects(assertCurrentMain({ env, ...mock, log: () => {} }), /no longer the main head/);
  assert.equal(mock.requests[0].url.href, 'https://api.github.com/repos/uiui611/weather-viewer/git/ref/heads/main');
});

test('main head verification accepts the current commit and rejects other branches', async () => {
  const mock = fakeRequests([new Response(JSON.stringify({ object: { sha: env.GITHUB_SHA } }), { status: 200 })]);
  await assertCurrentMain({ env, ...mock, log: () => {} });
  await assert.rejects(assertCurrentMain({ env: { ...env, GITHUB_REF: 'refs/heads/feature' }, ...mock }), /only from main/);
  assert.equal(mock.requests.length, 1);
});
