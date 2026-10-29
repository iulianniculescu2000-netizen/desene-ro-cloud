const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../config');

// ===================== qBittorrent (descarcare FileList in fundal) =====================
// FileList accepta doar clienti aprobati (qBittorrent / uTorrent), nu motorul de torrent din Stremio.
// Addon-ul comanda qBittorrent prin Web UI: adauga torrentul, descarca doar episodul ales, in ordine,
// serveste fisierul catre Stremio pe masura ce se descarca, apoi il sterge dupa seed.
const QBT_CATEGORY = 'desene-ro';

const DOWNLOAD_DIR = path.join(process.env.LOCALAPPDATA || path.join(__dirname, '..', '..'), 'StremioDeseneRO', 'descarcari');

const SEED_RATIO = 1.0; // dupa ratio 1.0 ...

const SEED_HOURS = 48; // ... sau 48h de seed torrentul se sterge (ca sa nu primesti hit & run pe FileList)

const ABANDON_HOURS = 24; // episod inceput si lasat neterminat -> sters dupa 24h fara redare

const flTorrentsByHash = new Map(); // infoHash -> torrent FileList (pentru download_link)

const lastPlayed = new Map(); // infoHash -> ultima citire din fisier (ms)

let qbtCookie = '';

function qbtBase() {
  return (loadConfig().qbtUrl || 'http://127.0.0.1:8080').replace(/\/$/, '');
}

async function qbtLogin() {
  const cfg = loadConfig();
  const res = await fetch(`${qbtBase()}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: qbtBase() },
    body: new URLSearchParams({ username: cfg.qbtUser || '', password: cfg.qbtPass || '' })
  });
  const text = await res.text();
  // qBittorrent 4 trimite "SID=...", qBittorrent 5 trimite "QBT_SID_<port>=..."
  const sid = (res.headers.get('set-cookie') || '').match(/\w*SID\w*=[^;]+/);
  if (sid) qbtCookie = sid[0];
  if (!/ok/i.test(text) && !sid) throw new Error('Login qBittorrent esuat (verifica utilizatorul/parola din /configure)');
}

// Cerere catre Web API-ul qBittorrent; la 403 se logheaza si reincearca o data
async function qbtApi(endpoint, form, retry = true) {
  const opts = { headers: { Referer: qbtBase(), Cookie: qbtCookie } };
  if (form) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form);
  }
  const res = await fetch(`${qbtBase()}/api/v2/${endpoint}`, opts);
  if (res.status === 403 && retry) {
    await qbtLogin();
    return qbtApi(endpoint, form, false);
  }
  if (!res.ok) throw new Error(`qBittorrent ${endpoint}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// qBittorrent invizibil: pornit minimizat in tray, fara fereastra de pornire si fara notificari Windows
// ("Torrent adaugat" / "Descarcare finalizata"). Se scrie in qBittorrent.ini doar cat qBittorrent e oprit
// (la iesire isi rescrie fisierul), deci inainte de fiecare pornire facuta de addon
const QBT_INI = path.join(process.env.APPDATA || '', 'qBittorrent', 'qBittorrent.ini');
const QBT_HIDDEN = {
  Preferences: { 'General\\StartMinimized': 'true', 'General\\MinimizeToTray': 'true', 'General\\CloseToTray': 'true', 'General\\NoSplashScreen': 'true', 'General\\SystemTrayEnabled': 'true' },
  GUI: { 'Notifications\\Enabled': 'false', 'Notifications\\TorrentAdded': 'false' }
};

function hideQbtInterface() {
  let lines;
  try {
    lines = fs.readFileSync(QBT_INI, 'utf8').split(/\r?\n/);
  } catch (e) {
    return; // qBittorrent inca nu a fost pornit niciodata
  }
  for (const [section, keys] of Object.entries(QBT_HIDDEN)) {
    let start = lines.indexOf(`[${section}]`);
    if (start < 0) {
      lines.push('', `[${section}]`);
      start = lines.length - 1;
    }
    for (const [key, value] of Object.entries(keys)) {
      let end = lines.findIndex((l, i) => i > start && l.startsWith('['));
      if (end < 0) end = lines.length;
      const at = lines.findIndex((l, i) => i > start && i < end && l.startsWith(`${key}=`));
      if (at >= 0) lines[at] = `${key}=${value}`;
      else lines.splice(start + 1, 0, `${key}=${value}`);
    }
  }
  fs.writeFileSync(QBT_INI, lines.join('\r\n'), 'utf8');
}

// Porneste qBittorrent ascuns (fara fereastra) daca nu ruleaza deja
async function ensureQbt() {
  try {
    await qbtApi('app/version');
    return;
  } catch (e) {
    if (!/fetch failed|ECONNREFUSED/i.test(String(e.cause || e.message))) throw e;
  }
  try {
    hideQbtInterface();
  } catch (e) {}
  const exe = loadConfig().qbtPath || 'C:\\Program Files\\qBittorrent\\qbittorrent.exe';
  spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      await qbtApi('app/version');
      return;
    } catch (e) {}
  }
  throw new Error('qBittorrent nu a pornit (Web UI activ pe ' + qbtBase() + '?)');
}

async function qbtTorrent(hash) {
  const list = await qbtApi(`torrents/info?hashes=${hash}`);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

// Adauga torrentul (daca nu exista) si lasa la descarcat doar fisierul episodului, in ordine
async function qbtPrepare(hash, fileIdx) {
  await ensureQbt();
  let existing = await qbtTorrent(hash);
  if (!existing) {
    const t = flTorrentsByHash.get(hash);
    if (!t) throw new Error('Torrent necunoscut (redeschide lista de stream-uri a episodului)');
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    await qbtApi('torrents/add', {
      urls: t.download_link,
      savepath: DOWNLOAD_DIR,
      category: QBT_CATEGORY,
      stopped: 'true',
      paused: 'true',
      sequentialDownload: 'true',
      firstLastPiecePrio: 'true'
    });
    for (let i = 0; i < 20 && !existing; i++) {
      await sleep(500);
      existing = await qbtTorrent(hash);
    }
    if (!existing) throw new Error('qBittorrent nu a adaugat torrentul');
  }

  // lista de fisiere poate fi goala cateva clipe dupa adaugare
  let files = [];
  for (let i = 0; i < 20 && files.length === 0; i++) {
    files = await qbtApi(`torrents/files?hash=${hash}`);
    if (files.length === 0) await sleep(500);
  }
  // doar episodul cerut ramane de descarcat (piesele deja descarcate din alte episoade raman la seed).
  // Intai se selecteaza episodul nou, abia apoi se deselecteaza cel vechi: altfel torrentul ramane o clipa fara
  // nimic de descarcat, partenerii ne scot din coada ("not interested") si episodul nou porneste abia dupa 30-60 s
  // prioritate normala (1), nu maxima: altfel "primele/ultimele piese intai" nu mai are efect si
  // inceputul episodului ajunge ultimul; optiunea se reaplica pe fisierul ramas selectat (off -> on)
  await qbtApi('torrents/filePrio', { hash, id: String(fileIdx), priority: '1' });
  const others = files.filter(f => f.index !== fileIdx && f.priority > 0).map(f => f.index);
  if (others.length > 0) await qbtApi('torrents/filePrio', { hash, id: others.join('|'), priority: '0' });
  const info = await qbtTorrent(hash);
  if (info && info.f_l_piece_prio) await qbtApi('torrents/toggleFirstLastPiecePrio', { hashes: hash });
  await qbtApi('torrents/toggleFirstLastPiecePrio', { hashes: hash });
  await qbtApi('torrents/start', { hashes: hash }).catch(() => qbtApi('torrents/resume', { hashes: hash }));
  // la schimbarea episodului viteza cadea la zero ~30 s pana cereau partenerii noile piese: reannunt la tracker
  await qbtApi('torrents/reannounce', { hashes: hash }).catch(() => {});
  return files;
}

const VIDEO_TYPES = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };

// Serveste fisierul episodului din folderul qBittorrent, asteptand piesele care inca se descarca
async function handleFileListPlay(req, res, hash, fileIdx) {
  let files, props;
  try {
    files = await qbtPrepare(hash, fileIdx);
    props = await qbtApi(`torrents/properties?hash=${hash}`);
  } catch (e) {
    console.error('FileList/qBittorrent:', e.message);
    res.statusCode = 503;
    return res.end(e.message);
  }

  const file = files.find(f => f.index === fileIdx);
  if (!file) {
    res.statusCode = 404;
    return res.end('Fisier inexistent in torrent');
  }
  const offset = files.filter(f => f.index < fileIdx).reduce((sum, f) => sum + f.size, 0);
  const pieceSize = props.piece_size;
  const filePath = path.join(props.save_path, file.name);
  const size = file.size;

  let start = 0;
  let end = size - 1;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && range[1]) {
    start = parseInt(range[1], 10);
    if (range[2]) end = Math.min(parseInt(range[2], 10), size - 1);
  } else if (range && range[2]) {
    // "bytes=-N" = ultimii N bytes (playerele citesc asa indexul de la finalul fisierului)
    start = Math.max(0, size - parseInt(range[2], 10));
  }
  if (start > end || start >= size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.end();
  }

  let closed = false;
  req.on('close', () => (closed = true));

  // Asteapta pana cand piesele care acopera [a, b] din fisier sunt descarcate (pieceStates: 2 = descarcata)
  async function waitForBytes(a, b, maxTries = 600) {
    const first = Math.floor((offset + a) / pieceSize);
    const last = Math.floor((offset + b) / pieceSize);
    for (let tries = 0; !closed && tries < maxTries; tries++) {
      const states = await qbtApi(`torrents/pieceStates?hash=${hash}`);
      let ready = true;
      for (let p = first; p <= last; p++) {
        if (states[p] !== 2) {
          ready = false;
          break;
        }
      }
      if (ready) return true;
      await sleep(tries < 10 ? 300 : 1000);
    }
    return false;
  }

  // Finalul fisierului (indexul .mkv / .mp4 pe care playerul il citeste inainte sa porneasca) vine ultimul, de la un
  // singur partener, uneori dupa 40-75 s: daca nu e gata in ~4 s raspundem "indisponibil", iar playerul porneste de la
  // inceput fara index (derularea merge mai incet pana se descarca si finalul)
  if (start > 0 && start >= size - 2 * pieceSize && !(await waitForBytes(start, end, 10))) {
    res.statusCode = 503;
    res.setHeader('Retry-After', '30');
    return res.end();
  }

  res.statusCode = range ? 206 : 200;
  res.setHeader('Content-Type', VIDEO_TYPES[path.extname(file.name).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', end - start + 1);
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  if (req.method === 'HEAD') return res.end();

  const CHUNK = 2 * 1024 * 1024;
  let fd;
  try {
    for (let pos = start; pos <= end && !closed; ) {
      const chunkEnd = Math.min(end, pos + CHUNK - 1);
      if (!(await waitForBytes(pos, chunkEnd))) break;
      // piesele comune cu episodul vecin stau intai in fisierul .parts al qBittorrent; fisierul episodului apare putin dupa
      for (let tries = 0; !fd && !closed && tries < 60; tries++) {
        try {
          fd = await fs.promises.open(filePath, 'r');
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          await sleep(1000);
        }
      }
      if (!fd) break;
      const buf = Buffer.alloc(chunkEnd - pos + 1);
      const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      lastPlayed.set(hash, Date.now());
      if (!res.write(buf.subarray(0, bytesRead))) await new Promise(r => res.once('drain', r));
      pos += bytesRead;
    }
  } catch (e) {
    console.error('Redare FileList:', e.message);
  } finally {
    if (fd) await fd.close();
    res.end();
  }
}

// Curatenie la 10 minute: sterge (cu fisiere) torrentele vazute dupa seed suficient si pe cele abandonate
async function cleanupFileListDownloads() {
  let list;
  try {
    list = await qbtApi(`torrents/info?category=${QBT_CATEGORY}`);
  } catch (e) {
    return; // qBittorrent nu ruleaza / nu e configurat
  }
  const now = Date.now();
  const deleteRightAway = loadConfig().deleteRightAway; // optiune din /configure: fara seed (risc hit & run)
  for (const t of list) {
    const last = lastPlayed.get(t.hash) || (t.completion_on > 0 ? t.completion_on : t.added_on) * 1000;
    const idleHours = (now - last) / 3600000;
    const seeded = deleteRightAway || t.ratio >= SEED_RATIO || t.seeding_time >= SEED_HOURS * 3600;
    const done = t.progress >= 1;
    if ((done && seeded && idleHours >= 1) || (!done && idleHours >= ABANDON_HOURS)) {
      try {
        await qbtApi('torrents/delete', { hashes: t.hash, deleteFiles: 'true' });
        lastPlayed.delete(t.hash);
        console.log(`Sters din qBittorrent: ${t.name} (ratio ${t.ratio.toFixed(2)})`);
      } catch (e) {}
    }
  }
}
setInterval(cleanupFileListDownloads, 10 * 60 * 1000);

module.exports = { flTorrentsByHash, handleFileListPlay, qbtApi, ensureQbt };
