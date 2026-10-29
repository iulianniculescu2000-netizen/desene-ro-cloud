const { fetchUrl } = require('../http');
const { cache } = require('../cache');

function htmlDecode(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
}

// Stream-urile directe ale unui video OK.ru (HLS + MP4-uri) din pagina videoembed; [] daca videoclipul e sters / blocat
async function getOkRuStreams(videoId, label) {
  const streams = [];
  try {
    const okPage = htmlDecode(await fetchUrl(`https://ok.ru/videoembed/${videoId}`, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }));
    // videoclipurile OK.ru mai vechi au doar "ondemandHls" in loc de "hlsManifestUrl"
    const hlsMatch =
      okPage.match(/"hlsManifestUrl"\s*:\s*"(https:\/\/[^"]+)"/) || okPage.match(/"ondemandHls"\s*:\s*"(https:\/\/[^"]+)"/);
    if (hlsMatch) {
      streams.push({
        name: '🇷🇴 Stream Direct RO (OK-HD)',
        title: `${label}\n📺 Redare Directă în Stremio (Dublat în Română)`,
        url: hlsMatch[1],
        relay: 'm3u8' // in cloud trece prin releu (linkul e legat de IP-ul care a cerut pagina, srcIp=)
      });
    }
    const mp4Regex = /"name"\s*:\s*"(hd|full|sd|low|lowest|mobile)"\s*,\s*"url"\s*:\s*"(https:\/\/[^"]+)"/g;
    let vMatch;
    while ((vMatch = mp4Regex.exec(okPage)) !== null) {
      streams.push({
        name: `🇷🇴 Stream Direct RO (${vMatch[1].toUpperCase()})`,
        title: `${label}\n📺 MP4 Direct (Dublat în Română)`,
        url: vMatch[2],
        relay: 'mp4'
      });
    }
  } catch (e) {}
  return streams;
}

// Pastreaza doar episoadele ({ season, episode, okId, ... }) al caror video OK.ru inca merge (cele sterse pentru
// copyright nu apar in lista); verificare o data, cate 4 in paralel, rezultatul in cache sub cheia data
async function filterLiveOk(cacheKey, candidates) {
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const live = [];
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const ep = candidates[next++];
      if ((await getOkRuStreams(ep.okId, '')).length > 0) live.push(ep);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  live.sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (live.length > 0) cache.set(cacheKey, live);
  return live;
}

// okVideos din desene.json: episoade OK.ru gasite manual ({ season, episode, okId, title }); acelasi episod poate
// aparea de doua ori (doua incarcari) – ramane primul din lista care inca merge
async function getOkVideoEpisodes(cartoon) {
  if (!cartoon.okVideos) return [];
  const candidates = cartoon.okVideos.map((v, pref) => ({ ...v, pref, title: v.title || `Episodul ${v.episode}` }));
  const live = (await filterLiveOk(`ok_eps_${cartoon.id}`, candidates)).slice().sort((a, b) => a.pref - b.pref);
  return live
    .filter((v, i) => live.findIndex(x => x.season === v.season && x.episode === v.episode) === i)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

module.exports = { getOkRuStreams, filterLiveOk, getOkVideoEpisodes };
