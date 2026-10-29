const { cache } = require('../cache');
const { fetchUrl } = require('../http');

// Torrente publice (prin Torrentio) DOAR cu dublaj romanesc in nume, ex. "Tutenstein S01 DVDRip RoDubbed",
// "Phineas and Ferb - Season 1 [1080p] ro-en dubbed". Spre deosebire de FileList, trackerele publice merg
// direct cu motorul de torrent din Stremio, fara qBittorrent.
const RO_DUB = /ro[ ._-]?dub|ro-en[ ._-]?dub|dublat|romanian[ ._-]?(dub|audio)|🇷🇴/i;
const CACHE_MS = 6 * 3600 * 1000;

async function getTorrentioRoStreams(cartoon, season, episode) {
  if (!cartoon.imdb) return [];
  const key = `torrentio_${cartoon.imdb}:${season}:${episode}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.streams;

  let list;
  try {
    list = JSON.parse(await fetchUrl(`https://torrentio.strem.fun/stream/series/${cartoon.imdb}:${season}:${episode}.json`)).streams || [];
  } catch (e) {
    return []; // Torrentio indisponibil sau limiteaza cererile; nu punem in cache
  }

  const streams = list
    .filter(s => s.infoHash && RO_DUB.test(`${s.name || ''} ${s.title || ''}`))
    .map(s => ({
      name: '🇷🇴 RoDubbed\n(Torrent public)',
      title: `${(s.title || '').split('\n').slice(0, 2).join('\n')}\n🌐 prin Torrentio, redat direct în Stremio`,
      infoHash: s.infoHash,
      fileIdx: s.fileIdx,
      behaviorHints: { bingeGroup: `desene-ro-torrentio-${s.infoHash}` }
    }));
  // Lista goala poate fi limitarea cererilor de la Torrentio, nu "fara torrent": nu o tinem in cache
  if (streams.length) cache.set(key, { at: Date.now(), streams });
  return streams;
}

module.exports = { getTorrentioRoStreams };
