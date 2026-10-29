const { cache } = require('../cache');
const { fetchUrl } = require('../http');

// Nume normalizat pentru sortare naturala (fara majuscule si diacritice); numerele se compara numeric la localeCompare
function naturalKey(name) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Episoadele unui desen din Archive.org; archiveSeasons = cate o arhiva per sezon (ex. Dexter), altfel archiveId = sezonul 1
async function getEpisodesForCartoon(cartoon) {
  if (!cartoon || !cartoon.archiveId) return [];
  const ids = cartoon.archiveSeasons || [cartoon.archiveId];
  const all = [];
  for (let i = 0; i < ids.length; i++) {
    const eps = await getArchiveEpisodes(ids[i], ids.length === 1 ? cartoon.zipFile : undefined);
    all.push(...eps.map(ep => ({ ...ep, season: i + 1 })));
  }
  return all;
}

async function getArchiveEpisodes(archiveId, zipFile) {
  if (cache.has(archiveId)) return cache.get(archiveId);

  try {
    const metaRaw = await fetchUrl(`https://archive.org/metadata/${archiveId}`);
    const meta = JSON.parse(metaRaw);
    let episodes = [];

    const directVideos = (meta.files || []).filter(
      f => /\.(mp4|mkv|avi)$/i.test(f.name) && !f.name.includes('.ia.')
    );

    if (directVideos.length > 0) {
      directVideos.sort((a, b) => naturalKey(a.name).localeCompare(naturalKey(b.name), undefined, { numeric: true }));
      episodes = directVideos.map((f, idx) => ({
        epNumber: idx + 1,
        title: f.name.replace(/\.(mp4|mkv|avi)$/i, '').replace(/_/g, ' '),
        url: `https://archive.org/download/${archiveId}/${encodeURIComponent(f.name).replace(/%2F/g, '/')}`
      }));
    } else {
      const zipFileObj = (meta.files || []).find(f => /\.zip$/i.test(f.name));
      // numele real al arhivei din metadata are prioritate (zipFile-urile scrise de mana erau gresite la unele desene)
      const zipName = zipFileObj ? zipFileObj.name : zipFile;
      if (zipName) {
        const zipViewUrl = `https://archive.org/download/${archiveId}/${encodeURIComponent(zipName)}/`;
        const html = await fetchUrl(zipViewUrl);
        const regex = /href="(\/\/archive\.org\/download\/[^"]+\.(?:mp4|mkv|avi))"[^>]*>([^<]+)<\/a>/gi;
        let match;
        let idx = 1;
        while ((match = regex.exec(html)) !== null) {
          const streamUrl = 'https:' + match[1];
          const cleanName = match[2].split('/').pop().replace(/\.(mp4|mkv|avi)$/i, '');
          episodes.push({
            epNumber: idx++,
            path: match[2],
            title: cleanName,
            url: streamUrl
          });
        }
        // Listarea din zip nu e mereu in ordine (s01e2 inainte de s01e1) -> sortare naturala dupa cale, apoi renumerotare
        episodes.sort((a, b) => naturalKey(a.path).localeCompare(naturalKey(b.path), undefined, { numeric: true }));
        episodes.forEach((ep, i) => (ep.epNumber = i + 1));
      }
    }

    cache.set(archiveId, episodes);
    return episodes;
  } catch (err) {
    return [];
  }
}

module.exports = { getEpisodesForCartoon };
