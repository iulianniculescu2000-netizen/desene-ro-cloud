const fs = require('fs');
const path = require('path');

// Pe VM-ul din cloud: PORT=7015 (doar 127.0.0.1, in spatele Caddy), DESENE_CLOUD=1
const PORT = parseInt(process.env.PORT || '7015', 10);

// Modul cloud (VM Oracle): fara FileList / qBittorrent (raman doar pe PC), fara serverul HTTPS de retea (lan.js),
// toate stream-urile OK.ru / Vidmoly / Sendvid trec prin releul /hlsp/ (linkurile lor sunt legate de IP-ul care le cere)
const CLOUD = process.env.DESENE_CLOUD === '1';

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  if (CLOUD) return { flUser: '', flPasskey: '', onlyRoDub: true, useFileList: false };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return { flUser: '', flPasskey: '', onlyRoDub: true, useFileList: false };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = { PORT, CLOUD, loadConfig, saveConfig };
