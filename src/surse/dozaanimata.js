const fs = require('fs');
const path = require('path');
const { cache } = require('../cache');
const { fetchUrl, fetchUrlBuffer } = require('../http');
const { CARTOONS, addCartoons } = require('../desene');
const { getOkRuStreams } = require('./okru');

// Extrage stream-uri directe (.mp4 / .m3u8) din paginile de episoade DozaAnimata (OK.ru, Sendvid, YouTube)
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };

// Episoadele fara niciun player redabil (doar Doodstream etc.), gasite de verificarea din fundal (doza-episoade.json)
const DOZA_EPISODES_FILE = path.join(__dirname, '..', '..', 'doza-episoade.json');
let deadEpisodes = new Set();

// Lista afisata: fara episoadele care n-au niciun player redabil
async function getDozaEpisodes(cartoon) {
  return (await getAllDozaEpisodes(cartoon)).filter(e => !deadEpisodes.has(e.url));
}

// Lista de episoade DozaAnimata cu sezon/episod extrase din slug:
// "...-sezonul-2-episodul-5-titlu", "...-episodul-64-titlu" (sezon unic), "...-cartea-ii-...-capitolul-3-titlu" (Avatar)
async function getAllDozaEpisodes(cartoon) {
  if (!cartoon.dozaSlug) return [];
  const listKey = `doza_eps_${cartoon.dozaSlug}`;
  if (cache.has(listKey)) return cache.get(listKey);

  let seriesHtml;
  try {
    seriesHtml = await fetchUrl(`https://www.dozaanimata.net/series/${cartoon.dozaSlug}/`);
  } catch (e) {
    return [];
  }

  const regex = /href="https:\/\/www\.dozaanimata\.net\/episode\/([^"/]+)\/?"/gi;
  const seen = new Set();
  const episodes = [];
  let m;
  while ((m = regex.exec(seriesHtml)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const sMatch = slug.match(/-sezonul-(\d+)-/) || slug.match(/-cartea-([ivx]+|\d+)-/);
    const eMatch = slug.match(/-(?:episod|episodul|capitolul)-(\d+)(?:-(.*))?$/);
    if (!eMatch) continue;
    const season = sMatch ? (ROMAN[sMatch[1]] || parseInt(sMatch[1], 10)) : 1;
    const episode = parseInt(eMatch[1], 10);
    if (episodes.some(e => e.season === season && e.episode === episode)) continue;
    const rawTitle = (eMatch[2] || '').replace(/-/g, ' ').trim();
    episodes.push({
      season,
      episode,
      title: rawTitle ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1) : `Episodul ${episode}`,
      url: `https://www.dozaanimata.net/episode/${slug}/`
    });
  }

  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (episodes.length > 0) cache.set(listKey, episodes);
  return episodes;
}

// Link-ul HLS Vidmoly vine de fiecare data pe alt server (prx-NNNN.vmpx.online), iar unele dau playlistul de
// episod fara token (bucatile video raspund 403/404 si Stremio se incarca la nesfarsit): verificam lantul
// master -> varianta -> prima bucata video si, daca nu merge, cerem din nou pagina player-ului (alt server), de max. 3 ori
async function getVidmolyHls(vmId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const vmPage = await fetchUrl(`https://vidmoly.org/embed-${vmId}.html`, { Referer: 'https://www.dozaanimata.net/' });
      const hls = vmPage.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
      if (!hls) return null;
      if (await isHlsPlayable(hls[1])) return hls[1];
    } catch (e) {}
  }
  return null;
}

// Primul rand ne-comentariu din playlist, ca URL absolut
function firstHlsEntry(text, base) {
  const line = text.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#'));
  return line ? new URL(line.trim(), base).toString() : null;
}

async function isHlsPlayable(masterUrl) {
  const master = await fetchUrl(masterUrl);
  if (!master.startsWith('#EXTM3U')) return false;
  let playlistUrl = masterUrl;
  let playlist = master;
  if (/#EXT-X-STREAM-INF/.test(master)) {
    playlistUrl = firstHlsEntry(master, masterUrl);
    playlist = playlistUrl ? await fetchUrl(playlistUrl) : '';
  }
  const segUrl = firstHlsEntry(playlist, playlistUrl);
  if (!segUrl) return false;
  // segment MPEG-TS (primul octet 0x47) sau fMP4 ("ftyp"/"styp"/"moof"); o pagina de eroare 403/404 nu incepe asa
  const seg = await fetchUrlBuffer(segUrl, { Range: 'bytes=0-187' });
  return seg.length > 0 && (seg[0] === 0x47 || /^(ftyp|styp|moof)$/.test(seg.toString('latin1', 4, 8)));
}

// Pagina de episod + iframe-urile ascunse (@XX hex, apoi protect.php?<base64>), intr-un singur text
function decodeEpisodeSources(epHtml) {
  const allSources = [epHtml];
  const hexMatch = epHtml.match(/str='(@[0-9A-F@]+)'/i);
  if (hexMatch) {
    const decodedHex = hexMatch[1]
      .split('@')
      .filter(Boolean)
      .map(h => String.fromCharCode(parseInt(h, 16)))
      .join('');
    allSources.push(decodedHex);
    const b64Match = decodedHex.match(/protect\.php\?([A-Za-z0-9+/=]+)/);
    if (b64Match) allSources.push(Buffer.from(b64Match[1], 'base64').toString('utf8'));
  }
  return allSources.join('\n');
}

// Playerele pe care le putem reda (restul, ex. Doodstream, au token anti-hotlink)
const PLAYABLE_PLAYER =
  /ok\.ru\/videoembed\/\d+|sendvid\.com\/embed\/[a-zA-Z0-9]+|vidmoly\.[a-z]+\/(?:embed-)?[a-z0-9]{8,}|youtube\.com\/embed\/[a-zA-Z0-9_-]{11}/i;

async function getDozaAnimataStreams(cartoon, season, episode) {
  const episodes = await getDozaEpisodes(cartoon);
  const target = episodes.find(e => e.season === season && e.episode === episode);
  if (!target) return [];
  const targetEpUrl = target.url;

  const streams = [];
  try {
    const combinedHtml = decodeEpisodeSources(await fetchUrl(targetEpUrl));

    // Check OK.ru embed
    const okMatch = combinedHtml.match(/ok\.ru\/videoembed\/(\d+)/i);
    if (okMatch) streams.push(...(await getOkRuStreams(okMatch[1], `${cartoon.name} - S${season}E${episode}`)));

    // Check Sendvid embed
    const svMatch = combinedHtml.match(/sendvid\.com\/embed\/([a-zA-Z0-9]+)/i);
    if (svMatch) {
      try {
        const svPage = await fetchUrl(`https://sendvid.com/embed/${svMatch[1]}`);
        const mp4Url = svPage.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
        if (mp4Url) {
          streams.push({
            name: '🇷🇴 Stream Direct RO (MP4)',
            title: `${cartoon.name} - S${season}E${episode}\n📺 Redare Directă MP4 în Stremio (Dublat în Română)`,
            url: mp4Url[0],
            relay: 'mp4'
          });
        }
      } catch (e) {}
    }

    // Check Vidmoly embed (pagina player-ului contine direct link-ul HLS .m3u8)
    const vmMatch = combinedHtml.match(/vidmoly\.[a-z]+\/(?:embed-)?([a-z0-9]{8,})(?:\.html)?/i);
    if (vmMatch) {
      try {
        const hlsUrl = await getVidmolyHls(vmMatch[1]);
        if (hlsUrl) {
          streams.push({
            name: '🇷🇴 Stream Direct RO (Vidmoly)',
            title: `${cartoon.name} - S${season}E${episode}\n📺 Redare Directă în Stremio (Dublat în Română)`,
            url: hlsUrl,
            // playerul Stremio desktop ramane in "se incarca" pe HLS-ul Vidmoly: ruta stream il trece prin releul addon-ului
            hlsProxy: true
          });
        }
      } catch (e) {}
    }

    // Check YouTube embed (Stremio plays ytId natively!)
    const ytMatch = combinedHtml.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i);
    if (ytMatch) {
      streams.push({
        name: '🇷🇴 Stream Direct RO (YT)',
        title: `${cartoon.name} - S${season}E${episode}\n📺 Redare Directă în Stremio (Dublat în Română)`,
        ytId: ytMatch[1]
      });
    }
  } catch (e) {}

  return streams;
}

// ===================== Import automat DozaAnimata =====================
// Citeste toate serialele din sitemap-ul DozaAnimata, pastreaza desenele dublate din DOZA_YEARS care au
// episoade redabile (OK.ru / Sendvid / Vidmoly / YouTube) si le adauga in catalog; lista se salveaza pe disc
const DOZA_CATALOG_FILE = path.join(__dirname, '..', '..', 'doza-catalog.json');

const DOZA_YEARS = [1985, 2012];

const DOZA_REFRESH_DAYS = 3;

// seriale cu actori reali (nu desene) de pe DozaAnimata
const DOZA_LIVE_ACTION = ['hannah-montana', 'zack-si-cody', 'tipic-raven', 'violetta', 'sunt-in-formatie', 'power-rangers', 'ultima-barfa', 'o-lume-disparuta', 'eu-si-mia'];

function decodeEntities(str) {
  return str
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&#0?38;|&amp;/g, '&')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)));
}

// Slug deja in catalogul scris de mana ("spioanele" acopera "spioanele-2001-dublat-in-romana")
function isKnownDozaSlug(slug) {
  return CARTOONS.some(c => {
    if (!c.dozaSlug) return false;
    const short = c.dozaSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return slug === c.dozaSlug || new RegExp(`^${short}-(19|20)\\d\\d-`).test(slug);
  });
}

async function probeDozaSeries(slug) {
  const html = await fetchUrl(`https://www.dozaanimata.net/series/${slug}/`);
  const og = prop => {
    for (const m of html.matchAll(new RegExp(`<meta property="og:${prop}" content="([^"]*)"`, 'g'))) {
      if (m[1].trim()) return decodeEntities(m[1].trim());
    }
    return '';
  };
  const title = og('title').replace(/\s*[–-]\s*(Dublat|Subtitrat).*$/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
  if (!title) return null;
  const year = (slug.match(/-((?:19|20)\d\d)-/) || [])[1] || '';
  const cartoon = {
    id: `ro_dz_${slug}`,
    imdb: null,
    name: `${title} (Dublat RO)`,
    searchTerms: [title],
    dozaSlug: slug,
    network: 'DozaAnimata',
    releaseInfo: year,
    poster: og('image'),
    description: `[DozaAnimata] ${og('description')}`
  };

  // redabil daca primul episod sau unul de la mijloc are un stream pe un server suportat
  const eps = await getDozaEpisodes(cartoon);
  if (eps.length === 0) return null;
  for (const ep of [eps[0], eps[Math.floor(eps.length / 2)]]) {
    if ((await getDozaAnimataStreams(cartoon, ep.season, ep.episode)).length > 0) return cartoon;
  }
  return null;
}

async function crawlDozaCatalog() {
  const index = await fetchUrl('https://www.dozaanimata.net/sitemap_index.xml');
  const sitemaps = [...index.matchAll(/https:\/\/www\.dozaanimata\.net\/tvshows-sitemap\d*\.xml/g)].map(m => m[0]);
  const slugs = new Set();
  for (const sm of sitemaps) {
    for (const m of (await fetchUrl(sm)).matchAll(/\/series\/([^/<]+)\/?</g)) slugs.add(m[1]);
  }

  const candidates = [...slugs].filter(slug => {
    const year = parseInt((slug.match(/-((?:19|20)\d\d)-/) || [])[1], 10);
    return (
      /dublat/.test(slug) &&
      year >= DOZA_YEARS[0] &&
      year <= DOZA_YEARS[1] &&
      !DOZA_LIVE_ACTION.some(p => slug.startsWith(p)) &&
      !isKnownDozaSlug(slug)
    );
  });

  // 3 cereri in paralel, ca sa nu incarcam site-ul
  const found = [];
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const slug = candidates[next++];
      try {
        const cartoon = await probeDozaSeries(slug);
        if (cartoon) found.push(cartoon);
      } catch (e) {}
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return found.sort((a, b) => a.releaseInfo.localeCompare(b.releaseInfo) || a.name.localeCompare(b.name));
}

function loadDozaCatalog() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(DOZA_CATALOG_FILE, 'utf8'));
  } catch (e) {}
  if (saved && Array.isArray(saved.cartoons)) addCartoons(saved.cartoons);

  let probe = null;
  try {
    probe = JSON.parse(fs.readFileSync(DOZA_EPISODES_FILE, 'utf8'));
    deadEpisodes = new Set(probe.dead);
  } catch (e) {}
  const probeDue = !probe || (Date.now() - probe.updated) / 86400000 >= DOZA_REFRESH_DAYS;

  const ageDays = saved ? (Date.now() - saved.updated) / 86400000 : Infinity;
  if (ageDays < DOZA_REFRESH_DAYS) {
    if (probeDue) probeDozaEpisodes();
    return;
  }
  console.log('DozaAnimata: caut seriale dublate noi in fundal...');
  crawlDozaCatalog()
    .then(list => {
      fs.writeFileSync(DOZA_CATALOG_FILE, JSON.stringify({ updated: Date.now(), cartoons: list }, null, 2), 'utf8');
      addCartoons(list);
      console.log(`DozaAnimata: ${list.length} seriale dublate importate in catalog`);
    })
    .catch(e => console.error('DozaAnimata: import esuat:', e.message))
    .then(() => probeDozaEpisodes());
}

// Verificarea din fundal (la DOZA_REFRESH_DAYS zile): deschide pagina fiecarui episod DozaAnimata si noteaza episoadele
// fara niciun player redabil, ca sa nu apara in Stremio episoade pe care dai click si nu pornesc.
// Doar pagina episodului (fara playere), cate 3 cereri in paralel; o pagina care nu se incarca nu e marcata
async function probeDozaEpisodes() {
  const series = CARTOONS.filter(c => c.dozaSlug && !c.doodOnly);
  console.log(`DozaAnimata: verific in fundal episoadele din ${series.length} seriale...`);
  const all = [];
  for (const c of series) all.push(...(await getAllDozaEpisodes(c)));
  const dead = [];
  let next = 0;
  async function worker() {
    while (next < all.length) {
      const ep = all[next++];
      try {
        if (!PLAYABLE_PLAYER.test(decodeEpisodeSources(await fetchUrl(ep.url)))) dead.push(ep.url);
      } catch (e) {}
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  deadEpisodes = new Set(dead);
  fs.writeFileSync(DOZA_EPISODES_FILE, JSON.stringify({ updated: Date.now(), checked: all.length, dead }, null, 2), 'utf8');
  console.log(`DozaAnimata: ${all.length} episoade verificate, ${dead.length} fara player redabil (ascunse)`);
}

module.exports = { getDozaEpisodes, getDozaAnimataStreams, loadDozaCatalog };
