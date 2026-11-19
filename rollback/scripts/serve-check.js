const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const server = http.createServer((req, res) => {
  const p = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.html') ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});
server.listen(8099, () => {
  const get = (u) => new Promise((resolve) => {
    http.get('http://localhost:8099' + u, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ code: res.statusCode, len: body.length, type: res.headers['content-type'] }));
    });
  });
  (async () => {
    for (const u of ['/', '/lib/engine.js', '/lib/netcode.js', '/lib/scenarios.js', '/lib/app.js']) {
      console.log(u, await get(u));
    }
    server.close();
  })();
});
