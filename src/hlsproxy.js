const http = require('http');
const https = require('https');
const crypto = require('crypto');

// Releu prin addon: /hlsp/<semnatura>/<url base64url>.m3u8 (playlist rescris), .ts (bucata HLS) sau .mp4 (fisier, cu Range).
// Playerul din Stremio desktop (mpv) ramane in "se incarca" pe HLS-ul Vidmoly, desi linkul merge din orice alt program;
// servit de la addon (127.0.0.1 / LAN) porneste normal. In cloud trec pe aici si OK.ru / Sendvid: linkurile lor sunt
// legate de IP-ul care a cerut pagina (srcIp=, asn=), adica de VM, nu de televizor.
// Semnatura (HMAC) opreste folosirea releului pentru alte adrese decat cele date de addon (altfel ar fi un proxy deschis).
const SECRET = process.env.RELAY_SECRET || crypto.randomBytes(32).toString('hex');
const enc = u => Buffer.from(u).toString('base64url');
const dec = s => Buffer.from(s, 'base64url').toString('utf8');
const sign = u => crypto.createHmac('sha256', SECRET).update(u).digest('base64url').slice(0, 22);

// ext: 'm3u8' / 'mp4' / 'ts'; fara ext se deduce din cale (.m3u8 -> playlist, altfel bucata)
const proxyUrl = (baseUrl, url, ext) =>
  `${baseUrl}/hlsp/${sign(url)}/${enc(url)}.${ext || (/\.m3u8$/i.test(new URL(url).pathname) ? 'm3u8' : 'ts')}`;

// Rescrie fiecare URI din playlist (randurile fara # si atributele URI="...") catre releu
function rewritePlaylist(text, playlistUrl, baseUrl) {
  return text
    .split(/\r?\n/)
    .map(line => {
      if (line.trim() && !line.startsWith('#')) return proxyUrl(baseUrl, new URL(line.trim(), playlistUrl).toString());
      return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${proxyUrl(baseUrl, new URL(u, playlistUrl).toString())}"`);
    })
    .join('\n');
}

// Cererea catre server, cu redirect-uri urmate (MP4-urile OK.ru / Sendvid pot redirectiona)
function openUpstream(url, range, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    if (range) headers.Range = range;
    const req = client.get(url, { headers }, up => {
      if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && redirects < 5) {
        up.resume();
        return resolve(openUpstream(new URL(up.headers.location, url).toString(), range, redirects + 1));
      }
      resolve({ up, req, finalUrl: url });
    });
    req.setTimeout(30000, () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

async function handleHlsProxy(req, res, sig, token, ext, baseUrl) {
  let target;
  try {
    target = dec(token);
    if (!/^https?:\/\//.test(target) || sig !== sign(target)) throw new Error('url');
  } catch (e) {
    res.statusCode = 403;
    return res.end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  let upstream;
  try {
    upstream = await openUpstream(target, ext === 'm3u8' ? null : req.headers.range);
  } catch (e) {
    res.statusCode = 502;
    return res.end();
  }
  const { up, finalUrl } = upstream;
  req.on('close', () => upstream.req.destroy());

  // playlist (si cand un sub-playlist n-are .m3u8 in cale): rescris, ca toate bucatile sa treaca tot prin releu
  if (ext === 'm3u8' || /mpegurl/i.test(up.headers['content-type'] || '')) {
    const chunks = [];
    up.on('data', c => chunks.push(c));
    up.on('error', () => {
      res.statusCode = 502;
      res.end();
    });
    up.on('end', () => {
      if (up.statusCode >= 400) {
        res.statusCode = 502;
        return res.end();
      }
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(rewritePlaylist(Buffer.concat(chunks).toString('utf8'), finalUrl, baseUrl));
    });
    return;
  }

  // bucata video / MP4: transmisa asa cum vine (cu Range, daca playerul il cere)
  res.statusCode = up.statusCode;
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    if (up.headers[h]) res.setHeader(h, up.headers[h]);
  }
  up.pipe(res);
  up.on('error', () => res.end());
}

module.exports = { proxyUrl, handleHlsProxy };
