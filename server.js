/**
 * ╔══════════════════════════════════════════════════════╗
 * ║        LADYBUG-MINI HOSTING PLATFORM v1.0.0         ║
 * ║   Render.com Free-Tier Optimized Hosting Server      ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Features:
 *  • Self-ping keep-alive (prevents Render free tier sleep)
 *  • Auto temp-file cleanup with configurable interval
 *  • Real-time WebSocket log streaming to dashboard
 *  • System health monitoring (CPU, RAM, uptime)
 *  • Graceful restart / shutdown
 *  • Beautiful status dashboard
 */

require('dotenv').config();

const express     = require('express');
const http        = require('http');
const { WebSocketServer } = require('ws');
const cron        = require('node-cron');
const fetch       = require('node-fetch');
const fs          = require('fs');
const path        = require('path');
const { execSync, spawn } = require('child_process');
const os          = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const RENDER_URL      = (process.env.RENDER_URL || '').trim();
const PING_INTERVAL   = parseInt(process.env.PING_INTERVAL   || '14');   // minutes
const CLEANUP_INTERVAL= parseInt(process.env.CLEANUP_INTERVAL|| '30');   // minutes
const BOT_NAME        = process.env.BOT_NAME   || 'Ladybug Bot Mini';
const DASHBOARD_PIN   = process.env.DASHBOARD_PIN || '';

// ─── State ────────────────────────────────────────────────────────────────────
let botProcess  = null;
let botStatus   = 'stopped';   // stopped | starting | running | crashed
let startTime   = null;
let logBuffer   = [];          // circular log buffer (last 500 lines)
let pingCount   = 0;
let cleanCount  = 0;
let wssClients  = new Set();

const MAX_LOG_LINES = 500;

// ─── App ─────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, ...args) {
  const ts  = new Date().toISOString();
  const msg = args.join(' ');
  const entry = { ts, level, msg };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();

  // Broadcast to all WebSocket clients
  const payload = JSON.stringify({ type: 'log', ...entry });
  for (const client of wssClients) {
    if (client.readyState === 1) client.send(payload);
  }

  const prefix = {
    info : '\x1b[36m[INFO ]\x1b[0m',
    warn : '\x1b[33m[WARN ]\x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
    ok   : '\x1b[32m[  OK ]\x1b[0m',
    bot  : '\x1b[35m[ BOT ]\x1b[0m',
  }[level] || '[LOG  ]';

  console.log(`${prefix} ${ts} ${msg}`);
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, ...data });
  for (const client of wssClients) {
    if (client.readyState === 1) client.send(payload);
  }
}

// ─── WebSocket ─────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  wssClients.add(ws);
  log('info', `Dashboard connected (${wssClients.size} clients)`);

  // Send existing logs + current state
  ws.send(JSON.stringify({ type: 'init', logs: logBuffer, status: getStatus() }));

  ws.on('close', () => {
    wssClients.delete(ws);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === 'start')   startBot();
      if (msg.action === 'stop')    stopBot();
      if (msg.action === 'restart') restartBot();
      if (msg.action === 'cleanup') runCleanup(true);
    } catch (_) {}
  });
});

// ─── Bot process manager ──────────────────────────────────────────────────────
function getStatus() {
  return {
    botStatus,
    startTime,
    uptime       : startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
    pingCount,
    cleanCount,
    mem          : process.memoryUsage(),
    loadAvg      : os.loadavg(),
    freeMem      : os.freemem(),
    totalMem     : os.totalmem(),
    nodeVersion  : process.version,
    platform     : os.platform(),
    botName      : BOT_NAME,
    renderUrl    : RENDER_URL || 'not configured',
  };
}

function startBot() {
  if (botProcess) {
    log('warn', 'Bot is already running — ignoring start command');
    return;
  }

  log('ok', 'Starting Ladybug-Mini bot...');
  botStatus = 'starting';
  broadcast('status', { botStatus });

  // Build env for bot child process
  const env = {
    ...process.env,
    SESSION_ID   : process.env.SESSION_ID   || '',
    OWNER_NUMBER : process.env.OWNER_NUMBER || '',
    BOT_NAME     : BOT_NAME,
    PREFIX       : process.env.PREFIX       || '.',
    TIMEZONE     : process.env.TIMEZONE     || 'Asia/Kolkata',
    OPENAI_API_KEY    : process.env.OPENAI_API_KEY    || '',
    DEEPAI_API_KEY    : process.env.DEEPAI_API_KEY    || '',
    REMOVE_BG_API_KEY : process.env.REMOVE_BG_API_KEY || '',
  };

  // Support both: bot cloned inside host folder OR next to it
  const botDirInside = path.join(__dirname, 'Ladybug-Mini');
  const botDirSibling = path.join(__dirname, '..', 'Ladybug-Mini');
  const botDir  = fs.existsSync(path.join(botDirInside, 'index.js')) ? botDirInside : botDirSibling;
  const botEntry= path.join(botDir, 'index.js');

  // Gracefully handle missing bot directory
  if (!fs.existsSync(botEntry)) {
    log('warn', `Bot entry not found at ${botEntry}`);
    log('warn', 'Running in dashboard-only mode. Clone the bot repo next to this host folder.');
    botStatus = 'no-bot';
    broadcast('status', { botStatus });
    return;
  }

  botProcess = spawn('node', [botEntry], { cwd: botDir, env, stdio: 'pipe' });
  startTime  = Date.now();
  botStatus  = 'running';
  broadcast('status', { botStatus, startTime });

  botProcess.stdout.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach(line => log('bot', line));
  });

  botProcess.stderr.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach(line => log('error', line));
  });

  botProcess.on('exit', (code, signal) => {
    log('warn', `Bot exited (code=${code}, signal=${signal})`);
    botProcess = null;
    startTime  = null;
    botStatus  = code === 0 ? 'stopped' : 'crashed';
    broadcast('status', { botStatus });

    // Auto-restart on crash after 5s
    if (code !== 0 && code !== null) {
      log('info', 'Auto-restarting bot in 5 seconds...');
      setTimeout(startBot, 5000);
    }
  });

  botProcess.on('error', (err) => {
    log('error', `Failed to spawn bot: ${err.message}`);
    botProcess = null;
    botStatus  = 'crashed';
    broadcast('status', { botStatus });
  });

  log('ok', `Bot process spawned (PID ${botProcess.pid})`);
}

function stopBot() {
  if (!botProcess) {
    log('warn', 'Bot is not running');
    return;
  }
  log('info', 'Stopping bot...');
  botProcess.removeAllListeners('exit');
  botProcess.kill('SIGTERM');
  botProcess = null;
  startTime  = null;
  botStatus  = 'stopped';
  broadcast('status', { botStatus });
  log('ok', 'Bot stopped');
}

function restartBot() {
  log('info', 'Restarting bot...');
  stopBot();
  setTimeout(startBot, 2000);
}

// ─── Keep-alive self-ping ─────────────────────────────────────────────────────
async function selfPing() {
  if (!RENDER_URL) {
    log('warn', 'RENDER_URL not set — skipping keep-alive ping');
    return;
  }
  try {
    const res = await fetch(`${RENDER_URL}/health`, { timeout: 10000 });
    pingCount++;
    log('ok', `Keep-alive ping #${pingCount} → ${res.status}`);
    broadcast('ping', { pingCount, ts: new Date().toISOString() });
  } catch (err) {
    log('warn', `Keep-alive ping failed: ${err.message}`);
  }
}

// Schedule ping every PING_INTERVAL minutes
cron.schedule(`*/${PING_INTERVAL} * * * *`, selfPing);
log('info', `Keep-alive ping scheduled every ${PING_INTERVAL} minutes`);

// ─── Auto cleanup ─────────────────────────────────────────────────────────────
const TEMP_DIRS = [
  os.tmpdir(),
  path.join(__dirname, 'temp'),
  // inside host folder (Render layout)
  path.join(__dirname, 'Ladybug-Mini', 'temp'),
  path.join(__dirname, 'Ladybug-Mini', 'tmp'),
  path.join(__dirname, 'Ladybug-Mini', 'downloads'),
  // sibling folder (local layout)
  path.join(__dirname, '..', 'Ladybug-Mini', 'temp'),
  path.join(__dirname, '..', 'Ladybug-Mini', 'tmp'),
  path.join(__dirname, '..', 'Ladybug-Mini', 'downloads'),
];

function runCleanup(manual = false) {
  const source = manual ? 'Manual' : 'Scheduled';
  let removed  = 0;
  let freed    = 0; // bytes

  for (const dir of TEMP_DIRS) {
    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fp = path.join(dir, file);
        try {
          const stat = fs.statSync(fp);
          // Remove files older than 15 minutes
          const ageMin = (Date.now() - stat.mtimeMs) / 60000;
          if (stat.isFile() && ageMin > 15) {
            freed += stat.size;
            fs.unlinkSync(fp);
            removed++;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  cleanCount++;
  const freedMB = (freed / 1024 / 1024).toFixed(2);
  log('ok', `${source} cleanup #${cleanCount}: removed ${removed} files, freed ${freedMB} MB`);
  broadcast('cleanup', { cleanCount, removed, freedMB, ts: new Date().toISOString() });
}

// Also ensure our own temp dir exists
fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });

// Schedule cleanup
cron.schedule(`*/${CLEANUP_INTERVAL} * * * *`, () => runCleanup(false));
log('info', `Auto-cleanup scheduled every ${CLEANUP_INTERVAL} minutes`);

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

// Health check (used by self-ping and Render's health check)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: botStatus, uptime: process.uptime() });
});

// API — get status
app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

// API — get logs
app.get('/api/logs', (req, res) => {
  res.json(logBuffer);
});

// API — bot control
app.post('/api/bot/:action', (req, res) => {
  const { action } = req.params;
  const pin = req.headers['x-dashboard-pin'] || '';

  if (DASHBOARD_PIN && pin !== DASHBOARD_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  switch (action) {
    case 'start':   startBot();   break;
    case 'stop':    stopBot();    break;
    case 'restart': restartBot(); break;
    case 'cleanup': runCleanup(true); break;
    default: return res.status(400).json({ error: 'Unknown action' });
  }
  res.json({ ok: true, action });
});

// Dashboard (served from public/index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log('ok', `╔══════════════════════════════════════════╗`);
  log('ok', `║  Ladybug-Mini Host  •  Port ${PORT}          ║`);
  log('ok', `║  Dashboard → ${RENDER_URL || `http://localhost:${PORT}`}  ║`);
  log('ok', `╚══════════════════════════════════════════╝`);
  // Log resolved paths for easy debugging
  log('info', `__dirname: ${__dirname}`);
  log('info', `Bot search paths: ${path.join(__dirname, 'Ladybug-Mini', 'index.js')} | ${path.join(__dirname, '..', 'Ladybug-Mini', 'index.js')}`);

  // Run an initial ping
  setTimeout(selfPing, 3000);

  // Auto-start bot on server boot
  setTimeout(startBot, 1000);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received — shutting down gracefully');
  stopBot();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  log('info', 'SIGINT received — shutting down gracefully');
  stopBot();
  process.exit(0);
});
