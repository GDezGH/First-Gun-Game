/**
 * server.js — a dependency-free static file server for local development.
 *
 *   node server.js            # http://localhost:8080
 *   PORT=3000 node server.js  # http://localhost:3000
 *
 * Why not `npx serve`? Because the game has zero dependencies, and adding
 * one just to serve files would be the only `npm install` in the project.
 * Node's http module handles this in ~60 lines.
 *
 * Correct MIME types matter here: browsers refuse to execute a module
 * served as text/plain, and caching is disabled so edits show up on reload.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  // Resolve inside ROOT only — never follow ../ out of the project.
  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`404 — ${pathname}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`First Gun Game — serving ${ROOT}`);
  console.log(`  local:   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`  network: http://0.0.0.0:${PORT} (bound to all interfaces)`);
});
