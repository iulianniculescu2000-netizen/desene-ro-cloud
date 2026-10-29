const { cache } = require('../cache');
const { fetchUrl } = require('../http');

// Videoclipurile unui playlist YouTube (fara cheie API): videoId + titlu din ytInitialData al paginii.
// Prima pagina are pana la 100 de videoclipuri, destul pentru un sezon.
async function getPlaylistVideos(listId, retry = true) {
  const key = `yt_pl_${listId}`;
  if (cache.has(key)) return cache.get(key);

  // pagina are ~1 MB si uneori nu vine complet / da timeout: inca o incercare
  let data;
  try {
    const html = await fetchUrl(`https://www.youtube.com/playlist?list=${listId}`, { 'Accept-Language': 'ro-RO,ro;q=0.9' });
    const m = html.match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.*?\});\s*<\/script>/s);
    data = JSON.parse(m[1]);
  } catch (e) {
    return retry ? getPlaylistVideos(listId, false) : [];
  }

  // pagina noua: lockupViewModel; varianta veche: playlistVideoRenderer
  const videos = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    const lv = o.lockupViewModel;
    if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const title = lv.metadata && lv.metadata.lockupMetadataViewModel && lv.metadata.lockupMetadataViewModel.title.content;
      return videos.push({ ytId: lv.contentId, title: title || '' });
    }
    const pv = o.playlistVideoRenderer;
    if (pv && pv.videoId) {
      const title = (pv.title.runs || []).map(r => r.text).join('') || pv.title.simpleText || '';
      return videos.push({ ytId: pv.videoId, title });
    }
    for (const k in o) walk(o[k]);
  })(data);

  const unique = videos.filter((v, i) => videos.findIndex(x => x.ytId === v.ytId) === i);
  if (unique.length > 0) cache.set(key, unique);
  return unique;
}

// Numarul episodului din titlu: "… - Episodul 12 - …", "Episodul 02", "Ep. 5", "Episode 3"
function episodeFromTitle(title) {
  const m = title.match(/\b(?:episodul|episod|episode|ep)\.?\s*(\d{1,3})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// Titlul afisat: fara numele serialului si "Episodul N" din fata ("Insula Dramei Totale - Episodul 1 - Camperi…" -> "Camperi…")
function cleanTitle(title, episode) {
  const rest = title
    .replace(/^.*?\b(?:episodul|episod|episode|ep)\.?\s*\d{1,3}\b[\s\-–:|.]*/i, '')
    .replace(/\s*[-–|]\s*dublat (?:în|in) rom[aâ]n[aă].*$/i, '')
    .trim();
  return rest || `Episodul ${episode}`;
}

// Episoadele YouTube ale unui desen:
//   ytPlaylists: un playlist per sezon (string) sau { id, season, offset } – offset corecteaza numerotarea decalata
//   ytVideos: videoclipuri separate { season, episode, ytId, title }
// Doar episoadele cu numar in titlu; la dubluri ramane primul (fara episod ghicit)
async function getYouTubeEpisodes(cartoon) {
  if (!cartoon.ytPlaylists && !cartoon.ytVideos) return [];
  const episodes = [];
  const add = ep => {
    if (ep.episode > 0 && !episodes.some(e => e.season === ep.season && e.episode === ep.episode)) episodes.push(ep);
  };

  const lists = cartoon.ytPlaylists || [];
  for (let i = 0; i < lists.length; i++) {
    const pl = typeof lists[i] === 'string' ? { id: lists[i] } : lists[i];
    const season = pl.season || i + 1;
    for (const v of await getPlaylistVideos(pl.id)) {
      const n = episodeFromTitle(v.title);
      if (n === null) continue;
      const episode = n + (pl.offset || 0);
      add({ season, episode, title: cleanTitle(v.title, episode), ytId: v.ytId });
    }
  }
  for (const v of cartoon.ytVideos || []) add({ season: v.season || 1, episode: v.episode, title: v.title || `Episodul ${v.episode}`, ytId: v.ytId });

  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return episodes;
}

// Maratoanele (un video lung per sezon / serie) ca episoade "Maraton – …" in sezonul dat
function getMarathonEpisodes(cartoon, season) {
  return (cartoon.ytMarathons || []).map((m, i) => ({
    season,
    episode: i + 1,
    title: `Maraton – ${m.title}`,
    ytId: m.ytId
  }));
}

module.exports = { getPlaylistVideos, getYouTubeEpisodes, getMarathonEpisodes };
