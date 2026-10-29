const path = require('path');

// Catalogul de desene scris de mana (desene.json) + serialele importate automat (DozaAnimata).
// Campuri: id ("ro_" + IMDb), imdb, name, searchTerms, network, releaseInfo, poster, description,
// optional: dozaSlug, archiveId / archiveSeasons / zipFile, preferDoza, doodOnly,
// ytPlaylists (un playlist YouTube per sezon), ytVideos ({ season, episode, ytId, title }), ytMarathons ({ title, ytId })
const CARTOONS = require(path.join(__dirname, '..', 'desene.json'));

function addCartoons(list) {
  for (const c of list) if (!CARTOONS.some(x => x.id === c.id)) CARTOONS.push(c);
}

module.exports = { CARTOONS, addCartoons };
