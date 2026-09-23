'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const spec = require('../public/openapi.json');
const creator = '0x2ab4e66D85B1df361a2d51Fd20456c4330EF9AB5';
async function browserFixture({ account = creator, existing = false, description = 'Explain any transaction on the Robinhood Chain.' } = {}) {
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { value: '0', checked: true, hidden: true, events: {}, addEventListener(name, fn) { this.events[name] = fn; }, replaceChildren() {} });
    return elements.get(key);
  };
  const calls = []; let signedMessage;
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return [account];
    if (method === 'personal_sign') { signedMessage = Buffer.from(params[0].slice(2), 'hex').toString(); return 'test-signature'; }
    throw new Error('Unexpected wallet method');
  } };
  const service = { name: 'Olanas Onchain Explainer', description, slug: 'olanas-onchain-explainer', price: '10', currency: 'OLANAS', gatewayUrl: 'https://olanas.xyz/x402/olanas-onchain-explainer' };
  const context = { document: { getElementById: element, createElement: () => ({}) }, window: { ethereum: provider, addEventListener() {}, dispatchEvent() {} }, Event: class {}, location: { origin: 'https://explainer.example' }, crypto: webcrypto, TextEncoder,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === '/health') return { ok: true };
      if (url.includes('/creator/')) return { ok: true, json: async () => ({ services: existing ? [service] : [] }) };
      if (url === '/openapi.json') return { ok: true, json: async () => structuredClone(spec) };
      if (url === 'https://olanas.xyz/api/services') return { ok: true, json: async () => ({ service }) };
      if (url === 'https://olanas.xyz/api/services/' + service.slug && options?.method === 'PATCH') {
        return { ok: true, json: async () => ({ service: { ...service, ...JSON.parse(options.body).changes } }) };
      }
      throw new Error('Unexpected URL');
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/publish.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { element, calls, signed: () => signedMessage };
}
test('creator helper signs the exact platform payload with gateway-relative OpenAPI', async () => {
  const fixture = await browserFixture();
  await fixture.element('publish').events.click();
  const posted = JSON.parse(fixture.calls.find(call => call.url === 'https://olanas.xyz/api/services').options.body);
  assert.equal(posted.price, '10'); assert.equal(posted.currency, 'OLANAS');
  assert.equal(posted.creatorAddress, creator.toLowerCase()); assert.equal(posted.payoutAddress, creator.toLowerCase());
  assert.deepEqual(Object.keys(posted.openapiDocument.paths), ['/']);
  assert.equal(posted.openapiHash, createHash('sha256').update(JSON.stringify(posted.openapiDocument)).digest('hex'));
  const expected = { name: posted.name, description: posted.description, category: posted.category, videoUrl: '', logoHash: '', openapiHash: posted.openapiHash, endpointUrl: 'https://explainer.example/v1/transactions/explain', allowedMethods: ['POST'], price: '10', currency: 'OLANAS', creatorAddress: creator.toLowerCase(), payoutAddress: creator.toLowerCase(), network: 'robinhood-chain', chainId: 4663, timestamp: posted.creatorTimestamp };
  assert.equal(fixture.signed(), 'x402 launch service\n' + JSON.stringify(expected));
  assert.equal(fixture.element('listing').href, 'https://olanas.xyz/services/olanas-onchain-explainer');
});
test('creator helper refuses a different wallet and does not duplicate an existing listing', async () => {
  const wrong = await browserFixture({ account: '0x' + '11'.repeat(20) });
  await wrong.element('publish').events.click();
  assert.equal(wrong.signed(), undefined);
  assert.match(wrong.element('status').textContent, /Switch your wallet/);
  const existing = await browserFixture({ existing: true });
  assert.equal(existing.element('publish').disabled, true);
  assert.equal(existing.signed(), undefined);
  assert.equal(existing.calls.some(call => call.options?.method === 'POST'), false);
});
test('OpenAPI references resolve and the request schema matches the public API', () => {
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'));
      assert.ok(value.$ref.slice(2).split('/').reduce((current, key) => current?.[key], spec), value.$ref);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(spec);
  assert.equal(spec.components.schemas.ExplainRequest.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.ExplainRequest.required, ['transactionHash']);
});
test('published listing update signs only the short description and preserves payment terms', async () => {
  const fixture = await browserFixture({ existing: true, description: 'Old long description' });
  assert.equal(fixture.element('publish').textContent, 'Sign description update');
  await fixture.element('publish').events.click();
  const call = fixture.calls.find(call => call.options?.method === 'PATCH');
  const posted = JSON.parse(call.options.body);
  assert.deepEqual(posted.changes, { description: 'Explain any transaction on the Robinhood Chain.' });
  assert.equal(fixture.signed(), 'x402 manage service\n' + JSON.stringify({ action: 'update', slug: 'olanas-onchain-explainer', changes: posted.changes, timestamp: posted.creatorTimestamp }));
  assert.equal(fixture.calls.some(call => call.options?.method === 'POST'), false);
  assert.equal(fixture.element('publish').disabled, true);
});
