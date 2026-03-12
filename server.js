/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║        LADYBUG-MINI HOSTING PLATFORM v2.0.0 - MULTI-HOST EDITION            ║
 * ║   Render.com Free-Tier Optimized Hosting Server with Multi-Session Support  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * Features:
 *  • Multi-host session management (multiple bots from one dashboard)
 *  • Self-ping keep-alive (prevents Render free tier sleep)
 *  • Auto temp-file cleanup with configurable interval
 *  • Real-time WebSocket log streaming to dashboard
 *  • System health monitoring (CPU, RAM, uptime)
 *  • Graceful restart / shutdown
 *  • Beautiful status dashboard with session CRUD
 * 
 * Developer: Dev-Ntando
 */

require('dotenv').config();

const express     = require('express');
const http        = require('http');
const { WebSocketServer } = require('ws');
const cron        = require('node-cron');
const fetch       = require('node-fetch');
const fs          = require('fs');
const path        = require('path');
const { spawn } = require('child_process');
const os          = require('os');
const crypto      = require('crypto');

// ─── Config ─────────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const RENDER_URL      = (process.env.RENDER_URL || '').trim();
const PING_INTERVAL   = parseInt(process.env.PING_INTERVAL   || '14');   // minutes
const CLEANUP_INTERVAL= parseInt(process.env.CLEANUP_INTERVAL|| '30');   // minutes
const BOT_NAME        = process.env.BOT_NAME   || 'Ladybug Bot Mini';
const DASHBOARD_PIN   = process.env.DASHBOARD_PIN || '';
const DATA_DIR        = path.join(__dirname, 'data');
const SESSIONS_FILE   = path.join(DATA_DIR, 'sessions.json');

// ─── State ──────────────────────────────────────────────────────────────────────
let botProcesses = new Map();  // sessionId -> bot process
let botStatuses  = new Map();  // sessionId -> status
let startTimes   = new Map();  // sessionId -> startTime
let logBuffer    = [];         // circular log buffer (last 500 lines)
let pingCount    = 0;
let cleanCount   = 0;
let wssClients   = new Set();

const MAX_LOG_LINES = 500;

// ─── Sessions Database ──────────────────────────────────────────────────────────
let sessions = [];

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
      sessions = JSON.parse(data);
      log('ok', `Loaded ${sessions.length} sessions from database`);
    } else {
      sessions = [];
      saveSessions();
    }
  } catch (err) {
    log('error', `Failed to load sessions: ${err.message}`);
    sessions = [];
  }
}

function saveSessions() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    log('error', `Failed to save sessions: ${err.message}`);
  }
}

function generateSessionId() {
  return 'sess_' + crypto.randomBytes(8).toString('hex');
}

// ─── App ────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Logger ─────────────────────────────────────────────────────────────────────
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

// ─── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  wssClients.add(ws);
  log('info', `Dashboard connected (${wssClients.size} clients)`);

  // Send existing logs + current state
  ws.send(JSON.stringify({ 
    type: 'init', 
    logs: logBuffer, 
    sessions: getAllSessionStatuses(),
    serverStatus: getServerStatus()
  }));

  ws.on('close', () => {
    wssClients.delete(ws);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === 'start' && msg.sessionId) startBot(msg.sessionId);
      if (msg.action === 'stop' && msg.sessionId) stopBot(msg.sessionId);
      if (msg.action === 'restart' && msg.sessionId) restartBot(msg.sessionId);
      if (msg.action === 'cleanup') runCleanup(true);
    } catch (_) {}
  });
});

// ─── Bot process manager ────────────────────────────────────────────────────────
function getServerStatus() {
  return {
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
    uptime       : process.uptime(),
  };
}

function getAllSessionStatuses() {
  return sessions.map(sess => ({
    ...sess,
    status: botStatuses.get(sess.id) || 'stopped',
    startTime: startTimes.get(sess.id) || null,
    uptime: startTimes.get(sess.id) ? Math.floor((Date.now() - startTimes.get(sess.id)) / 1000) : 0
  }));
}

function startBot(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session) {
    log('warn', `Session ${sessionId} not found`);
    return;
  }

  if (botProcesses.has(sessionId)) {
    log('warn', `Bot ${session.ownerName} is already running`);
    return;
  }

  log('ok', `Starting bot for ${session.ownerName}...`);
  botStatuses.set(sessionId, 'starting');
  broadcast('status', { sessionId, status: 'starting' });

  // Build env for bot child process
  const env = {
    ...process.env,
    SESSION_ID   : session.sessionIdString || '',
    OWNER_NUMBER : session.ownerNumber || '',
    BOT_NAME     : session.botName || BOT_NAME,
    PREFIX       : session.prefix || '.',
    TIMEZONE     : session.timezone || 'Asia/Kolkata',
    OPENAI_API_KEY    : process.env.OPENAI_API_KEY    || '',
    DEEPAI_API_KEY    : process.env.DEEPAI_API_KEY    || '',
    REMOVE_BG_API_KEY : process.env.REMOVE_BG_API_KEY || '',
  };

  // Bot directory
  const botDirInside = path.join(__dirname, 'Ladybug-Mini');
  const botDirSibling = path.join(__dirname, '..', 'Ladybug-Mini');
  const botDir  = fs.existsSync(path.join(botDirInside, 'index.js')) ? botDirInside : botDirSibling;
  const botEntry= path.join(botDir, 'index.js');

  // Gracefully handle missing bot directory
  if (!fs.existsSync(botEntry)) {
    log('warn', `Bot entry not found at ${botEntry}`);
    log('warn', 'Running in dashboard-only mode. Clone the bot repo next to this host folder.');
    botStatuses.set(sessionId, 'no-bot');
    broadcast('status', { sessionId, status: 'no-bot' });
    return;
  }

  const botProcess = spawn('node', [botEntry], { cwd: botDir, env, stdio: 'pipe' });
  botProcesses.set(sessionId, botProcess);
  startTimes.set(sessionId, Date.now());
  botStatuses.set(sessionId, 'running');
  broadcast('status', { sessionId, status: 'running', startTime: Date.now() });

  botProcess.stdout.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach(line => log('bot', `[${session.ownerName}] ${line}`));
  });

  botProcess.stderr.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach(line => log('error', `[${session.ownerName}] ${line}`));
  });

  botProcess.on('exit', (code, signal) => {
    log('warn', `Bot ${session.ownerName} exited (code=${code}, signal=${signal})`);
    botProcesses.delete(sessionId);
    startTimes.delete(sessionId);
    botStatuses.set(sessionId, code === 0 ? 'stopped' : 'crashed');
    broadcast('status', { sessionId, status: botStatuses.get(sessionId) });

    // Auto-restart on crash after 5s
    if (code !== 0 && code !== null) {
      log('info', `Auto-restarting ${session.ownerName} in 5 seconds...`);
      setTimeout(() => startBot(sessionId), 5000);
    }
  });

  botProcess.on('error', (err) => {
    log('error', `Failed to spawn bot ${session.ownerName}: ${err.message}`);
    botProcesses.delete(sessionId);
    botStatuses.set(sessionId, 'crashed');
    broadcast('status', { sessionId, status: 'crashed' });
  });

  log('ok', `Bot process spawned for ${session.ownerName} (PID ${botProcess.pid})`);
}

function stopBot(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;

  const botProcess = botProcesses.get(sessionId);
  if (!botProcess) {
    log('warn', `Bot ${session.ownerName} is not running`);
    return;
  }

  log('info', `Stopping bot ${session.ownerName}...`);
  botProcess.removeAllListeners('exit');
  botProcess.kill('SIGTERM');
  botProcesses.delete(sessionId);
  startTimes.delete(sessionId);
  botStatuses.set(sessionId, 'stopped');
  broadcast('status', { sessionId, status: 'stopped' });
  log('ok', `Bot ${session.ownerName} stopped`);
}

function restartBot(sessionId) {
  log('info', `Restarting bot ${sessionId}...`);
  stopBot(sessionId);
  setTimeout(() => startBot(sessionId), 2000);
}

function startAllBots() {
  sessions.forEach(sess => {
    if (sess.autoStart !== false) {
      startBot(sess.id);
    }
  });
}

function stopAllBots() {
  sessions.forEach(sess => stopBot(sess.id));
}

// ─── Keep-alive self-ping ────────────────────────────────────────────────────────
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

// ─── Auto cleanup ────────────────────────────────────────────────────────────────
const TEMP_DIRS = [
  os.tmpdir(),
  path.join(__dirname, 'temp'),
  path.join(__dirname, 'Ladybug-Mini', 'temp'),
  path.join(__dirname, 'Ladybug-Mini', 'tmp'),
  path.join(__dirname, 'Ladybug-Mini', 'downloads'),
  path.join(__dirname, '..', 'Ladybug-Mini', 'temp'),
  path.join(__dirname, '..', 'Ladybug-Mini', 'tmp'),
  path.join(__dirname, '..', 'Ladybug-Mini', 'downloads'),
];

function runCleanup(manual = false) {
  const source = manual ? 'Manual' : 'Scheduled';
  let removed  = 0;
  let freed    = 0;

  for (const dir of TEMP_DIRS) {
    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fp = path.join(dir, file);
        try {
          const stat = fs.statSync(fp);
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

fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
cron.schedule(`*/${CLEANUP_INTERVAL} * * * *`, () => runCleanup(false));
log('info', `Auto-cleanup scheduled every ${CLEANUP_INTERVAL} minutes`);

// ─── HTTP Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeBots: botProcesses.size, uptime: process.uptime() });
});

// API — get server status
app.get('/api/status', (req, res) => {
  res.json(getServerStatus());
});

// API — get all sessions
app.get('/api/sessions', (req, res) => {
  res.json(getAllSessionStatuses());
});

// API — get single session
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    ...session,
    status: botStatuses.get(session.id) || 'stopped',
    startTime: startTimes.get(session.id) || null,
    uptime: startTimes.get(session.id) ? Math.floor((Date.now() - startTimes.get(session.id)) / 1000) : 0
  });
});

// API — create session
app.post('/api/sessions', (req, res) => {
  const pin = req.headers['x-dashboard-pin'] || '';
  if (DASHBOARD_PIN && pin !== DASHBOARD_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone, autoStart } = req.body;

  if (!ownerName || !sessionIdString) {
    return res.status(400).json({ error: 'ownerName and sessionIdString are required' });
  }

  const newSession = {
    id: generateSessionId(),
    ownerName,
    ownerNumber: ownerNumber || '',
    sessionIdString,
    botName: botName || BOT_NAME,
    prefix: prefix || '.',
    timezone: timezone || 'Asia/Kolkata',
    autoStart: autoStart !== false,
    createdAt: new Date().toISOString(),
    createdBy: 'dashboard'
  };

  sessions.push(newSession);
  saveSessions();

  log('ok', `Created new session: ${ownerName} (${newSession.id})`);
  broadcast('session-created', { session: newSession });

  res.status(201).json(newSession);
});

// API — update session
app.put('/api/sessions/:id', (req, res) => {
  const pin = req.headers['x-dashboard-pin'] || '';
  if (DASHBOARD_PIN && pin !== DASHBOARD_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  const idx = sessions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Session not found' });

  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone, autoStart } = req.body;

  sessions[idx] = {
    ...sessions[idx],
    ownerName: ownerName || sessions[idx].ownerName,
    ownerNumber: ownerNumber || sessions[idx].ownerNumber,
    sessionIdString: sessionIdString || sessions[idx].sessionIdString,
    botName: botName || sessions[idx].botName,
    prefix: prefix || sessions[idx].prefix,
    timezone: timezone || sessions[idx].timezone,
    autoStart: autoStart !== undefined ? autoStart : sessions[idx].autoStart,
    updatedAt: new Date().toISOString()
  };

  saveSessions();
  log('ok', `Updated session: ${sessions[idx].ownerName}`);
  broadcast('session-updated', { session: sessions[idx] });

  res.json(sessions[idx]);
});

// API — delete session
app.delete('/api/sessions/:id', (req, res) => {
  const pin = req.headers['x-dashboard-pin'] || '';
  if (DASHBOARD_PIN && pin !== DASHBOARD_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  const idx = sessions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Session not found' });

  // Stop bot if running
  stopBot(req.params.id);

  const deleted = sessions.splice(idx, 1)[0];
  saveSessions();

  log('ok', `Deleted session: ${deleted.ownerName}`);
  broadcast('session-deleted', { sessionId: deleted.id });

  res.json({ ok: true, deleted });
});

// API — bot control
app.post('/api/bot/:action', (req, res) => {
  const { action } = req.params;
  const { sessionId } = req.body;
  const pin = req.headers['x-dashboard-pin'] || '';

  if (DASHBOARD_PIN && pin !== DASHBOARD_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  switch (action) {
    case 'start':
      if (sessionId) startBot(sessionId);
      else startAllBots();
      break;
    case 'stop':
      if (sessionId) stopBot(sessionId);
      else stopAllBots();
      break;
    case 'restart':
      if (sessionId) restartBot(sessionId);
      break;
    case 'cleanup':
      runCleanup(true);
      break;
    default:
      return res.status(400).json({ error: 'Unknown action' });
  }
  res.json({ ok: true, action });
});

// Dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log('ok', `╔════════════════════════════════════════════╗`);
  log('ok', `║  Ladybug-Mini Host  •  Port ${PORT}            ║`);
  log('ok', `║  Dashboard → ${RENDER_URL || `http://localhost:${PORT}`}  ║`);
  log('ok', `╚════════════════════════════════════════════╝`);
  log('info', `Developer: Dev-Ntando`);
  log('info', `__dirname: ${__dirname}`);

  // Load sessions
  loadSessions();

  // Run an initial ping
  setTimeout(selfPing, 3000);

  // Auto-start all bots
  setTimeout(startAllBots, 1000);
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received — shutting down gracefully');
  stopAllBots();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  log('info', 'SIGINT received — shutting down gracefully');
  stopAllBots();
  process.exit(0);
});
