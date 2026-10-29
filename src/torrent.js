const crypto = require('crypto');
const { fetchUrlBuffer } = require('./http');
const { torrentCache } = require('./cache');

// Parser Bencode nativ (zero dependente externe) pentru extragerea infoHash-ului si fisierelor din .torrent-urile FileList
function parseTorrentBuffer(buf) {
  let i = 0;
  let infoStart = -1;
  let infoEnd = -1;

  function decodeNext() {
    const ch = buf[i];
    if (ch === 0x69) { // 'i'
      i++;
      const end = buf.indexOf(0x65, i);
      const val = parseInt(buf.slice(i, end).toString('ascii'), 10);
      i = end + 1;
      return val;
    }
    if (ch === 0x6c) { // 'l'
      i++;
      const arr = [];
      while (buf[i] !== 0x65) arr.push(decodeNext());
      i++;
      return arr;
    }
    if (ch === 0x64) { // 'd'
      i++;
      const obj = {};
      while (buf[i] !== 0x65) {
        const key = decodeNext().toString('utf8');
        if (key === 'info' && infoStart === -1) {
          infoStart = i;
          obj[key] = decodeNext();
          infoEnd = i;
        } else {
          obj[key] = decodeNext();
        }
      }
      i++;
      return obj;
    }
    // byte string: <len>:<bytes>
    const colon = buf.indexOf(0x3a, i);
    const len = parseInt(buf.slice(i, colon).toString('ascii'), 10);
    i = colon + 1;
    const slice = buf.slice(i, i + len);
    i += len;
    return slice;
  }

  const root = decodeNext();
  if (infoStart === -1 || infoEnd === -1) return null;
  const infoHash = crypto.createHash('sha1').update(buf.slice(infoStart, infoEnd)).digest('hex').toLowerCase();
  return { root, infoHash };
}

// Extrage infoHash si lista de fisiere direct din fisierul .torrent descarcat de pe FileList
async function parseTorrentFromUrl(downloadUrl) {
  if (torrentCache.has(downloadUrl)) return torrentCache.get(downloadUrl);
  try {
    const buf = await fetchUrlBuffer(downloadUrl);
    const parsed = parseTorrentBuffer(buf);
    if (!parsed || !parsed.root || !parsed.root.info) return null;
    const decoded = parsed.root;
    const infoHash = parsed.infoHash;

    const files = [];
    if (decoded.info.files) {
      decoded.info.files.forEach((f, idx) => {
        const pathParts = (f.path || []).map(p => Buffer.isBuffer(p) ? p.toString('utf8') : String(p));
        files.push({ index: idx, name: pathParts.join('/'), length: f.length });
      });
    } else if (decoded.info.name) {
      const singleName = Buffer.isBuffer(decoded.info.name) ? decoded.info.name.toString('utf8') : String(decoded.info.name);
      files.push({ index: 0, name: singleName, length: decoded.info.length });
    }

    const trackers = [];
    if (decoded.announce) {
      trackers.push('tracker:' + (Buffer.isBuffer(decoded.announce) ? decoded.announce.toString('utf8') : String(decoded.announce)));
    }
    if (Array.isArray(decoded['announce-list'])) {
      decoded['announce-list'].forEach(tier => {
        if (Array.isArray(tier)) {
          tier.forEach(tr => {
            const tStr = 'tracker:' + (Buffer.isBuffer(tr) ? tr.toString('utf8') : String(tr));
            if (!trackers.includes(tStr)) trackers.push(tStr);
          });
        }
      });
    }

    const result = { infoHash, files, trackers };
    torrentCache.set(downloadUrl, result);
    return result;
  } catch (err) {
    console.error('Failed to parse torrent:', err.message);
    return null;
  }
}

// Sezonul dintr-un nume de torrent/folder: "S02", "Season 2", "Sezonul 2" (null daca nu apare)
function seasonOf(name) {
  const m = name.match(/(?:^|[^a-z0-9])(?:s|season[ ._-]*|sezonul[ ._-]*)0*(\d{1,2})(?![0-9])(?!x\d)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Gaseste fisierul exact al episodului; fara potrivire sigura intoarce null (nu mai pune alt episod)
function findEpisodeFile(videoFiles, season, episode, torrentSeason) {
  const seRegex = new RegExp(`s0*${season}[ ._-]*e0*${episode}(?!\\d)|(?<!\\d)0*${season}x0*${episode}(?!\\d)`, 'i');
  const exact = videoFiles.find(f => seRegex.test(f.name));
  if (exact) return exact;

  const epRegex = new RegExp(`(?:^|[^a-z0-9])(?:ep|episod|episodul|episode|e)[ ._-]*0*${episode}(?!\\d)|^0*${episode}(?!\\d)`, 'i');
  return (
    videoFiles.find(f => {
      const parts = f.name.split('/');
      const base = parts.pop();
      if (/s\d+[ ._-]*e\d+|\d+x\d+/i.test(base)) return false;
      // sezonul vine din numele torrentului sau din folderul fisierului; pachetele fara sezon conteaza ca sezonul 1
      const fileSeason = torrentSeason !== null ? torrentSeason : parts.map(seasonOf).find(s => s !== null) ?? 1;
      return fileSeason === season && epRegex.test(base);
    }) || null
  );
}

module.exports = { parseTorrentFromUrl, seasonOf, findEpisodeFile };
