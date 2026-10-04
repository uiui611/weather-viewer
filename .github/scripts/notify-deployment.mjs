import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

class RequestFailure extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function safeHttpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or a fragment`);
  }
  return url;
}

async function request(fetchImpl, url, options) {
  try {
    return await fetchImpl(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Fetch exceptions can include request details. Do not expose them in Actions logs.
    throw new RequestFailure('Request failed or timed out', true);
  }
}

function checkStatus(response, expected, operation) {
  if (response.status !== expected) {
    const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    throw new RequestFailure(`${operation} returned HTTP ${response.status}`, retryable);
  }
}

export async function assertCurrentMain({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (required(env, 'GITHUB_REF') !== 'refs/heads/main') {
    throw new Error('Publishing is allowed only from main');
  }
  const repository = required(env, 'GITHUB_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid GITHUB_REPOSITORY');
  }
  const api = safeHttpsUrl(env.GITHUB_API_URL || 'https://api.github.com', 'GITHUB_API_URL');
  const url = new URL(`${api.pathname.replace(/\/$/, '')}/repos/${repository}/git/ref/heads/main`, api.origin);
  const response = await request(fetchImpl, url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${required(env, 'GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  checkStatus(response, 200, 'Main branch check');
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Main branch check returned invalid JSON');
  }
  if (data.object?.sha !== required(env, 'GITHUB_SHA')) {
    throw new Error('This commit is no longer the main head. Run the workflow for the latest main commit.');
  }
  log('Main head verified.');
}

export async function notifyDeployment({
  env = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const webhook = safeHttpsUrl(
    env.DEPLOY_WEBHOOK_URL || 'https://deploy.mizu-mizu.info/v1/deployments',
    'DEPLOY_WEBHOOK_URL',
  );
  if (webhook.search) throw new Error('DEPLOY_WEBHOOK_URL must not include a query string');
  const audience = env.DEPLOY_OIDC_AUDIENCE || 'https://deploy.mizu-mizu.info';
  const service = required(env, 'DEPLOY_SERVICE_ID');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(service)) {
    throw new Error('Invalid DEPLOY_SERVICE_ID');
  }
  const oidcUrl = safeHttpsUrl(required(env, 'ACTIONS_ID_TOKEN_REQUEST_URL'), 'ACTIONS_ID_TOKEN_REQUEST_URL');
  oidcUrl.searchParams.set('audience', audience);
  const oidcAuthorization = required(env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // Refresh the JWT on every attempt; the receiver uses run_id/run_attempt for idempotency.
      const tokenResponse = await request(fetchImpl, oidcUrl, {
        headers: { Authorization: `Bearer ${oidcAuthorization}` },
      });
      checkStatus(tokenResponse, 200, 'OIDC token request');
      let token;
      try {
        token = (await tokenResponse.json()).value;
      } catch {
        throw new Error('OIDC token response was invalid');
      }
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        throw new Error('OIDC token response did not contain a JWT');
      }
      // GitHub does not automatically mask every JWT obtained through this API.
      log(`::add-mask::${token}`);
      const response = await request(fetchImpl, webhook, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ service }),
      });
      checkStatus(response, 202, 'Deployment webhook');
      log('Deployment update accepted. Pod startup is not awaited.');
      return;
    } catch (error) {
      if (!(error instanceof RequestFailure) || !error.retryable || attempt === MAX_ATTEMPTS) throw error;
      log(`${error.message}; retrying (${attempt}/${MAX_ATTEMPTS}).`);
      await sleep(2_000 * attempt);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--check-main') await assertCurrentMain();
    else if (process.argv.length === 2) await notifyDeployment();
    else throw new Error('Usage: node notify-deployment.mjs [--check-main]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
