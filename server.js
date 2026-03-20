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
const multer     = require('multer');
const AdmZip     = require('adm-zip');

// ───────── Config ──────────────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const VERSION      = '5.0.0';
const RENDER_URL   = process.env.RENDER_URL || '';
const JWT_SECRET   = process.env.JWT_SECRET || 'ladybugnodes-secret-change-me';
const PING_INTERVAL_MS = 14 * 60 * 1000;  // 14 minutes

// Default admin credentials (override with env vars)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'devntando';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ntando';

// ───────── Data Paths ───────────────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const UPLOADED_BOTS_DIR = path.join(DATA_DIR, 'uploaded-bots');
const BOT_CONFIGS_FILE = path.join(DATA_DIR, 'bot-configs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADED_BOTS_DIR)) fs.mkdirSync(UPLOADED_BOTS_DIR, { recursive: true });

// ───────── Multer Config for Bot Uploads ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const botDir = path.join(UPLOADED_BOTS_DIR, req.params.botId || uuidv4());
    if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
    cb(null, botDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.js', '.json', '.md', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext) || file.originalname === 'package.json') {
      cb(null, true);
    } else {
      cb(new Error('Only .js, .json, .md, .zip files are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

const uploadZip = multer({
  dest: UPLOADED_BOTS_DIR,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || path.extname(file.originalname).toLowerCase() === '.zip') {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are allowed'));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit for zips
});

// ───────── Init User Store ──────────────────────────────────────────────────────────────────────
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
      coins: 999999999999999,
      createdAt: new Date().toISOString()
    });
    saveUsers(users);
    console.log(chalk.green(`[AUTH] Admin user "${ADMIN_USERNAME}" created.`));
  }
}

ensureAdminExists();

// ───────── Bot Configs Store ───────────────────────────────────────────────────────────────────
function loadBotConfigs() {
  try { return JSON.parse(fs.readFileSync(BOT_CONFIGS_FILE, 'utf8')); }
  catch { return []; }
}

function saveBotConfigs(configs) {
  fs.writeFileSync(BOT_CONFIGS_FILE, JSON.stringify(configs, null, 2));
}

// ───────── Session Store ────────────────────────────────────────────────────────────────────────
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// ───────── Server State ─────────────────────────────────────────────────────────────────────────
const state = {
  pingCount:  0,
  cleanCount: 0,
  startTime:  Date.now(),
  botProcesses: {},   // sessionId → child_process
  panelBotProcesses: {} // botId → child_process for panel bots
};

// ───────── Log Buffer ──────────────────────────────────────────────────────────────────────────
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

// ───────── Express App ──────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ───────── Auth Middleware ─────────────────────────────────────────────────────────────────────
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

// ───────── Auth Routes ──────────────────────────────────────────────────────────────────────────
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

// ───────── Coin Routes ──────────────────────────────────────────────────────────────────────────
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

// ───────── Session Routes ───────────────────────────────────────────────────────────────────────
app.get('/api/sessions', requireAuth, (req, res) => {
  const sessions = loadSessions();
  // Non-admins only see their own sessions
  if (req.user.role === 'admin') return res.json(sessions);
  res.json(sessions.filter(s => s.ownerId === req.user.id));
});

app.post('/api/sessions', requireAuth, (req, res) => {
  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone, botId } = req.body || {};
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
    botId: botId || null, // Reference to uploaded panel bot
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

  const allowed = ['ownerName','ownerNumber','sessionIdString','botName','prefix','timezone','botId'];
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

// ───────── Panel Bot Management Routes ──────────────────────────────────────────────────────────

// List all panel bots (uploaded bots)
app.get('/api/panel-bots', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  if (req.user.role === 'admin') return res.json(configs);
  res.json(configs.filter(c => c.ownerId === req.user.id));
});

// Get a specific panel bot
app.get('/api/panel-bots/:botId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json(config);
});

// Upload a new panel bot (ZIP file)
app.post('/api/panel-bots/upload', requireAuth, uploadZip.single('botZip'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const botId = uuidv4();
  const botName = req.body.name || path.parse(req.file.originalname).name;
  const botDescription = req.body.description || '';
  const entryPoint = req.body.entryPoint || 'index.js';
  
  const extractDir = path.join(UPLOADED_BOTS_DIR, botId);
  fs.mkdirSync(extractDir, { recursive: true });

  // Extract the ZIP file
  const AdmZip = require('adm-zip');
  try {
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(req.file.path); // Remove temp zip file

    // Check for package.json and install dependencies
    const packageJsonPath = path.join(extractDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      log(`Installing dependencies for bot "${botName}"...`, 'info');
      try {
        execSync('npm install', { cwd: extractDir, stdio: 'pipe' });
        log(`Dependencies installed for bot "${botName}"`, 'ok');
      } catch (err) {
        log(`Warning: Could not install dependencies for "${botName}": ${err.message}`, 'warn');
      }
    }

    // Verify entry point exists
    const entryPath = path.join(extractDir, entryPoint);
    if (!fs.existsSync(entryPath)) {
      // Try to find any .js file
      const files = fs.readdirSync(extractDir);
      const jsFile = files.find(f => f.endsWith('.js'));
      if (jsFile) {
        log(`Entry point "${entryPoint}" not found, using "${jsFile}" instead`, 'warn');
        req.body.entryPoint = jsFile;
      }
    }

    const config = {
      id: botId,
      name: botName,
      description: botDescription,
      entryPoint: req.body.entryPoint || entryPoint,
      ownerId: req.user.id,
      ownerUsername: req.user.username,
      status: 'stopped',
      createdAt: new Date().toISOString(),
      path: extractDir
    };

    const configs = loadBotConfigs();
    configs.push(config);
    saveBotConfigs(configs);

    log(`Panel bot "${botName}" uploaded by "${req.user.username}"`, 'ok');
    broadcast({ type: 'panel-bot-created', bot: config });
    res.json({ ok: true, bot: config });
  } catch (err) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    log(`Failed to extract bot: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to extract bot: ' + err.message });
  }
});

// Upload individual files to a bot
app.post('/api/panel-bots/:botId/files', requireAuth, upload.array('files', 20), (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  log(`Uploaded ${req.files.length} files to bot "${config.name}"`, 'ok');
  res.json({ ok: true, filesUploaded: req.files.length });
});

// Update panel bot config
app.put('/api/panel-bots/:botId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const idx = configs.findIndex(c => c.id === req.params.botId);
  
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && configs[idx].ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const allowed = ['name', 'description', 'entryPoint'];
  allowed.forEach(k => { if (req.body[k] !== undefined) configs[idx][k] = req.body[k]; });
  saveBotConfigs(configs);
  
  broadcast({ type: 'panel-bot-updated', bot: configs[idx] });
  res.json({ ok: true, bot: configs[idx] });
});

// Delete a panel bot
app.delete('/api/panel-bots/:botId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  // Stop the bot if running
  stopPanelBotProcess(config.id);

  // Remove bot directory
  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  if (fs.existsSync(botDir)) {
    fs.rmSync(botDir, { recursive: true, force: true });
  }

  const newConfigs = configs.filter(c => c.id !== req.params.botId);
  saveBotConfigs(newConfigs);
  
  log(`Panel bot "${config.name}" deleted`, 'warn');
  broadcast({ type: 'panel-bot-deleted', botId: config.id });
  res.json({ ok: true });
});

// Start a panel bot
app.post('/api/panel-bots/:botId/start', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

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
  }

  startPanelBotProcess(config);
  res.json({ ok: true });
});

// Stop a panel bot
app.post('/api/panel-bots/:botId/stop', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  stopPanelBotProcess(config.id);
  res.json({ ok: true });
});

// Restart a panel bot
app.post('/api/panel-bots/:botId/restart', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  stopPanelBotProcess(config.id);
  setTimeout(() => startPanelBotProcess(config), 1500);
  res.json({ ok: true });
});

// Get bot logs
app.get('/api/panel-bots/:botId/logs', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const botLogs = logBuffer.filter(l => l.sessionId === req.params.botId);
  res.json({ logs: botLogs });
});

// ───────── Bot Control Routes ──────────────────────────────────────────────────────────────────
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

// ───────── Install Bot Route ────────────────────────────────────────────────────────────────────
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

// ───────── Status & Health ─────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime:    Math.floor((Date.now() - state.startTime) / 1000),
    pingCount: state.pingCount,
    cleanCount: state.cleanCount,
    mem
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now(), version: VERSION }));

// Version endpoint
app.get('/api/version', (req, res) => {
  res.json({ 
    version: VERSION, 
    name: 'LADYBUGNODES',
    description: 'Multi-Host WhatsApp Bot Dashboard'
  });
});

// ───────── Serve HTML pages ────────────────────────────────────────────────────────────────────
// Login page
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// Dashboard (protected by client-side redirect)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ───────── Bot Process Manager ────────────────────────────────────────────────────────────────
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

  // Check if this session uses a panel bot
  if (sess.botId) {
    const configs = loadBotConfigs();
    const botConfig = configs.find(c => c.id === sess.botId);
    if (botConfig) {
      startPanelBotForSession(sess, botConfig);
      return;
    }
  }

  // Default bot source
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

function startPanelBotForSession(sess, botConfig) {
  if (state.botProcesses[sess.id]) {
    log(`Bot "${sess.id}" is already running`, 'warn');
    return;
  }

  const botDir = path.join(UPLOADED_BOTS_DIR, botConfig.id);
  if (!fs.existsSync(botDir)) {
    log(`Panel bot directory not found for "${botConfig.name}"`, 'error');
    setSessionStatus(sess.id, 'crashed');
    return;
  }

  log(`Starting panel bot "${botConfig.name}" for session "${sess.id}"...`, 'info', sess.id);
  setSessionStatus(sess.id, 'starting');

  const env = {
    ...process.env,
    SESSION_ID: sess.sessionIdString,
    BOT_NAME:   sess.botName || botConfig.name,
    PREFIX:     sess.prefix  || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ:         sess.timezone || 'Africa/Harare'
  };

  const proc = spawn('node', [botConfig.entryPoint || 'index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.botProcesses[sess.id] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', sess.id));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', sess.id));

  proc.on('spawn', () => setSessionStatus(sess.id, 'running'));

  proc.on('exit', (code) => {
    delete state.botProcesses[sess.id];
    const status = code === 0 ? 'stopped' : 'crashed';
    setSessionStatus(sess.id, status);
    log(`Panel bot "${botConfig.name}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', sess.id);
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

// ───────── Panel Bot Process Manager ──────────────────────────────────────────────────────────
function setPanelBotStatus(botId, status) {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === botId);
  if (config) {
    config.status = status;
    saveBotConfigs(configs);
    broadcast({ type: 'panel-bot-status', botId, status });
  }
}

function startPanelBotProcess(config) {
  if (state.panelBotProcesses[config.id]) {
    log(`Panel bot "${config.name}" is already running`, 'warn');
    return;
  }

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  if (!fs.existsSync(botDir)) {
    log(`Panel bot directory not found for "${config.name}"`, 'error');
    setPanelBotStatus(config.id, 'crashed');
    return;
  }

  log(`Starting panel bot "${config.name}"...`, 'info', config.id);
  setPanelBotStatus(config.id, 'starting');

  // Merge environment variables from config
  const env = {
    ...process.env,
    BOT_ID: config.id,
    BOT_NAME: config.name,
    ...(config.envVars || {})
  };

  const proc = spawn('node', [config.entryPoint || 'index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.panelBotProcesses[config.id] = proc;
  proc.startTime = Date.now();

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', config.id));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', config.id));

  proc.on('spawn', () => setPanelBotStatus(config.id, 'running'));

  proc.on('exit', (code) => {
    delete state.panelBotProcesses[config.id];
    const status = code === 0 ? 'stopped' : 'crashed';
    setPanelBotStatus(config.id, status);
    log(`Panel bot "${config.name}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', config.id);

    // Auto-restart if enabled and crashed
    if (config.autoRestart && status === 'crashed') {
      log(`Auto-restarting panel bot "${config.name}" in 5 seconds...`, 'warn', config.id);
      setTimeout(() => {
        const configs = loadBotConfigs();
        const updatedConfig = configs.find(c => c.id === config.id);
        if (updatedConfig && updatedConfig.autoRestart) {
          startPanelBotProcess(updatedConfig);
        }
      }, 5000);
    }
  });
}

function stopPanelBotProcess(botId) {
  const proc = state.panelBotProcesses[botId];
  if (proc) {
    proc.kill('SIGTERM');
    delete state.panelBotProcesses[botId];
    setPanelBotStatus(botId, 'stopped');
    log(`Panel bot "${botId}" stopped`, 'warn', botId);
  }
}

// ───────── Cleanup ─────────────────────────────────────────────────────────────────────────────
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

// ───────── Keep-Alive Ping ─────────────────────────────────────────────────────────────────────
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

// ───────── WebSocket Server ───────────────────────────────────────────────────────────────────
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
  const botConfigs = loadBotConfigs();
  ws.send(JSON.stringify({
    type: 'init',
    logs: logBuffer.slice(-150),
    sessions,
    panelBots: botConfigs,
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

// ───────── Cron Jobs ──────────────────────────────────────────────────────────────────────────
// Cleanup every 6 hours
cron.schedule('0 */6 * * *', runCleanup);

// ────────────────────────────────────────────────────────────────────────────────
// GitHub Repo Upload for Panel Bots
// ────────────────────────────────────────────────────────────────────────────────
app.post('/api/panel-bots/upload-github', requireAuth, async (req, res) => {
  const { repoUrl, name, description, entryPoint, branch } = req.body || {};
  
  if (!repoUrl) {
    return res.status(400).json({ error: 'GitHub repository URL is required' });
  }

  // Validate GitHub URL
  const githubRegex = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)/;
  const match = repoUrl.match(githubRegex);
  if (!match) {
    return res.status(400).json({ error: 'Invalid GitHub URL. Use format: https://github.com/owner/repo' });
  }

  const owner = match[1];
  const repo = match[2];
  const repoName = repo.replace(/\.git$/, '');
  const botId = uuidv4();
  const botName = name || repoName;
  const botDescription = description || `Bot from ${owner}/${repoName}`;
  const botBranch = branch || 'main';
  const botEntryPoint = entryPoint || 'index.js';

  const extractDir = path.join(UPLOADED_BOTS_DIR, botId);
  fs.mkdirSync(extractDir, { recursive: true });

  log(`Cloning GitHub repo: ${owner}/${repoName}...`, 'info');

  try {
    // Clone the repository
    execSync(`git clone --depth 1 --branch ${botBranch} https://github.com/${owner}/${repoName}.git .`, {
      cwd: extractDir,
      stdio: 'pipe',
      timeout: 120000 // 2 minute timeout
    });

    // Remove .git directory to save space
    const gitDir = path.join(extractDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    // Check for package.json and install dependencies
    const packageJsonPath = path.join(extractDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      log(`Installing dependencies for bot "${botName}"...`, 'info');
      try {
        execSync('npm install --production', { cwd: extractDir, stdio: 'pipe', timeout: 180000 });
        log(`Dependencies installed for bot "${botName}"`, 'ok');
      } catch (err) {
        log(`Warning: Could not install dependencies for "${botName}": ${err.message}`, 'warn');
      }
    }

    // Verify entry point exists
    const entryPath = path.join(extractDir, botEntryPoint);
    if (!fs.existsSync(entryPath)) {
      // Try to find any .js file
      const files = fs.readdirSync(extractDir);
      const jsFile = files.find(f => f.endsWith('.js'));
      if (jsFile) {
        log(`Entry point "${botEntryPoint}" not found, using "${jsFile}" instead`, 'warn');
      }
    }

    const config = {
      id: botId,
      name: botName,
      description: botDescription,
      entryPoint: botEntryPoint,
      ownerId: req.user.id,
      ownerUsername: req.user.username,
      status: 'stopped',
      source: 'github',
      sourceUrl: repoUrl,
      branch: botBranch,
      autoRestart: false,
      envVars: {},
      createdAt: new Date().toISOString(),
      path: extractDir
    };

    const configs = loadBotConfigs();
    configs.push(config);
    saveBotConfigs(configs);

    log(`Panel bot "${botName}" uploaded from GitHub by "${req.user.username}"`, 'ok');
    broadcast({ type: 'panel-bot-created', bot: config });
    res.json({ ok: true, bot: config });
  } catch (err) {
    // Clean up on failure
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    log(`Failed to clone GitHub repo: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to clone repository: ' + err.message });
  }
});

// Update bot from GitHub
app.post('/api/panel-bots/:botId/update-github', requireAuth, async (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (config.source !== 'github' || !config.sourceUrl) {
    return res.status(400).json({ error: 'This bot was not uploaded from GitHub' });
  }

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  if (!fs.existsSync(botDir)) {
    return res.status(404).json({ error: 'Bot directory not found' });
  }

  // Stop the bot if running
  const wasRunning = config.status === 'running';
  if (wasRunning) {
    stopPanelBotProcess(config.id);
  }

  log(`Updating bot "${config.name}" from GitHub...`, 'info');

  try {
    // Clone to a temporary directory
    const branch = config.branch || 'main';
    const tempDir = path.join(UPLOADED_BOTS_DIR, 'temp-' + config.id);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    execSync(`git clone --depth 1 --branch ${branch} ${config.sourceUrl}.git .`, {
      cwd: tempDir,
      stdio: 'pipe',
      timeout: 120000
    });

    // Remove .git directory from temp
    const tempGitDir = path.join(tempDir, '.git');
    if (fs.existsSync(tempGitDir)) {
      fs.rmSync(tempGitDir, { recursive: true, force: true });
    }

    // Remove all files from bot directory except .env
    const files = fs.readdirSync(botDir);
    for (const file of files) {
      if (file !== '.env') {
        fs.rmSync(path.join(botDir, file), { recursive: true, force: true });
      }
    }

    // Move files from temp to bot directory
    const tempFiles = fs.readdirSync(tempDir);
    for (const file of tempFiles) {
      const src = path.join(tempDir, file);
      const dest = path.join(botDir, file);
      fs.renameSync(src, dest);
    }

    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });

    // Install dependencies
    const packageJsonPath = path.join(botDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        execSync('npm install --production', { cwd: botDir, stdio: 'pipe', timeout: 180000 });
      } catch (err) {
        log(`Warning: Could not install dependencies: ${err.message}`, 'warn');
      }
    }

    // Update config
    config.updatedAt = new Date().toISOString();
    saveBotConfigs(configs);

    log(`Bot "${config.name}" updated successfully from GitHub`, 'ok');
    broadcast({ type: 'panel-bot-updated', bot: config });

    // Restart if it was running
    if (wasRunning) {
      setTimeout(() => startPanelBotProcess(config), 1500);
    }

    res.json({ ok: true, bot: config });
  } catch (err) {
    log(`Failed to update bot from GitHub: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to update from GitHub: ' + err.message });
  }
});

// Get bot files (file browser)
app.get('/api/panel-bots/:botId/files', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  const relPath = req.query.path || '';
  const targetDir = path.join(botDir, relPath);

  // Security: ensure we're not escaping the bot directory
  if (!targetDir.startsWith(botDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }

  try {
    const stats = fs.statSync(targetDir);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory' });
    }

    const items = fs.readdirSync(targetDir).map(name => {
      const itemPath = path.join(targetDir, name);
      const itemStats = fs.statSync(itemPath);
      return {
        name,
        type: itemStats.isDirectory() ? 'directory' : 'file',
        size: itemStats.size,
        modified: itemStats.mtime,
        path: path.join(relPath, name).replace(/\\/g, '/')
      };
    });

    // Sort: directories first, then files, alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ 
      path: relPath, 
      items,
      parent: relPath ? path.dirname(relPath).replace(/\\/g, '/') : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read directory: ' + err.message });
  }
});

// Get file content
app.get('/api/panel-bots/:botId/files/content', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  const relPath = req.query.path || '';
  const filePath = path.join(botDir, relPath);

  // Security: ensure we're not escaping the bot directory
  if (!filePath.startsWith(botDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    // Only allow reading certain file types
    const ext = path.extname(filePath).toLowerCase();
    const allowedExts = ['.js', '.json', '.md', '.txt', '.env', '.yml', '.yaml', '.ts', '.mjs', '.cjs'];
    if (!allowedExts.includes(ext) && !filePath.endsWith('.env')) {
      return res.status(400).json({ error: 'File type not supported for viewing' });
    }

    // Limit file size
    if (stats.size > 1024 * 1024) { // 1MB limit
      return res.status(400).json({ error: 'File too large to view' });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ 
      path: relPath, 
      content,
      size: stats.size,
      modified: stats.mtime
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read file: ' + err.message });
  }
});

// Update file content
app.put('/api/panel-bots/:botId/files/content', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { path: relPath, content } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'File path required' });

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  const filePath = path.join(botDir, relPath);

  // Security: ensure we're not escaping the bot directory
  if (!filePath.startsWith(botDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    fs.writeFileSync(filePath, content, 'utf8');
    log(`File "${relPath}" updated for bot "${config.name}"`, 'ok');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file: ' + err.message });
  }
});

// Get/Set environment variables for a bot
app.get('/api/panel-bots/:botId/env', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  res.json({ envVars: config.envVars || {} });
});

app.put('/api/panel-bots/:botId/env', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const idx = configs.findIndex(c => c.id === req.params.botId);
  
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && configs[idx].ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { envVars } = req.body || {};
  if (typeof envVars !== 'object') {
    return res.status(400).json({ error: 'envVars must be an object' });
  }

  configs[idx].envVars = envVars;
  saveBotConfigs(configs);

  // Also write to .env file in bot directory
  const botDir = path.join(UPLOADED_BOTS_DIR, configs[idx].id);
  const envContent = Object.entries(envVars)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  fs.writeFileSync(path.join(botDir, '.env'), envContent, 'utf8');

  log(`Environment variables updated for bot "${configs[idx].name}"`, 'ok');
  res.json({ ok: true });
});

// Set auto-restart option
app.put('/api/panel-bots/:botId/auto-restart', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const idx = configs.findIndex(c => c.id === req.params.botId);
  
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && configs[idx].ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { enabled } = req.body || {};
  configs[idx].autoRestart = !!enabled;
  saveBotConfigs(configs);

  res.json({ ok: true, autoRestart: configs[idx].autoRestart });
});

// Get bot statistics
app.get('/api/panel-bots/:botId/stats', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  const stats = {
    status: config.status || 'stopped',
    createdAt: config.createdAt,
    updatedAt: config.updatedAt || null,
    source: config.source || 'upload',
    sourceUrl: config.sourceUrl || null,
    branch: config.branch || null,
    autoRestart: config.autoRestart || false
  };

  // Get directory size
  if (fs.existsSync(botDir)) {
    let totalSize = 0;
    const calculateSize = (dir) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        const itemStats = fs.statSync(itemPath);
        if (itemStats.isDirectory()) {
          calculateSize(itemPath);
        } else {
          totalSize += itemStats.size;
        }
      }
    };
    try {
      calculateSize(botDir);
      stats.sizeBytes = totalSize;
      stats.sizeMB = (totalSize / 1024 / 1024).toFixed(2);
    } catch (err) {
      stats.sizeBytes = 0;
      stats.sizeMB = '0';
    }
  }

  // Get process info if running
  if (state.panelBotProcesses[config.id]) {
    stats.uptime = state.panelBotProcesses[config.id].uptime || 0;
  }

  res.json(stats);
});

// ───────── Start ───────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`LADYBUGNODES V(5) running on port ${PORT}`, 'ok');
  if (RENDER_URL) log(`Keep-alive targeting: ${RENDER_URL}`, 'info');
  else log(`Set RENDER_URL env var to enable keep-alive pings`, 'warn');
});

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down bots...', 'warn');
  Object.keys(state.botProcesses).forEach(stopBotProcess);
  Object.keys(state.panelBotProcesses).forEach(stopPanelBotProcess);
  process.exit(0);
});