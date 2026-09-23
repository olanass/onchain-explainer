'use strict';
const CREATOR = '0x2ab4e66D85B1df361a2d51Fd20456c4330EF9AB5';
const PLATFORM = 'https://olanas.xyz';
const DESCRIPTION = 'Explain any transaction on the Robinhood Chain.';
const CATEGORY = 'Data';
const endpoint = location.origin + '/v1/transactions/explain';
const status = document.getElementById('status'), button = document.getElementById('publish'), select = document.getElementById('wallet');
const providers = [];
let healthy = false;
document.getElementById('endpoint').textContent = endpoint;
document.getElementById('description').textContent = DESCRIPTION;
document.getElementById('category').textContent = CATEGORY;
function addProvider(provider, name) {
  if (!provider || providers.some(item => item.provider === provider)) return;
  providers.push({ provider, name });
  select.replaceChildren(...providers.map((item, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = item.name; return option; }));
}
window.addEventListener('eip6963:announceProvider', event => addProvider(event.detail?.provider, event.detail?.info?.name || 'Browser wallet'));
window.dispatchEvent(new Event('eip6963:requestProvider'));
if (window.ethereum) addProvider(window.ethereum, 'Browser wallet');
document.getElementById('reviewed').addEventListener('change', event => { button.disabled = !healthy || !event.target.checked; });
async function existingListing() {
  const response = await fetch(PLATFORM + '/api/services/creator/' + CREATOR);
  if (!response.ok) throw new Error('Cannot check existing Olanas listings. Retry shortly.');
  const data = await response.json();
  return data.services?.find(service => service.name === 'Olanas Onchain Explainer');
}
function showListing(service) {
  status.textContent = 'Published on Olanas. Price: ' + service.price + ' ' + service.currency + '. Gateway: ' + service.gatewayUrl;
  const link = document.getElementById('listing');
  link.href = PLATFORM + '/services/' + encodeURIComponent(service.slug); link.hidden = false;
  const needsUpdate = service.category !== CATEGORY;
  healthy = needsUpdate;
  button.disabled = !needsUpdate || !document.getElementById('reviewed').checked;
  if (needsUpdate) {
    document.getElementById('pageTitle').textContent = 'Update your listing.';
    document.getElementById('pageIntro').textContent = 'Change the published listing category from ' + service.category + ' to Data.';
    button.textContent = 'Sign category update';
    status.textContent = 'Review category: Data, then sign with your creator wallet. Only the category will change.';
  } else {
    status.textContent = 'Your listing is live in the Data category.';
    button.textContent = 'Category updated';
  }
}
async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const existing = await existingListing();
    if (existing && existing.category === CATEGORY) { showListing(existing); return; }
    const provider = providers[Number(select.value)]?.provider;
    if (!provider) throw new Error('Open this page in a browser with your wallet extension enabled, then refresh.');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const address = accounts[0];
    if (address?.toLowerCase() !== CREATOR.toLowerCase()) throw new Error('Switch your wallet to the Startup Pitch Scorer creator address shown above, then try again.');
    if (existing) {
      const changes = { category: CATEGORY };
      const creatorTimestamp = String(Date.now());
      const message = 'x402 manage service\n' + JSON.stringify({ action: 'update', slug: existing.slug, changes, timestamp: creatorTimestamp });
      const encoded = '0x' + Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('');
      status.textContent = 'Review and sign the category update to Data in your wallet.';
      const creatorSignature = await provider.request({ method: 'personal_sign', params: [encoded, address] });
      const response = await fetch(PLATFORM + '/api/services/' + encodeURIComponent(existing.slug), {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes, creatorTimestamp, creatorSignature })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The listing could not be updated.');
      showListing(result.service);
      return;
    }
    const specResponse = await fetch('/openapi.json');
    if (!specResponse.ok) throw new Error('Could not load the API specification.');
    const openapiDocument = await specResponse.json();
    // The paid gateway forwards its root to the full upstream endpoint.
    openapiDocument.paths = { '/': openapiDocument.paths['/v1/transactions/explain'] };
    const openapiHash = await sha256(JSON.stringify(openapiDocument));
    const timestamp = String(Date.now());
    const payload = {
      name: 'Olanas Onchain Explainer', description: DESCRIPTION, category: CATEGORY, videoUrl: '',
      logoHash: '', openapiHash, endpointUrl: endpoint, allowedMethods: ['POST'], price: '10', currency: 'OLANAS',
      creatorAddress: CREATOR.toLowerCase(), payoutAddress: CREATOR.toLowerCase(), network: 'robinhood-chain', chainId: 4663, timestamp
    };
    const message = 'x402 launch service\n' + JSON.stringify(payload);
    const hexMessage = '0x' + Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('');
    status.textContent = 'Review and sign the listing message in your wallet.';
    const signature = await provider.request({ method: 'personal_sign', params: [hexMessage, address] });
    status.textContent = 'Publishing the signed listing…';
    const response = await fetch(PLATFORM + '/api/services', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, creatorTimestamp: timestamp, creatorSignature: signature, openapiDocument }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Olanas could not publish this listing.');
    showListing(result.service);
  } catch (error) {
    status.textContent = error.code === 4001 ? 'Signature declined. Nothing was published.' : error.message;
    button.disabled = !document.getElementById('reviewed').checked;
  }
});
fetch('/health').then(async response => {
  if (!response.ok) throw new Error('Backend health check failed.');
  const existing = await existingListing();
  if (existing) return showListing(existing);
  healthy = true;
  button.disabled = !document.getElementById('reviewed').checked;
  status.textContent = 'Ready. Review the details, then connect and sign with your creator wallet.';
}).catch(error => { status.textContent = error.message; });
