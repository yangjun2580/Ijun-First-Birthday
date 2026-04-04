const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT      = 8080;
// gviz/tq 엔드포인트: export보다 캐시가 덜 걸림
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1gb1qCq8hXQ3gWHfhtWLDtRXtqFcGZUrxg9ZKodIKj2k/gviz/tq?tqx=out:csv&gid=1910093720';
const DIR       = __dirname;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
};

// 리다이렉트 추적 + 캐시 방지 헤더 포함
function fetchWithRedirect(url, cb, redirectCount = 0) {
    if (redirectCount > 5) { cb(new Error('Too many redirects')); return; }

    const parsedUrl = new URL(url);
    const options = {
        hostname: parsedUrl.hostname,
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   'GET',
        headers: {
            'Cache-Control': 'no-cache, no-store',
            'Pragma':        'no-cache',
            'User-Agent':    'Mozilla/5.0',
        },
    };

    const request = https.request(options, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume();
            fetchWithRedirect(r.headers.location, cb, redirectCount + 1);
            return;
        }
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => cb(null, data));
    });
    request.on('error', err => cb(err));
    request.end();
}

const server = http.createServer((req, res) => {
    // ── /api/votes : 구글 시트 직접 fetch (리다이렉트 자동 처리) ──
    if (req.url === '/api/votes') {
        fetchWithRedirect(`${SHEET_URL}&t=${Date.now()}&r=${Math.random()}`, (err, data) => {
            if (err) { res.writeHead(500); res.end('Error: ' + err.message); return; }
            res.writeHead(200, {
                'Content-Type':                'text/plain; charset=utf-8',
                'Cache-Control':               'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(data);
        });
        return;
    }

    // ── 정적 파일 서빙 ──
    const filePath    = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
    const contentType = MIME[path.extname(filePath)] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
