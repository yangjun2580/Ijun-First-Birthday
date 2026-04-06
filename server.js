const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT      = 8080;
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

// ═══════════════════════════════════════════════════════════════
// 장거리상 - 위치 데이터 저장 & SSE 클라이언트 관리
// ═══════════════════════════════════════════════════════════════

// 이벤트 당일 메모리에 저장 (서버 재시작 시 초기화)
const locationStore = [];
const sseClients    = new Set();
const CAR_TYPES     = ['red','blue','yellow','green','pink'];

// SSE 전체 브로드캐스트
function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); }
        catch (e) { sseClients.delete(client); }
    }
}

// ── Nominatim 서버사이드 지오코딩 (주소 → 위도/경도) ──────────
function geocode(address) {
    return new Promise((resolve) => {
        const q   = encodeURIComponent(address + ' 한국');
        const opt = {
            hostname: 'nominatim.openstreetmap.org',
            path:     `/search?q=${q}&format=json&limit=1&countrycodes=kr&accept-language=ko`,
            method:   'GET',
            headers:  { 'User-Agent': 'Ijun-Birthday-Event/1.0' },
        };
        const req = https.request(opt, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try {
                    const json = JSON.parse(d);
                    if (json.length > 0) {
                        resolve({ lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) });
                    } else { resolve(null); }
                } catch(e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

// ── 리다이렉트 추적 fetch (구글 시트용) ──────────────────────────
function fetchWithRedirect(url, cb, redirectCount = 0) {
    if (redirectCount > 5) { cb(new Error('Too many redirects')); return; }
    const parsed = new URL(url);
    const opt = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache', 'User-Agent': 'Mozilla/5.0' },
    };
    const req = https.request(opt, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume();
            fetchWithRedirect(r.headers.location, cb, redirectCount + 1);
            return;
        }
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => cb(null, d));
    });
    req.on('error', err => cb(err));
    req.end();
}

// ── JSON body 파싱 헬퍼 ──────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
        });
    });
}

// ── CORS preflight 헬퍼 ─────────────────────────────────────────
function setCORS(res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Secret');
}

// ═══════════════════════════════════════════════════════════════
// HTTP 서버
// ═══════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
    setCORS(res);

    // preflight
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    // ── GET /api/votes : 구글 시트 투표 데이터 ───────────────────
    if (url === '/api/votes' && req.method === 'GET') {
        fetchWithRedirect(`${SHEET_URL}&t=${Date.now()}&r=${Math.random()}`, (err, data) => {
            if (err) { res.writeHead(500); res.end('Error: ' + err.message); return; }
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            res.end(data);
        });
        return;
    }

    // ───────────────────────────────────────────────────────────
    // 장거리상 API
    // ───────────────────────────────────────────────────────────

    // ── GET /api/locations : 현재 저장된 전체 위치 목록 ──────────
    if (url === '/api/locations' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(locationStore));
        return;
    }

    // ── GET /api/location-stream : SSE 실시간 스트림 ─────────────
    //    distance.html이 여기에 연결해서 새 손님을 실시간으로 받음
    if (url === '/api/location-stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
        });
        // 재연결 간격 3초
        res.write('retry: 3000\n\n');
        // 현재 전체 목록 먼저 전송 (페이지 새로고침 시 복원)
        res.write(`event: init\ndata: ${JSON.stringify(locationStore)}\n\n`);

        sseClients.add(res);
        console.log(`[SSE] 클라이언트 연결 (총 ${sseClients.size}명)`);
        req.on('close', () => {
            sseClients.delete(res);
            console.log(`[SSE] 클라이언트 해제 (총 ${sseClients.size}명)`);
        });
        return;
    }

    // ── POST /api/location : n8n에서 새 손님 위치 전송 ──────────
    //
    //  n8n 워크플로우 설정:
    //  1. 카카오톡 채널 Webhook 트리거
    //  2. 메시지에서 이름/주소 파싱 (Function 노드)
    //     예) 메시지: "장거리 홍길동 부산시 해운대구"
    //         → name: "홍길동", address: "부산시 해운대구"
    //  3. HTTP Request 노드
    //     Method: POST
    //     URL: https://ijun-first.plantynet.kr/api/location
    //     Body (JSON):
    //       {
    //         "name":    "홍길동",       // 카카오톡 발신자명 or 파싱된 이름
    //         "address": "부산시 해운대구" // 카카오톡 메시지에서 파싱한 주소
    //       }
    //
    if (url === '/api/location' && req.method === 'POST') {
        let body;
        try { body = await parseBody(req); }
        catch (e) { res.writeHead(400); res.end('Invalid JSON'); return; }

        const name    = (body.name    || '').trim();
        const address = (body.address || body.addr || '').trim();

        if (!name || !address) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'name과 address 필드가 필요합니다' }));
            return;
        }

        console.log(`[위치] 수신: ${name} / ${address}`);

        // 서버사이드 지오코딩
        const coords = await geocode(address);
        if (!coords) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: '주소를 찾을 수 없습니다: ' + address }));
            return;
        }

        // 자동차 타입 순환 배정
        const carType = CAR_TYPES[locationStore.length % CAR_TYPES.length];
        const entry   = { id: Date.now(), name, address, lat: coords.lat, lng: coords.lng, carType };
        locationStore.push(entry);

        console.log(`[위치] 저장: ${name} → (${coords.lat}, ${coords.lng}) / ${carType}`);

        // 모든 SSE 클라이언트에 실시간 push
        broadcast('new-location', entry);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: entry }));
        return;
    }

    // ── DELETE /api/locations : 전체 초기화 (이벤트 리셋용) ─────
    if (url === '/api/locations' && req.method === 'DELETE') {
        locationStore.length = 0;
        broadcast('reset', {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // ── 정적 파일 서빙 ───────────────────────────────────────────
    const filePath    = path.join(DIR, req.url === '/' ? 'index.html' : url);
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
