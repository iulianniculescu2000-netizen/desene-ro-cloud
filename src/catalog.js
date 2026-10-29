const { cache } = require('./cache');
const { fetchUrl } = require('./http');
const { loadConfig } = require('./config');
const { getEpisodesForCartoon } = require('./surse/archive');
const { getBlogEpisodes } = require('./surse/blog');
const { getOkVideoEpisodes } = require('./surse/okru');
const { getDozaEpisodes } = require('./surse/dozaanimata');
const { getYouTubeEpisodes, getMarathonEpisodes } = require('./surse/youtube');

// Extrage episoadele reale (sezoane + titluri) din Cinemeta pentru afisare curata in Stremio, dar sub ID-ul nostru izolat "ro_tt..."
async function getCinemetaVideos(cartoon) {
  if (!cartoon.imdb) return null;
  const key = `cinemeta_${cartoon.imdb}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const raw = await fetchUrl(`https://v3-cinemeta.strem.io/meta/series/${cartoon.imdb}.json`);
    const data = JSON.parse(raw);
    if (data && data.meta && Array.isArray(data.meta.videos) && data.meta.videos.length > 0) {
      const vids = data.meta.videos.map(v => ({
        id: `${cartoon.id}:${v.season || 1}:${v.episode || v.number || 1}`,
        title: v.name || v.title || `Episodul ${v.episode || 1}`,
        season: v.season || 1,
        episode: v.episode || v.number || 1,
        released: v.released || '2001-01-01T00:00:00.000Z',
        thumbnail: v.thumbnail
      }));
      cache.set(key, vids);
      return vids;
    }
  } catch (e) {}
  return null;
}

// Episoade din sursele cu sezon/episod (YouTube, blog, maratoane) in formatul Stremio;
// ytId / okId raman interne pentru ruta de stream (scoase in ruta meta)
const toVideos = (cartoon, eps) =>
  eps.map(ep => ({
    id: `${cartoon.id}:${ep.season}:${ep.episode}`,
    title: ep.title,
    season: ep.season,
    episode: ep.episode,
    released: '2001-01-01T00:00:00.000Z',
    // imaginea episodului: miniatura YouTube (publica, fara cheie)
    thumbnail: ep.ytId ? `https://i.ytimg.com/vi/${ep.ytId}/hqdefault.jpg` : undefined,
    ytId: ep.ytId,
    okId: ep.okId
  }));

// Maratoanele: lista principala (sezonul 1) cand desenul n-are alta lista, altfel adaugate ca sezonul 0 (Specials)
async function getEpisodeSource(cartoon) {
  const result = await addOkVideos(cartoon, await getMainSource(cartoon));
  if (!(cartoon.ytMarathons || []).length) return result;
  if (result.source === 'cinemeta') {
    return { source: 'marathon', videos: toVideos(cartoon, getMarathonEpisodes(cartoon, 1)) };
  }
  return {
    source: result.source,
    videos: [...result.videos.filter(v => v.season !== 0), ...toVideos(cartoon, getMarathonEpisodes(cartoon, 0))]
  };
}

// okVideos (episoade OK.ru gasite manual): lista principala cand desenul n-are alta lista; altfel completeaza
// episoadele lipsa si se adauga ca a doua sursa la cele existente (ex. X-Men: DozaAnimata + OK.ru)
async function addOkVideos(cartoon, result) {
  const okEps = await getOkVideoEpisodes(cartoon);
  if (okEps.length === 0) return result;
  if (result.source === 'cinemeta') return { source: 'okru', videos: toVideos(cartoon, okEps) };
  const videos = result.videos.map(v => ({ ...v }));
  for (const ep of okEps) {
    const v = videos.find(x => x.season === ep.season && x.episode === ep.episode);
    if (!v) videos.push(...toVideos(cartoon, [ep]));
    else if (!v.okId) v.okId = ep.okId;
  }
  videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { source: result.source, videos };
}

// Alege lista de episoade afisata in Stremio dupa sursa romaneasca: Archive.org (link-uri directe sigure),
// apoi YouTube (playlisturi pe sezoane), blogul deseneledublate7 (OK.ru), apoi DozaAnimata, ca fiecare episod din lista sa aiba stream;
// Cinemeta doar ca ultima varianta (pentru FileList / Torrentio)
// preferDoza: arhiva are doar cateva episoade, iar DozaAnimata are seria completa pe un server redabil (Vidmoly)
// doodOnly: lista DozaAnimata nu se foloseste (episoadele sunt doar pe Doodstream)
async function getMainSource(cartoon) {
  const archEps = cartoon.archiveId && !cartoon.preferDoza ? await getEpisodesForCartoon(cartoon) : [];
  if (archEps.length > 0) {
    return {
      source: 'archive',
      videos: archEps.map(ep => ({
        id: `${cartoon.id}:${ep.season}:${ep.epNumber}`,
        title: ep.title,
        season: ep.season,
        episode: ep.epNumber,
        released: '2001-01-01T00:00:00.000Z'
      }))
    };
  }
  const ytEps = await getYouTubeEpisodes(cartoon);
  if (ytEps.length > 0) return { source: 'youtube', videos: toVideos(cartoon, ytEps) };

  const blogEps = await getBlogEpisodes(cartoon);
  if (blogEps.length > 0) return { source: 'blog', videos: toVideos(cartoon, blogEps) };

  const dozaEps = cartoon.doodOnly ? [] : await getDozaEpisodes(cartoon);
  if (dozaEps.length > 0) {
    return {
      source: 'doza',
      videos: dozaEps.map(ep => ({
        id: `${cartoon.id}:${ep.season}:${ep.episode}`,
        title: ep.title,
        season: ep.season,
        episode: ep.episode,
        released: '2001-01-01T00:00:00.000Z'
      }))
    };
  }
  // fileList: true (torrente dublate verificate pe FileList) + FileList activ -> episoadele din fisierele torrentelor
  if (cartoon.fileList && loadConfig().useFileList) {
    // incarcat doar aici: in cloud FileList e mereu oprit, deci qBittorrent nu se incarca deloc
    const flEps = await require('./surse/filelist').getFileListEpisodes(cartoon);
    if (flEps.length > 0) return { source: 'filelist', videos: toVideos(cartoon, flEps) };
  }

  // onlySeasons: torrentul dublat acopera doar aceste sezoane (ex. Phineas si Ferb: doar S1 pe Torrentio)
  const cinemeta = (await getCinemetaVideos(cartoon)) || [];
  return { source: 'cinemeta', videos: cartoon.onlySeasons ? cinemeta.filter(v => cartoon.onlySeasons.includes(v.season)) : cinemeta };
}

module.exports = { getEpisodeSource };
