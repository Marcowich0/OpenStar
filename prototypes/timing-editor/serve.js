// PROTOTYPE (throwaway): static server with Range support, so the video can seek.
// Run: node prototypes/timing-editor/serve.js   then open http://<host>:8765/
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname, port = +process.env.PORT || 8765;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? +m[1] : st.size - +m[2], end = m[1] && m[2] ? +m[2] : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, () => console.log(`Timing editor prototype on http://localhost:${port}/  (?variant=A|B|C, ?song=songs/<folder>/)`));
