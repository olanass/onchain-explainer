'use strict';
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    return require('../lib/http').send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
  }
  if (req.method === 'HEAD') { res.statusCode = 200; return res.end(); }
  require('../lib/http').send(res, 200, { status: 'ok', service: 'Olanas Onchain Explainer', version: '1.0.0', chainId: 4663, rpcChecked: false });
};
