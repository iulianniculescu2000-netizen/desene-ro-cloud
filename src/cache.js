// Cache in memorie, comun tuturor surselor (se goleste la repornirea serverului sau la salvarea configurarii)
const cache = new Map();
const torrentCache = new Map();

module.exports = { cache, torrentCache };
