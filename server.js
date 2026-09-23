'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const explain = require('./api/explain');
const health = require('./api/health');
const publicFiles = { '/': 'index.html', '/openapi.json': 'openapi.json', '/publish': 'publish.html', '/publish.html': 'publish.html', '/publish.js': 'publish.js', '/style.css': 'style.css' };
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (['/v1/transactions/explain', '/api/explain'].includes(url.pathname)) return explain(req, res);
  if (['/health', '/api/health'].includes(url.pathname)) return health(req, res);
  const file = publicFiles[url.pathname];
  if (file && ['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Content-Type', types[path.extname(file)]);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(path.join(__dirname, 'public', file)).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
  }
  res.statusCode = 404; res.end('Not found');
});
server.requestTimeout = 25000;
server.headersTimeout = 10000;
if (require.main === module) server.listen(Number(process.env.PORT || 4030), '127.0.0.1', () => console.log('Olanas Onchain Explainer listening at http://127.0.0.1:' + (process.env.PORT || 4030)));
module.exports = server;
