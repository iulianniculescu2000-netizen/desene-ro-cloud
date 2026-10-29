const http = require('http');
const https = require('https');

function fetchUrlBuffer(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('Too many redirects'));
        // Redirect-urile relative se rezolva fata de URL-ul curent (nu mereu archive.org)
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(fetchUrlBuffer(nextUrl, headers, redirects + 1));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

async function fetchUrl(url, headers = {}) {
  const buf = await fetchUrlBuffer(url, headers);
  return buf.toString('utf8');
}

module.exports = { fetchUrlBuffer, fetchUrl };
