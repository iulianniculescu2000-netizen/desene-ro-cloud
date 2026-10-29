const { cache } = require('../cache');
const { fetchUrl } = require('../http');
const { filterLiveOk } = require('./okru');

// Blogul deseneledublate7.blogspot.com: un post per sezon, cu "… Sezonul N Episodul M Dublat in Romana" urmat de iframe OK.ru.
// blogPosts in desene.json = ID-urile postarilor Blogger (citite prin feed-ul JSON, fara bara laterala a paginii)
const BLOG = 'https://deseneledublate7.blogspot.com';

async function getBlogPost(postId) {
  const key = `blog_post_${postId}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const entry = JSON.parse(await fetchUrl(`${BLOG}/feeds/posts/default/${postId}?alt=json`)).entry;
    const post = { title: entry.title.$t, content: entry.content.$t };
    cache.set(key, post);
    return post;
  } catch (e) {
    return null;
  }
}

// Perechi (eticheta "Episodul M" -> primul iframe OK.ru de dupa ea); sezonul din eticheta sau din titlul postarii
function parsePost(post) {
  const postSeason = parseInt((post.title.match(/Sezonul\s*(\d+)/i) || [])[1] || '1', 10);
  const regex = /(?:Sezonul\s*(\d+)\s*)?Episodul\s*(\d+)|ok\.ru\/videoembed\/(\d+)/gi;
  const eps = [];
  let label = null;
  let m;
  while ((m = regex.exec(post.content)) !== null) {
    if (m[2]) label = { season: m[1] ? parseInt(m[1], 10) : postSeason, episode: parseInt(m[2], 10) };
    else if (label) {
      eps.push({ ...label, okId: m[3] });
      label = null;
    }
  }
  return eps;
}

// Episoadele de pe blog care inca merg pe OK.ru (cele sterse pentru copyright nu apar in lista)
async function getBlogEpisodes(cartoon) {
  if (!cartoon.blogPosts) return [];
  const key = `blog_eps_${cartoon.id}`;
  if (cache.has(key)) return cache.get(key);

  const candidates = [];
  for (const postId of cartoon.blogPosts) {
    const post = await getBlogPost(postId);
    if (!post) continue;
    for (const ep of parsePost(post)) {
      if (!candidates.some(e => e.season === ep.season && e.episode === ep.episode)) candidates.push(ep);
    }
  }

  return filterLiveOk(key, candidates.map(ep => ({ ...ep, title: `Episodul ${ep.episode}` })));
}

module.exports = { getBlogEpisodes };
