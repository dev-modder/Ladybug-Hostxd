'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const { execSync, spawn } = require('child_process');
const cron       = require('node-cron');
const WebSocket  = require('ws');
const si         = require('systeminformation');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const chalk      = require('chalk');

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const RENDER_URL   = process.env.RENDER_URL || '';
const JWT_SECRET   = process.env.JWT_SECRET || 'ladybugnodes-secret-change-me';
const PING_INTERVAL_MS = 14 * 60 * 1000;  // 14 minutes

// Default admin credentials (override with env vars)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'devntando';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ntando';

// ─── Data Paths ────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Init User Store ───────────────────────────────────────────────────────────
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function ensureAdminExists() {
  let users = loadUsers();
  if (!users.find(u => u.username === ADMIN_USERNAME)) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    users.push({
      id: uuidv4(),
      username: ADMIN_USERNAME,
      password: hash,
      role: 'admin',
      coins: 999,
      createdAt: new Date().toISOString()
    });
    saveUsers(users);
    console.log(chalk.green(`[AUTH] Admin user "${ADMIN_USERNAME}" created.`));
  }
}

ensureAdminExists();

// ─── Session Store ─────────────────────────────────────────────────────────────
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// ─── Server State ──────────────────────────────────────────────────────────────
const state = {
  pingCount:  0,
  cleanCount: 0,
  startTime:  Date.now(),
  botProcesses: {}   // sessionId → child_process
};

// ─── Log Buffer ────────────────────────────────────────────────────────────────
const MAX_LOG = 500;
const logBuffer = [];

function log(msg, level = 'info', sessionId = null) {
  const entry = { ts: Date.now(), level, msg, sessionId };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  broadcast({ type: 'log', ...entry });

  const colors = { info: chalk.cyan, ok: chalk.green, warn: chalk.yellow, error: chalk.red, bot: chalk.magenta };
  const fn = colors[level] || chalk.white;
  console.log(fn(`[${level.toUpperCase()}] ${msg}`));
}

// ─── Express App ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// Cost in coins per bot start
const COIN_COST_START = 5;

// ─── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  const user  = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  log(`User "${username}" logged in`, 'ok');
  res.json({ ok: true, token, user: { id: user.id, username: user.username, role: user.role, coins: user.coins } });
});

app.post('/api/auth/register', requireAdmin, (req, res) => {
  const { username, password, coins = 50 } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = loadUsers();
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const newUser = { id: uuidv4(), username, password: hash, role: 'user', coins: Number(coins), createdAt: new Date().toISOString() };
  users.push(newUser);
  saveUsers(users);
  log(`Admin created user "${username}" with ${coins} coins`, 'ok');
  res.json({ ok: true, user: { id: newUser.id, username, role: newUser.role, coins: newUser.coins } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const users = loadUsers();
  const user  = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, role: user.role, coins: user.coins });
});

// ─── Coin Routes ───────────────────────────────────────────────────────────────
app.get('/api/coins', requireAuth, (req, res) => {
  const users = loadUsers();
  const user  = users.find(u => u.id === req.user.id);
  res.json({ coins: user ? user.coins : 0 });
});

// Admin: add/set coins for a user
app.post('/api/coins/add', requireAdmin, (req, res) => {
  const { userId, username, amount } = req.body || {};
  if (isNaN(amount) || Number(amount) === 0) return res.status(400).json({ error: 'Valid amount required' });

  const users = loadUsers();
  const user  = userId
    ? users.find(u => u.id === userId)
    : users.find(u => u.username === username);

  if (!user) return res.status(404).json({ error: 'User not found' });

  user.coins = Math.max(0, (user.coins || 0) + Number(amount));
  saveUsers(users);
  log(`Admin added ${amount} coins to "${user.username}" (total: ${user.coins})`, 'ok');
  broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
  res.json({ ok: true, coins: user.coins });
});

// Admin: list users with coins
app.get('/api/users', requireAdmin, (req, res) => {
  const users = loadUsers().map(u => ({
    id: u.id, username: u.username, role: u.role, coins: u.coins, createdAt: u.createdAt
  }));
  res.json(users);
});

// Admin: delete user
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  let users = loadUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
  users = users.filter(u => u.id !== req.params.id);
  saveUsers(users);
  log(`Admin deleted user "${user.username}"`, 'warn');
  res.json({ ok: true });
});

// ─── Session Routes ────────────────────────────────────────────────────────────
app.get('/api/sessions', requireAuth, (req, res) => {
  const sessions = loadSessions();
  // Non-admins only see their own sessions
  if (req.user.role === 'admin') return res.json(sessions);
  res.json(sessions.filter(s => s.ownerId === req.user.id));
});

app.post('/api/sessions', requireAuth, (req, res) => {
  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone } = req.body || {};
  if (!ownerName || !sessionIdString) return res.status(400).json({ error: 'ownerName and sessionIdString required' });

  const sessions = loadSessions();
  const newSess  = {
    id: uuidv4(),
    ownerId: req.user.id,
    ownerName, ownerNumber: ownerNumber || '',
    sessionIdString,
    botName: botName || 'LadybugBot',
    prefix: prefix || '.',
    timezone: timezone || 'Africa/Harare',
    status: 'stopped',
    createdAt: new Date().toISOString()
  };
  sessions.push(newSess);
  saveSessions(sessions);
  log(`Session "${newSess.id}" created by "${req.user.username}"`, 'ok');
  broadcast({ type: 'session-created', session: newSess });
  res.json({ ok: true, session: newSess });
});

app.put('/api/sessions/:id', requireAuth, (req, res) => {
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sessions[idx].ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const allowed = ['ownerName','ownerNumber','sessionIdString','botName','prefix','timezone'];
  allowed.forEach(k => { if (req.body[k] !== undefined) sessions[idx][k] = req.body[k]; });
  saveSessions(sessions);
  broadcast({ type: 'session-updated', session: sessions[idx] });
  res.json({ ok: true, session: sessions[idx] });
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  let sessions = loadSessions();
  const sess = sessions.find(s => s.id === req.params.id);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  stopBotProcess(sess.id);
  sessions = sessions.filter(s => s.id !== req.params.id);
  saveSessions(sessions);
  log(`Session "${sess.id}" deleted`, 'warn');
  broadcast({ type: 'session-deleted', sessionId: sess.id });
  res.json({ ok: true });
});

// ─── Bot Control Routes ────────────────────────────────────────────────────────
app.post('/api/bot/start', requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const sessions = loadSessions();
  const sess = sessions.find(s => s.id === sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  // Coin check (skip for admin)
  if (req.user.role !== 'admin') {
    const users = loadUsers();
    const user  = users.find(u => u.id === req.user.id);
    if (!user || user.coins < COIN_COST_START) {
      return res.status(402).json({ error: `Not enough coins. Starting a bot costs ${COIN_COST_START} coins.` });
    }
    user.coins -= COIN_COST_START;
    saveUsers(users);
    broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
    log(`${COIN_COST_START} coins deducted from "${user.username}" for bot start (remaining: ${user.coins})`, 'warn');
  }

  startBotProcess(sess);
  res.json({ ok: true });
});

app.post('/api/bot/stop', requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const sessions = loadSessions();
  const sess = sessions.find(s => s.id === sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  stopBotProcess(sessionId);
  res.json({ ok: true });
});

app.post('/api/bot/restart', requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const sessions = loadSessions();
  const sess = sessions.find(s => s.id === sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  stopBotProcess(sessionId);
  setTimeout(() => startBotProcess(sess), 1500);
  res.json({ ok: true });
});

app.post('/api/bot/cleanup', requireAdmin, (req, res) => {
  const result = runCleanup();
  res.json({ ok: true, ...result });
});

// ─── Install Bot Route ─────────────────────────────────────────────────────────
app.post('/api/install-bot', requireAdmin, (req, res) => {
  try {
    log('Installing bot from GitHub...', 'info');
    execSync('git clone --depth 1 https://github.com/dev-modder/Ladybug-Mini.git bot-src 2>&1 || (cd bot-src && git pull)', {
      cwd: __dirname, stdio: 'pipe'
    });
    execSync('npm install', { cwd: path.join(__dirname, 'bot-src'), stdio: 'pipe' });
    log('Bot installed successfully!', 'ok');
    res.json({ ok: true });
  } catch (err) {
    log(`Bot install failed: ${err.message}`, 'error');
    res.json({ ok: false, error: err.message });
  }
});

// ─── Status & Health ───────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime:    Math.floor((Date.now() - state.startTime) / 1000),
    pingCount: state.pingCount,
    cleanCount: state.cleanCount,
    mem
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ─── Serve HTML pages ──────────────────────────────────────────────────────────
// Login page
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// Dashboard (protected by client-side redirect)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Bot Process Manager ───────────────────────────────────────────────────────
function setSessionStatus(sessionId, status) {
  const sessions = loadSessions();
  const sess = sessions.find(s => s.id === sessionId);
  if (sess) {
    sess.status = status;
    saveSessions(sessions);
    broadcast({ type: 'status', sessionId, status });
  }
}

function startBotProcess(sess) {
  if (state.botProcesses[sess.id]) {
    log(`Bot "${sess.id}" is already running`, 'warn');
    return;
  }

  const botDir = path.join(__dirname, 'bot-src');
  if (!fs.existsSync(botDir)) {
    log(`Bot source not found. Click "Install Bot" first.`, 'error');
    setSessionStatus(sess.id, 'crashed');
    return;
  }

  log(`Starting bot for session "${sess.id}" (${sess.ownerName})...`, 'info', sess.id);
  setSessionStatus(sess.id, 'starting');

  const env = {
    ...process.env,
    SESSION_ID: sess.sessionIdString,
    BOT_NAME:   sess.botName || 'LadybugBot',
    PREFIX:     sess.prefix  || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ:         sess.timezone || 'Africa/Harare'
  };

  const proc = spawn('node', ['index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.botProcesses[sess.id] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', sess.id));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', sess.id));

  proc.on('spawn', () => setSessionStatus(sess.id, 'running'));

  proc.on('exit', (code) => {
    delete state.botProcesses[sess.id];
    const status = code === 0 ? 'stopped' : 'crashed';
    setSessionStatus(sess.id, status);
    log(`Bot "${sess.id}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', sess.id);
  });
}

function stopBotProcess(sessionId) {
  const proc = state.botProcesses[sessionId];
  if (proc) {
    proc.kill('SIGTERM');
    delete state.botProcesses[sessionId];
    setSessionStatus(sessionId, 'stopped');
    log(`Bot "${sessionId}" stopped`, 'warn', sessionId);
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────────
function runCleanup() {
  const tmpDir = '/tmp';
  let removed = 0, freedBytes = 0;
  try {
    const files = fs.readdirSync(tmpDir);
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const f of files) {
      const fp = path.join(tmpDir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          freedBytes += stat.size;
          fs.rmSync(fp, { recursive: true, force: true });
          removed++;
        }
      } catch {}
    }
  } catch {}
  state.cleanCount++;
  const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
  log(`Cleanup done: removed ${removed} files, freed ${freedMB} MB`, 'ok');
  broadcast({ type: 'cleanup', cleanCount: state.cleanCount, removed, freedMB, ts: Date.now() });
  return { removed, freedMB };
}

// ─── Keep-Alive Ping ───────────────────────────────────────────────────────────
async function keepAlivePing() {
  if (!RENDER_URL) return;
  try {
    await fetch(`${RENDER_URL}/health`);
    state.pingCount++;
    log(`Keep-alive ping #${state.pingCount}`, 'info');
    broadcast({ type: 'ping', pingCount: state.pingCount, ts: Date.now() });
  } catch (err) {
    log(`Keep-alive ping failed: ${err.message}`, 'warn');
  }
}

setInterval(keepAlivePing, PING_INTERVAL_MS);

// ─── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);

  // Send initial state
  const sessions = loadSessions();
  ws.send(JSON.stringify({
    type: 'init',
    logs: logBuffer.slice(-150),
    sessions,
    serverStatus: {
      uptime:    Math.floor((Date.now() - state.startTime) / 1000),
      pingCount: state.pingCount,
      cleanCount: state.cleanCount,
      mem:       process.memoryUsage()
    }
  }));

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ─── Cron Jobs ─────────────────────────────────────────────────────────────────
// Cleanup every 6 hours
cron.schedule('0 */6 * * *', runCleanup);

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`LADYBUGNODES running on port ${PORT}`, 'ok');
  if (RENDER_URL) log(`Keep-alive targeting: ${RENDER_URL}`, 'info');
  else log(`Set RENDER_URL env var to enable keep-alive pings`, 'warn');
});

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down bots...', 'warn');
  Object.keys(state.botProcesses).forEach(stopBotProcess);
  process.exit(0);
});
