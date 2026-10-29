const http = require('http');
const { PORT, CLOUD, loadConfig, saveConfig } = require('./src/config');
const { cache } = require('./src/cache');
const { CARTOONS } = require('./src/desene');
const { getEpisodeSource } = require('./src/catalog');
const { getEpisodesForCartoon } = require('./src/surse/archive');
const { getDozaAnimataStreams, loadDozaCatalog } = require('./src/surse/dozaanimata');
const { getOkRuStreams } = require('./src/surse/okru');
const { getTorrentioRoStreams } = require('./src/surse/torrentio');
const { startLanServer, lanManifestUrl, isLocalRequest } = require('./src/lan');
const { proxyUrl, handleHlsProxy } = require('./src/hlsproxy');
// FileList / qBittorrent doar pe PC (in cloud nu se incarca deloc, nici curatenia lor la 10 minute)
const { searchFileListStreams } = CLOUD ? {} : require('./src/surse/filelist');
const { handleFileListPlay } = CLOUD ? {} : require('./src/surse/qbittorrent');

// Mod „doar FileList” pe PC (config.json: "doarFileList": true), langa addon-ul din cloud: alt id de addon,
// stream-uri doar FileList pentru desenele din catalogul din cloud (ro_) si un catalog propriu pentru desenele cu
// torrente FileList (rofl_, cu numerotarea din torrente, diferita de cea din cloud). Se citeste la pornire.
const FL_ONLY = !CLOUD && (process.env.DESENE_DOAR_FILELIST === '1' || !!loadConfig().doarFileList);
const toCartoonId = id => id.replace(/^rofl_/, 'ro_');

// Adresa vazuta de dispozitiv (PC, TV): in cloud serverul sta in spatele Caddy (HTTPS), care trimite X-Forwarded-Proto
const baseUrlOf = req =>
  `${req.socket.encrypted ? 'https' : (CLOUD && req.headers['x-forwarded-proto']) || 'http'}://${req.headers.host}`;

const MANIFEST = {
  id: 'org.stremio.desene.vechi.ro.fl',
  version: '3.3.0',
  name: 'Desene',
  description: 'Desene Dublate în Română (1990-2010 CN, Fox Kids, Jetix) prin FileList RoDubbed HD + Archive.org.',
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'desene_ro_toate',
      name: 'Desene',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    },
    {
      type: 'series',
      id: 'desene_ro_doza',
      name: 'Mai multe desene (DozaAnimata)',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    },
    {
      type: 'series',
      id: 'desene_ro_jetix',
      name: 'Jetix / Fox Kids',
      extra: [{ name: 'search', isRequired: false }]
    },
    {
      type: 'series',
      id: 'desene_ro_cn',
      name: 'Cartoon Network',
      extra: [{ name: 'search', isRequired: false }]
    }
  ],
  resources: ['catalog', 'meta', 'stream'],
  idPrefixes: ['ro_'],
  behaviorHints: {
    configurable: true
  }
};
if (FL_ONLY) {
  Object.assign(MANIFEST, {
    id: 'org.stremio.desene.ro.filelist.pc',
    name: 'Desene FileList (PC)',
    description: 'Torrente RoDubbed de pe FileList, prin qBittorrent de pe PC (doar cand PC-ul e pornit).',
    catalogs: [
      {
        type: 'series',
        id: 'desene_ro_filelist',
        name: 'Desene FileList (PC)',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
      }
    ],
    resources: [
      'catalog',
      { name: 'meta', types: ['series'], idPrefixes: ['rofl_'] },
      { name: 'stream', types: ['series'], idPrefixes: ['ro_', 'rofl_'] }
    ],
    idPrefixes: ['ro_', 'rofl_']
  });
}

// Text pentru cautare: litere mici, fara diacritice (ș/ş, ț/ţ, ă, â, î) si fara punctuatie ("W.I.T.C.H." -> "w i t c h")
const normalizeText = s =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Valori puse in atribute HTML (parolele pot contine ghilimele)
const escAttr = v => String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const CONFIG_HTML = (cfg, savedMsg = '') => `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8">
  <title>Configurare FileList - Desene Vechi RO Stremio</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 32px; border-radius: 16px; width: 100%; max-width: 480px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); border: 1px solid #334155; }
    h1 { margin-top: 0; font-size: 22px; color: #38bdf8; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; }
    label { display: block; margin-top: 16px; margin-bottom: 6px; font-weight: 600; font-size: 14px; }
    input[type="text"], input[type="password"] { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 14px; box-sizing: border-box; }
    .btn { margin-top: 24px; width: 100%; padding: 12px; border: none; border-radius: 8px; background: #0284c7; color: white; font-weight: 700; font-size: 15px; cursor: pointer; }
    .btn:hover { background: #0369a1; }
    .btn-stremio { display: block; text-align: center; text-decoration: none; background: #7c3aed; margin-top: 12px; }
    .success { background: #065f46; color: #a7f3d0; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    .check { display: flex; gap: 8px; align-items: center; font-weight: 600; }
    .note { font-size: 12px; margin: 6px 0 0; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #fde047; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🇷🇴 Desene Vechi RO + FileList HD</h1>
    ${savedMsg ? `<div class="success">${savedMsg}</div>` : ''}
    <p>Conectează-ți contul de <b>FileList.io</b> pentru a reda direct în Stremio pachetele <b>RoDubbed (720p/1080p/DVDRip)</b> din categoria Desene, fără rezultatele în engleză de pe Torrentio!</p>
    <form method="POST" action="/configure">
      <label>Username FileList:</label>
      <input type="text" name="flUser" value="${escAttr(cfg.flUser)}" placeholder="ex: utilizatorul_tau" required />
      <label>Passkey FileList (îl găsești pe FileList -> Profile):</label>
      <input type="password" name="flPasskey" value="${escAttr(cfg.flPasskey)}" placeholder="Cheia de 32 de caractere din profilul FileList" required />
      <label class="check"><input type="checkbox" name="useFileList" ${cfg.useFileList ? 'checked' : ''} /> Descarcă automat din FileList prin qBittorrent</label>
      <p class="note">qBittorrent pornește ascuns, descarcă doar episodul ales și îl redă în Stremio cât se descarcă. După ratio 1.0 sau 48h de seed, torrentul se șterge singur, cu tot cu fișier.</p>
      <label class="check"><input type="checkbox" name="deleteRightAway" ${cfg.deleteRightAway ? 'checked' : ''} /> Șterge imediat după vizionare (fără seed)</label>
      <p class="note">Episodul se șterge la o oră după ce l-ai văzut. Atenție: fără seed, FileList poate da avertismente hit &amp; run.</p>
      <label>Utilizator Web UI qBittorrent:</label>
      <input type="text" name="qbtUser" value="${escAttr(cfg.qbtUser)}" placeholder="din qBittorrent → Opțiuni → Web UI" />
      <label>Parolă Web UI qBittorrent:</label>
      <input type="password" name="qbtPass" value="${escAttr(cfg.qbtPass)}" placeholder="parola setată în Web UI" />
      <label>Adresă Web UI qBittorrent:</label>
      <input type="text" name="qbtUrl" value="${escAttr(cfg.qbtUrl || 'http://127.0.0.1:8080')}" />
      <button type="submit" class="btn">💾 Salvează Configurarea FileList</button>
    </form>
    <!-- linkul stremio:// pierde portul si trece pe https, asa ca adresa se copiaza si se lipeste in Stremio -->
    ${lanManifestUrl() ? `<button type="button" class="btn btn-stremio" onclick="navigator.clipboard.writeText('${lanManifestUrl()}').then(() => (this.textContent = '✅ Copiat! Lipește-l în bara de căutare din Stremio'))">📋 Copiază linkul pentru PC + TV</button>
    <p class="note" style="text-align:center;">Recomandat: merge pe PC și, prin același cont Stremio, pe televizorul din casă.<br><code>${lanManifestUrl()}</code></p>` : ''}
    <button type="button" class="btn btn-stremio" style="background:#475569" onclick="navigator.clipboard.writeText('http://127.0.0.1:${PORT}/manifest.json').then(() => (this.textContent = '✅ Copiat!'))">📋 Copiază linkul doar pentru acest PC</button>
    <p style="margin-top:16px; text-align:center; font-size:12px;">Instalare: lipește linkul în bara „Search or paste link” din Stremio.</p>
  </div>
</body>
</html>`;

// Acelasi handler pentru PC (http://127.0.0.1) si pentru retea / TV (https://<ip>.local-ip.sh)
async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const url = decodeURIComponent(req.url.split('?')[0]);

  // Adresa simpla deschisa din browser duce la pagina de configurare (Stremio cere /manifest.json)
  if (url === '/' && /text\/html/.test(req.headers.accept || '')) {
    res.statusCode = 302;
    res.setHeader('Location', '/configure');
    return res.end();
  }

  if (url === '/configure' && CLOUD) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(`Addon-ul Desene (server in cloud). Instalare in Stremio: ${baseUrlOf(req)}/manifest.json`);
  }

  if (url === '/configure' && !isLocalRequest(req)) {
    res.statusCode = 403;
    return res.end('Configurarea se face doar de pe PC-ul pe care ruleaza serverul.');
  }

  if (url === '/configure') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const cfg = {
          flUser: (params.get('flUser') || '').trim(),
          flPasskey: (params.get('flPasskey') || '').trim(),
          onlyRoDub: true,
          useFileList: params.get('useFileList') === 'on',
          deleteRightAway: params.get('deleteRightAway') === 'on',
          qbtUser: (params.get('qbtUser') || '').trim(),
          qbtPass: params.get('qbtPass') || '',
          qbtUrl: (params.get('qbtUrl') || 'http://127.0.0.1:8080').trim()
        };
        saveConfig(cfg);
        cache.clear();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(CONFIG_HTML(cfg, '✅ Contul FileList a fost salvat! Acum poți deschide orice desen în Stremio.'));
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(CONFIG_HTML(loadConfig()));
  }

  // Redare FileList prin qBittorrent: /fl/play/<infoHash>/<fileIdx>
  const playMatch = url.match(/^\/fl\/play\/([0-9a-f]{40})\/(\d+)$/);
  if (playMatch && !CLOUD) {
    return handleFileListPlay(req, res, playMatch[1], parseInt(playMatch[2], 10));
  }

  // Releu (Vidmoly; in cloud si OK.ru / Sendvid): /hlsp/<semnatura>/<url base64url>.m3u8 / .ts / .mp4
  const hlsMatch = url.match(/^\/hlsp\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.(m3u8|ts|mp4)$/);
  if (hlsMatch) {
    return handleHlsProxy(req, res, hlsMatch[1], hlsMatch[2], hlsMatch[3], baseUrlOf(req));
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (url === '/' || url === '/manifest.json') {
    return res.end(JSON.stringify(MANIFEST));
  }

  // Catalog route (cu suport de Search direct pe Catalog + FileList Desene!)
  if (url.startsWith('/catalog/series/')) {
    // extra-urile vin codate in cale: /catalog/series/<id>/search=avatar%20legenda&skip=100.json (citite din URL-ul brut,
    // ca un "/" sau "." din cautare sa nu taie textul)
    const extraMatch = req.url.split('?')[0].match(/^\/catalog\/series\/[^/]+\/(.+)\.json$/);
    const extra = new URLSearchParams(extraMatch ? extraMatch[1] : '');
    const skip = parseInt(extra.get('skip') || '0', 10) || 0;
    const searchQuery = (extra.get('search') || '').trim();

    // Doar desenele care au cel putin o sursa dublata redabila (DozaAnimata / Archive.org / YouTube / blog / Torrentio),
    // plus cele cu torrent RoDubbed verificat pe FileList (fileList: true), cand FileList e activat.
    // doodOnly: pe DozaAnimata episoadele sunt doar pe servere Doodstream (link protejat cu token), pe care addon-ul nu le poate reda
    const cfg = loadConfig();
    let list = CARTOONS.filter(
      c =>
        (c.dozaSlug && !c.doodOnly) ||
        c.archiveId ||
        c.torrentio ||
        c.ytPlaylists ||
        c.ytVideos ||
        c.ytMarathons ||
        c.blogPosts ||
        c.okVideos ||
        (cfg.useFileList && c.fileList)
    );
    if (FL_ONLY) {
      list = CARTOONS.filter(c => c.fileList && cfg.useFileList).map(c => ({
        ...c,
        id: c.id.replace(/^ro_/, 'rofl_'),
        name: `${c.name.replace(/ \(Dublat RO\)$/, '')} (FileList)`
      }));
    } else if (url.includes('desene_ro_doza')) {
      list = list.filter(c => c.network === 'DozaAnimata');
    } else if (url.includes('desene_ro_jetix')) {
      list = list.filter(c => c.network.includes('Fox Kids') || c.network.includes('Jetix'));
    } else if (url.includes('desene_ro_cn')) {
      list = list.filter(c => c.network.includes('Cartoon Network') || c.network.includes('Boomerang'));
    }

    // Cautarea ramane in catalogul propriu (inainte adauga orice serial din Cinemeta, nedublat, marcat "Dublat RO")
    // Potrivire pe cuvinte, fara diacritice si punctuatie: "avatar legenda" -> "Avatar: Legenda lui Aang"
    // fiecare cuvant cautat = inceputul unui cuvant din nume ("x men" nu mai gaseste "the MENace");
    // cu litere izolate ("w.i.t.c.h", "x men") se cauta doar lipit: "witch", "xmen"
    if (searchQuery) {
      const query = normalizeText(searchQuery);
      const compact = query.replace(/ /g, '');
      const words = query.split(' ').filter(Boolean);
      const lettersOnly = words.some(w => w.length === 1);
      list = list.filter(c => {
        const text = normalizeText([c.name, ...c.searchTerms].join(' '));
        if (text.replace(/ /g, '').includes(compact)) return true;
        return !lettersOnly && words.every(w => ` ${text}`.includes(` ${w}`));
      });
    }

    // Stremio cere catalogul in pagini de cate 100 (skip=100, 200...)
    const metas = list.slice(skip, skip + 100).map(c => ({
      id: c.id,
      type: 'series',
      name: c.name,
      poster: c.poster,
      description: c.description,
      releaseInfo: c.releaseInfo
    }));
    return res.end(JSON.stringify({ metas }));
  }

  // Meta route (izolat cu prefixul ro_ ca Torrentio sa nu mai bage stream-uri in engleza!)
  if (url.startsWith('/meta/series/')) {
    const rawId = url.replace('/meta/series/', '').replace('.json', '');
    const cartoon = CARTOONS.find(c => c.id === toCartoonId(rawId));
    if (!cartoon) return res.end(JSON.stringify({ meta: null }));

    const { videos } = await getEpisodeSource(cartoon);

    return res.end(
      JSON.stringify({
        meta: {
          id: rawId,
          type: 'series',
          name: cartoon.name,
          poster: cartoon.poster,
          background: cartoon.poster,
          description: cartoon.description,
          releaseInfo: cartoon.releaseInfo,
          videos: videos.map(({ ytId, okId, ...v }) => ({ ...v, id: v.id.replace(cartoon.id, rawId) }))
        }
      })
    );
  }

  // Stream route (DOAR surse in Romana: FileList RoDubbed + Archive.org Direct + Arhive Web RO)
  if (url.startsWith('/stream/series/')) {
    const rawId = url.replace('/stream/series/', '').replace('.json', '');
    const parts = rawId.split(':');
    const baseId = parts[0];
    const season = parseInt(parts[1] || '1', 10);
    const episode = parseInt(parts[2] || '1', 10);

    const cartoon = CARTOONS.find(c => c.id === toCartoonId(baseId));
    // Mod doar FileList, desen din catalogul din cloud (ro_): numai torrentele FileList; desenele cu fileList: true
    // au acolo alta numerotare (maratoane / Cinemeta), deci pe ele FileList apare doar in catalogul rofl_
    const flOnlyReq = FL_ONLY && !baseId.startsWith('rofl_');
    if (!cartoon || (flOnlyReq && cartoon.fileList)) return res.end(JSON.stringify({ streams: [] }));

    const streams = [];

    // 1. Direct Romanian Dubbed Streams from DozaAnimata (OK.ru HLS/MP4, Sendvid MP4, YouTube native)
    if (!cartoon.doodOnly && !flOnlyReq) {
      const dozaStreams = await getDozaAnimataStreams(cartoon, season, episode);
      streams.push(...dozaStreams);
    }

    // YouTube: episodul din playlisturile pe sezoane / maratonul, redat nativ de Stremio (ytId)
    const { source, videos } = await getEpisodeSource(cartoon);
    const ytVideo = videos.find(v => v.ytId && v.season === season && v.episode === episode);
    if (ytVideo && !flOnlyReq) {
      streams.push({
        name: '🇷🇴 YouTube RO',
        title: `${ytVideo.title}\n📺 Redare Directă în Stremio (Dublat în Română)`,
        ytId: ytVideo.ytId
      });
    }

    // Blogul deseneledublate7: episodul OK.ru din postarea sezonului
    const okVideo = videos.find(v => v.okId && v.season === season && v.episode === episode);
    if (okVideo && !flOnlyReq) streams.push(...(await getOkRuStreams(okVideo.okId, `${cartoon.name} - S${season}E${episode}`)));

    // 2. Direct Archive.org Romanian Dubbed Stream (doar cand lista de episoade vine din arhiva, ca numerotarea sa corespunda)
    if (source === 'archive' && !flOnlyReq) {
      const episodes = await getEpisodesForCartoon(cartoon);
      const ep = episodes.find(e => e.season === season && e.epNumber === episode);
      if (ep) {
        streams.push({
          name: '🇷🇴 Arhiva RO (Direct)',
          title: `${ep.title}\n📺 Dublat în Română (${cartoon.network} Direct Stream)`,
          url: ep.url
        });
      }
    }

    // Maratoanele (sezonul 0, sau sezonul 1 cand sunt singura lista) nu au corespondent in numerotarea torrentelor
    const isMarathon = source === 'marathon' || (season === 0 && !!ytVideo);

    // Torrente publice RoDubbed prin Torrentio (redate direct de Stremio)
    // Doar desenele marcate "torrentio": true (scanare pe tot catalogul), ca sa nu fortam limita de cereri
    if (cartoon.torrentio && !isMarathon && !flOnlyReq) streams.push(...(await getTorrentioRoStreams(cartoon, season, episode)));

    // 3. FileList RoDubbed, descarcat in fundal de qBittorrent (pornit din /configure)
    const cfg = loadConfig();
    const flReady = cfg.flUser && cfg.flPasskey && cfg.flPasskey.length === 32;
    if (flReady && cfg.useFileList && !isMarathon) {
      const flStreams = await searchFileListStreams(cartoon, season, episode, baseUrlOf(req));
      streams.push(...flStreams);
    } else if (cfg.useFileList && cfg.flPasskey && cfg.flPasskey.length !== 32) {
      streams.push({
        name: '⚠️ Passkey FileList Invalid',
        title: `Ai introdus o parolă de ${cfg.flPasskey.length} caractere în loc de Passkey-ul de 32 de caractere!\nClick aici pentru a pune Passkey-ul din profilul tău FileList.`,
        externalUrl: `http://127.0.0.1:${PORT}/configure`
      });
    }

    // 4. Direct Link to Romanian Dubbed Portal (DeseneleDublate / DozaAnimata / YouTube RO)
    const cleanTitle = cartoon.name.replace('(Dublat RO)', '').trim();
    if (!flOnlyReq) streams.push({
      name: '🌐 DeseneleDublate.com',
      title: `Deschide "${cleanTitle}" pe DeseneleDublate.com (Dublat în Română)`,
      externalUrl: `https://deseneledublate.com/?s=${encodeURIComponent( cartoon.searchTerms[cartoon.searchTerms.length - 1] )}`
    });

    // Stream-urile marcate hlsProxy (Vidmoly) trec prin releul addon-ului, la adresa vazuta de dispozitiv (PC sau TV);
    // in cloud si cele marcate relay (OK.ru HLS / MP4, Sendvid). YouTube (ytId) si Archive.org raman directe.
    const proxyBase = baseUrlOf(req);
    for (const s of streams) {
      if (s.hlsProxy || (CLOUD && s.relay)) s.url = proxyUrl(proxyBase, s.url, s.relay || 'm3u8');
      delete s.hlsProxy;
      delete s.relay;
      // "Next" / episodul urmator automat: Stremio porneste singur sursa cu acelasi bingeGroup din episodul urmator.
      // Toate sursele directe ale unui desen (Vidmoly, OK.ru, YouTube, arhiva) au acelasi grup, chiar daca episodul
      // urmator e pe alt server; torrentele (FileList / Torrentio) isi pastreaza grupul lor
      if (!s.externalUrl && !(s.behaviorHints && s.behaviorHints.bingeGroup)) {
        s.behaviorHints = { ...(s.behaviorHints || {}), bingeGroup: `desene-ro-direct-${cartoon.id}` };
      }
    }

    return res.end(JSON.stringify({ streams }));
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
}

// In cloud pe Render serverul trebuie sa asculte pe toate interfetele (HOST=0.0.0.0); pe PC doar local
http.createServer(handleRequest).listen(PORT, process.env.HOST || '127.0.0.1', () => {
  if (CLOUD) console.log(`Stremio Addon Desene RO v3.3 (mod cloud, fara FileList) pe http://127.0.0.1:${PORT}, public prin Caddy`);
  else console.log(`Stremio Addon Desene RO v3.3 (DozaAnimata + Archive + FileList/qBittorrent) running at http://127.0.0.1:${PORT}/manifest.json`);
  loadDozaCatalog();
  if (!CLOUD) startLanServer(handleRequest);
});
