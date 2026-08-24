const fs = require('fs');
const path = require('path');
const https = require('https');

// Curated initial blocklist (popular ad/malware/tracker domains)
const DEFAULT_BLOCKED_DOMAINS = [
  // Ad Networks & Trackers
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'google-analytics.com',
  'adnxs.com', 'advertising.com', 'adtechus.com', 'criteo.com', 'criteo.net',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'adroll.com', 'taboola.com',
  'outbrain.com', 'scorecardresearch.com', 'quantserve.com', 'zemanta.com',
  'moatads.com', 'smartadserver.com', 'advertising.amazon.com', 'adservice.google.com',
  'pagead2.googlesyndication.com', 'appsflyer.com', 'adjust.com', 'branch.io',
  'flurry.com', 'unityads.unity3d.com', 'applclick.com', 'applovin.com',
  'vungle.com', 'chartboost.com', 'inmobi.com', 'ironsrc.com',
  // Telemetry & Tracking
  'telemetry.microsoft.com', 'vortex.data.microsoft.com', 'telemetry.sdk.inmobi.com',
  'metrics.apple.com', 'diagnostics.apple.com', 'data.flurry.com', 'graph.instagram.com',
  // Malware & Phishing known sinks
  'malware-check.com', 'phishing-site.test', 'trackers.adguard.com'
];

class AdBlockEngine {
  constructor() {
    this.blockedDomains = new Set(DEFAULT_BLOCKED_DOMAINS);
    this.cacheFile = path.join(__dirname, 'data', 'adblock_cache.txt');
    this.isReady = false;
    this.init();
  }

  async init() {
    // 1. Load cached blocklist if exists
    if (fs.existsSync(this.cacheFile)) {
      try {
        const content = fs.readFileSync(this.cacheFile, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const domain = line.trim().toLowerCase();
          if (domain && !domain.startsWith('#')) {
            this.blockedDomains.add(domain);
          }
        }
        console.log(`[AdBlock] Loaded ${this.blockedDomains.size} blocked domains from cache.`);
      } catch (err) {
        console.error('[AdBlock] Failed to read cache:', err.message);
      }
    }

    // 2. Fetch standard StevenBlack unified hosts list in background
    this.fetchRemoteBlocklist();
    this.isReady = true;

    // Refresh blocklist every 7 days
    setInterval(() => this.fetchRemoteBlocklist(), 7 * 24 * 60 * 60 * 1000);
  }

  fetchRemoteBlocklist() {
    const listUrl = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';
    https.get(listUrl, (res) => {
      if (res.statusCode !== 200) {
        return console.warn(`[AdBlock] Remote list returned HTTP ${res.statusCode}`);
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const lines = data.split('\n');
          let count = 0;
          const newSet = new Set(DEFAULT_BLOCKED_DOMAINS);

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('0.0.0.0 ') || trimmed.startsWith('127.0.0.1 ')) {
              const parts = trimmed.split(/\s+/);
              if (parts.length >= 2) {
                const domain = parts[1].toLowerCase();
                if (domain && domain !== 'localhost' && domain !== '0.0.0.0') {
                  newSet.add(domain);
                  count++;
                }
              }
            }
          }

          if (count > 1000) {
            this.blockedDomains = newSet;
            const dataDir = path.join(__dirname, 'data');
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(this.cacheFile, Array.from(this.blockedDomains).join('\n'));
            console.log(`[AdBlock] Successfully updated blocklist with ${this.blockedDomains.size} domains.`);
          }
        } catch (e) {
          console.error('[AdBlock] Parsing error:', e.message);
        }
      });
    }).on('error', (err) => {
      console.warn('[AdBlock] Could not fetch remote list (using local defaults):', err.message);
    });
  }

  isBlocked(domain) {
    if (!domain) return false;
    const clean = domain.toLowerCase().replace(/\.$/, '');

    // Exact match
    if (this.blockedDomains.has(clean)) return true;

    // Subdomain wildcard matching (e.g. ads.example.com matches example.com)
    const parts = clean.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parentDomain = parts.slice(i).join('.');
      if (this.blockedDomains.has(parentDomain)) {
        return true;
      }
    }

    return false;
  }

  getBlocklistSize() {
    return this.blockedDomains.size;
  }
}

const adblockInstance = new AdBlockEngine();
module.exports = adblockInstance;
