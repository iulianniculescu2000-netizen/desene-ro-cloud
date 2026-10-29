const { loadConfig } = require('../config');
const { cache } = require('../cache');
const { fetchUrl } = require('../http');
const { parseTorrentFromUrl, seasonOf, findEpisodeFile } = require('../torrent');
const { flTorrentsByHash } = require('./qbittorrent');

// Cauta pe FileList API doar torrente dublate in romana pentru serialul dat (rezultatele sunt in cache per desen)
async function getFileListRoTorrents(cartoon) {
  const cfg = loadConfig();
  const cacheKey = `fl_${cartoon.id}`;
  let flResults = cache.get(cacheKey);

  if (!flResults) {
    flResults = [];
    const authHeader = 'Basic ' + Buffer.from(`${cfg.flUser}:${cfg.flPasskey}`).toString('base64');

    // Cautare dupa IMDb + dupa nume in toate categoriile (categoria "RO Dubbed" nu era inclusa inainte)
    const queries = [
      ...(cartoon.imdb ? [`https://filelist.io/api.php?action=search-torrents&type=imdb&query=${cartoon.imdb}`] : []),
      ...cartoon.searchTerms.map(
        q => `https://filelist.io/api.php?action=search-torrents&type=name&query=${encodeURIComponent(q)}`
      )
    ];

    const seenIds = new Set();
    let answered = false;
    for (const qUrl of queries) {
      try {
        const raw = await fetchUrl(qUrl, { Authorization: authHeader });
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          answered = true;
          for (const item of data) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              flResults.push(item);
            }
          }
        }
      } catch (e) {}
    }

    // FileList limiteaza cererile ("Rate limit reached"): un raspuns fara lista nu se tine in cache
    if (answered) cache.set(cacheKey, flResults);
  }

  // DOAR dublaj romanesc: categoria "RO Dubbed" sau "RoDubbed"/"dublat" in nume/descriere (NU RoSubbed),
  // si doar torrente pentru acelasi serial (acelasi IMDb sau fara IMDb setat)
  return flResults
    .filter(t => t.category === 'RO Dubbed' || /ro[ ._-]?dub|dublat/i.test(`${t.name || ''} ${t.small_description || ''}`))
    .filter(t => !t.imdb || t.imdb === cartoon.imdb)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
}

// Torrente FileList descarcate in fundal de qBittorrent (client aprobat de FileList) si redate din fisierul
// care se descarca; baseUrl = adresa serverului vazuta de dispozitivul care cere (PC sau TV)
async function searchFileListStreams(cartoon, season, episode, baseUrl) {
  const roTorrents = await getFileListRoTorrents(cartoon);
  const streams = [];

  // Torrent pe sezon (S02, Season 2, Sezonul 2) -> il sarim daca e alt sezon decat cel cerut; filtrul vine inaintea
  // limitei de 6, altfel sezoanele cu mai putini seederi (ex. SpongeBob S09 din 21 de torrente) nu apareau niciodata
  const forSeason = roTorrents.filter(t => t.download_link && [null, season].includes(seasonOf(t.name)));
  for (const t of forSeason.slice(0, 6)) {
    const torrentSeason = seasonOf(t.name);

    const parsed = await parseTorrentFromUrl(t.download_link);
    if (!parsed) continue;

    const videoFiles = parsed.files.filter(f => /\.(mkv|mp4|avi)$/i.test(f.name));
    const matchedFile = findEpisodeFile(videoFiles, season, episode, torrentSeason);
    if (!matchedFile) continue;

    flTorrentsByHash.set(parsed.infoHash, t);
    streams.push({
      name: '🇷🇴 RoDubbed\n(FileList HD)',
      title: `${t.name}\n📄 ${matchedFile.name.split('/').pop()} (🌱 ${t.seeders || 0} seeders)\n⏬ Se descarcă în fundal cu qBittorrent, pornește în câteva secunde`,
      url: `${baseUrl}/fl/play/${parsed.infoHash}/${matchedFile.index}`,
      behaviorHints: { bingeGroup: `desene-ro-fl-${t.id}` }
    });
  }

  return streams;
}

// Lista de episoade din fisierele torrentelor dublate (S01E05, 1x05, sau "05 - titlu" in torrent / folder pe sezon),
// pentru desenele fara alta sursa: numerotarea din Stremio (Cinemeta) imparte uneori episoadele pe segmente
// (Powerpuff S1: 51 fata de 13 in torrent), iar aici fiecare episod din lista are sigur un fisier
async function getFileListEpisodes(cartoon) {
  const key = `fl_eps_${cartoon.id}`;
  if (cache.has(key)) return cache.get(key);
  const episodes = [];
  for (const t of (await getFileListRoTorrents(cartoon)).slice(0, 25)) {
    if (!t.download_link) continue;
    const parsed = await parseTorrentFromUrl(t.download_link);
    if (!parsed) continue;
    const torrentSeason = seasonOf(t.name);
    for (const f of parsed.files.filter(f => /\.(mkv|mp4|avi)$/i.test(f.name))) {
      const parts = f.name.split('/');
      const base = parts.pop();
      let season, episode, rest;
      const se = base.match(/s0*(\d{1,2})[ ._-]*e0*(\d{1,3})(?!\d)|(?<!\d)0*(\d{1,2})x0*(\d{1,3})(?!\d)/i);
      if (se) {
        season = parseInt(se[1] || se[3], 10);
        episode = parseInt(se[2] || se[4], 10);
        rest = base.slice(se.index + se[0].length);
      } else {
        const ep = base.match(/(?:^|[^a-z0-9])(?:ep|episod|episodul|episode|e)[ ._-]*0*(\d{1,3})(?!\d)|^0*(\d{1,3})(?!\d)/i);
        if (!ep) continue;
        season = torrentSeason !== null ? torrentSeason : parts.map(seasonOf).find(s => s !== null) ?? 1;
        episode = parseInt(ep[1] || ep[2], 10);
        rest = base.slice(ep.index + ep[0].length);
      }
      if (!episode || episodes.some(e => e.season === season && e.episode === episode)) continue;
      // titlul: textul de dupa numar, pana la eticheta de calitate ("Monkey.See.Doggie.Do.&.Mommy.Fearest.NF.WEB-DL…")
      const title = rest
        .replace(/\.(mkv|mp4|avi)$/i, '')
        .replace(/[._]/g, ' ')
        .replace(/\b(1080p|720p|576p|480p|nf|amzn|skst|web[ -]?dl|webrip|dvdrip|tvrip|hdtv|x264|h 264|xvid|dd\+?2 0|dd\+?5 1|ro[ -]?dub\w*)\b.*$/i, '')
        .replace(/^[\s-]+|[\s-]+$/g, '');
      episodes.push({ season, episode, title: title || `Episodul ${episode}` });
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (episodes.length > 0) cache.set(key, episodes);
  return episodes;
}

module.exports = { searchFileListStreams, getFileListEpisodes };
