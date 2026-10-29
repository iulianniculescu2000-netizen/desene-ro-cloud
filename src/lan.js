const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { fetchUrlBuffer } = require('./http');

// Acces de pe TV (sau alt dispozitiv din casa): Stremio accepta addon-uri din retea doar pe HTTPS de incredere.
// local-ip.sh ofera nume de tip 192-168-8-127.local-ip.sh (care duc la IP-ul local) si un certificat valid
// pentru ele, publicat gratuit; serverul il descarca si il reimprospateaza singur.
const HTTPS_PORT = 7016;
const CERT_DIR = path.join(__dirname, '..', 'cert');
const CERT_FILE = path.join(CERT_DIR, 'server.pem');
const KEY_FILE = path.join(CERT_DIR, 'server.key');
const RENEW_DAYS_LEFT = 20; // certificatul se reia cand mai are mai putin de 20 de zile

// IP-ul PC-ului in reteaua de acasa (192.168.x.x / 10.x.x.x / 172.16-31.x.x)
function getLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

function lanHost() {
  const ip = getLanIp();
  return ip ? `${ip.replace(/\./g, '-')}.local-ip.sh` : null;
}

function lanManifestUrl() {
  const host = lanHost();
  return host ? `https://${host}:${HTTPS_PORT}/manifest.json` : null;
}

// Cereri venite chiar de pe PC (pagina de configurare contine passkey-ul FileList, nu o aratam altor dispozitive)
function isLocalRequest(req) {
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (addr === '127.0.0.1' || addr === '::1') return true;
  return Object.values(os.networkInterfaces()).some(list => (list || []).some(a => a.address === addr));
}

function certDaysLeft() {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(CERT_FILE));
    return (new Date(cert.validTo) - Date.now()) / 86400000;
  } catch (e) {
    return -1;
  }
}

async function ensureCert() {
  if (certDaysLeft() > RENEW_DAYS_LEFT && fs.existsSync(KEY_FILE)) return false;
  const [cert, key] = await Promise.all([
    fetchUrlBuffer('https://local-ip.sh/server.pem'),
    fetchUrlBuffer('https://local-ip.sh/server.key')
  ]);
  if (!/BEGIN CERTIFICATE/.test(cert.toString()) || !/PRIVATE KEY/.test(key.toString())) {
    throw new Error('certificat local-ip.sh invalid');
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CERT_FILE, cert);
  fs.writeFileSync(KEY_FILE, key);
  return true;
}

// Porneste serverul HTTPS pentru retea; verifica zilnic certificatul si il schimba fara repornire
async function startLanServer(handler) {
  try {
    await ensureCert();
  } catch (e) {
    console.error('TV/retea: nu am putut lua certificatul HTTPS:', e.message);
    return;
  }
  const server = https.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, handler);
  server.on('error', e => console.error('TV/retea: serverul HTTPS nu a pornit:', e.message));
  server.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`Pentru PC + TV instaleaza in Stremio: ${lanManifestUrl()}`);
  });

  setInterval(async () => {
    try {
      if (await ensureCert()) {
        server.setSecureContext({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) });
        console.log('TV/retea: certificat HTTPS reimprospatat');
      }
    } catch (e) {}
  }, 24 * 3600 * 1000);
}

module.exports = { startLanServer, lanManifestUrl, isLocalRequest };
