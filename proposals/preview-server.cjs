const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://localhost').pathname);
  if (name !== 'bluetooth-preview.html') { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(__dirname, name)));
}).listen(8091, '127.0.0.1');
