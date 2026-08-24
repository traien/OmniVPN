const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'vpn_activity.db');
const db = new sqlite3.Database(DB_PATH);

// Initialize Tables & Indexes
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS dns_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      client_ip TEXT NOT NULL,
      client_name TEXT,
      domain TEXT NOT NULL,
      qtype TEXT DEFAULT 'A',
      status TEXT DEFAULT 'RESOLVED',
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS client_settings (
      username TEXT PRIMARY KEY,
      adblock_enabled INTEGER DEFAULT 0,
      updated_at TEXT
    )
  `);

  // Migration: Ensure status column exists in existing database
  db.run(`ALTER TABLE dns_logs ADD COLUMN status TEXT DEFAULT 'RESOLVED'`, () => {});

  db.run(`CREATE INDEX IF NOT EXISTS idx_dns_timestamp ON dns_logs(timestamp DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dns_domain ON dns_logs(domain)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dns_client ON dns_logs(client_name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dns_ip ON dns_logs(client_ip)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dns_status ON dns_logs(status)`);
});

// Cache for quick in-memory AdBlock checks per client
const adblockCache = new Map();

// Helper to log a query asynchronously
function logQuery({ clientIp, clientName, domain, qtype = 'A', status = 'RESOLVED' }) {
  if (!domain) return;
  const cleanDomain = domain.toLowerCase().replace(/\.$/, '');
  
  if (cleanDomain.endsWith('.in-addr.arpa') || cleanDomain.endsWith('.ip6.arpa') || cleanDomain === 'localhost') {
    return;
  }

  const now = Date.now();
  const createdAt = new Date(now).toISOString();

  const stmt = db.prepare(`
    INSERT INTO dns_logs (timestamp, client_ip, client_name, domain, qtype, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(now, clientIp, clientName || 'VPN Client', cleanDomain, qtype, status, createdAt, (err) => {
    if (err) console.error('Error saving DNS log:', err.message);
  });
  stmt.finalize();
}

// Fetch Paginated & Filtered Logs
function getLogs({ limit = 50, offset = 0, search = '', client = '', domain = '', status = '' }) {
  return new Promise((resolve, reject) => {
    let query = `SELECT * FROM dns_logs WHERE 1=1`;
    const params = [];

    if (search) {
      query += ` AND (domain LIKE ? OR client_name LIKE ? OR client_ip LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (client) {
      query += ` AND (client_name = ? OR client_ip = ?)`;
      params.push(client, client);
    }

    if (domain) {
      query += ` AND domain LIKE ?`;
      params.push(`%${domain}%`);
    }

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');

    db.get(countQuery, params, (err, countRow) => {
      if (err) return reject(err);

      const total = countRow ? countRow.total : 0;

      query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
      params.push(parseInt(limit, 10), parseInt(offset, 10));

      db.all(query, params, (err, rows) => {
        if (err) return reject(err);
        resolve({ total, logs: rows });
      });
    });
  });
}

// Fetch Aggregated Stats (Top Domains, Blocked stats, etc.)
function getStats() {
  return new Promise((resolve, reject) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();

    const stats = {
      totalToday: 0,
      totalAllTime: 0,
      blockedToday: 0,
      blockedAllTime: 0,
      topDomains: [],
      topClients: []
    };

    db.get(`SELECT COUNT(*) as cnt FROM dns_logs WHERE timestamp >= ?`, [todayTimestamp], (err, row) => {
      if (err) return reject(err);
      stats.totalToday = row ? row.cnt : 0;

      db.get(`SELECT COUNT(*) as cnt FROM dns_logs WHERE timestamp >= ? AND status = 'BLOCKED'`, [todayTimestamp], (err, rowBlocked) => {
        if (err) return reject(err);
        stats.blockedToday = rowBlocked ? rowBlocked.cnt : 0;

        db.get(`SELECT COUNT(*) as cnt FROM dns_logs`, [], (err, rowAll) => {
          if (err) return reject(err);
          stats.totalAllTime = rowAll ? rowAll.cnt : 0;

          db.get(`SELECT COUNT(*) as cnt FROM dns_logs WHERE status = 'BLOCKED'`, [], (err, rowBlockedAll) => {
            if (err) return reject(err);
            stats.blockedAllTime = rowBlockedAll ? rowBlockedAll.cnt : 0;

            // Top 8 visited domains today
            db.all(`
              SELECT domain, COUNT(*) as query_count 
              FROM dns_logs 
              WHERE timestamp >= ?
              GROUP BY domain 
              ORDER BY query_count DESC 
              LIMIT 8
            `, [todayTimestamp], (err, domainRows) => {
              if (err) return reject(err);
              stats.topDomains = domainRows || [];

              // Top clients
              db.all(`
                SELECT client_name, client_ip, COUNT(*) as query_count 
                FROM dns_logs 
                WHERE timestamp >= ?
                GROUP BY client_name, client_ip 
                ORDER BY query_count DESC 
                LIMIT 5
              `, [todayTimestamp], (err, clientRows) => {
                if (err) return reject(err);
                stats.topClients = clientRows || [];
                resolve(stats);
              });
            });
          });
        });
      });
    });
  });
}

// Export Logs as CSV String
function getAllLogsForExport({ client = '', status = '' } = {}) {
  return new Promise((resolve, reject) => {
    let query = `SELECT created_at, client_name, client_ip, domain, qtype, status FROM dns_logs WHERE 1=1`;
    const params = [];
    if (client) {
      query += ` AND client_name = ?`;
      params.push(client);
    }
    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }
    query += ` ORDER BY timestamp DESC LIMIT 10000`;

    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// -----------------------------------------------------------------------------
// Per-Client AdBlock Settings
// -----------------------------------------------------------------------------
function isClientAdblockEnabled(username) {
  if (!username) return false;
  if (adblockCache.has(username)) {
    return adblockCache.get(username);
  }
  return false;
}

function loadAllClientSettings() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT username, adblock_enabled FROM client_settings`, [], (err, rows) => {
      if (err) return reject(err);
      adblockCache.clear();
      for (const row of rows || []) {
        adblockCache.set(row.username, Boolean(row.adblock_enabled));
      }
      resolve(rows || []);
    });
  });
}

// Initialize cache on startup
loadAllClientSettings();

function setClientAdblock(username, enabled) {
  return new Promise((resolve, reject) => {
    const val = enabled ? 1 : 0;
    const now = new Date().toISOString();

    db.run(`
      INSERT INTO client_settings (username, adblock_enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        adblock_enabled = excluded.adblock_enabled,
        updated_at = excluded.updated_at
    `, [username, val, now], function(err) {
      if (err) return reject(err);
      adblockCache.set(username, Boolean(enabled));
      resolve({ username, adblock_enabled: Boolean(enabled) });
    });
  });
}

function clearLogs() {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM dns_logs`, [], function(err) {
      if (err) return reject(err);
      db.run(`VACUUM`, () => resolve(this.changes));
    });
  });
}

function pruneOldLogs(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  db.run(`DELETE FROM dns_logs WHERE timestamp < ?`, [cutoff], function(err) {
    if (!err && this.changes > 0) {
      console.log(`[DNS Logger] Pruned ${this.changes} logs older than ${days} days.`);
    }
  });
}

setInterval(() => pruneOldLogs(30), 24 * 60 * 60 * 1000);

module.exports = {
  logQuery,
  getLogs,
  getStats,
  getAllLogsForExport,
  clearLogs,
  isClientAdblockEnabled,
  setClientAdblock,
  loadAllClientSettings
};
