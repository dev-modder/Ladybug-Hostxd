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
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const chalk      = require('chalk');
const multer     = require('multer');
const AdmZip     = require('adm-zip');

// Database
const { connectDB, isMongoConnected, fileStorage } = require('./db');
const User = require('./models/User');
const Session = require('./models/Session');
const BotConfig = require('./models/BotConfig');
const Setting = require('./models/Setting');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const RENDER_URL   = process.env.RENDER_URL || '';
const JWT_SECRET   = process.env.JWT_SECRET || 'ladybugnodes-secret-change-me';
const PING_INTERVAL_MS = 14 * 60 * 1000;  // 14 minutes

// Default admin credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'devntando';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ntando';

// Coin cost per bot start
const COIN_COST_START = 5;

// Data paths
const DATA_DIR      = path.join(__dirname, 'data');
const UPLOADED_BOTS_DIR = path.join(DATA_DIR, 'uploaded-bots');
const PUBLIC_DIR    = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADED_BOTS_DIR)) fs.mkdirSync(UPLOADED_BOTS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Multer Config for Bot Uploads
// ─────────────────────────────────────────────────────────────────────────────
const uploadZip = multer({
  dest: UPLOADED_BOTS_DIR,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.zip' || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed') {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are allowed'));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// ─────────────────────────────────────────────────────────────────────────────
// Server State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  pingCount: 0,
  cleanCount: 0,
  startTime: Date.now(),
  botProcesses: {},
  panelBotProcesses: {}
};

// ─────────────────────────────────────────────────────────────────────────────
// Log Buffer
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Database Helpers with Fallback
// ─────────────────────────────────────────────────────────────────────────────
const DB_FILES = {
  users: 'users.json',
  sessions: 'sessions.json',
  botConfigs: 'bot-configs.json'
};

// User operations
async function findUser(query) {
  if (isMongoConnected()) {
    if (query.id) return await User.findById(query.id);
    if (query.username) return await User.findOne({ username: query.username });
    return null;
  }
  const users = fileStorage.load(DB_FILES.users);
  if (query.id) return users.find(u => u.id === query.id);
  if (query.username) return users.find(u => u.username === query.username);
  return null;
}

async function saveUser(userData) {
  if (isMongoConnected()) {
    const user = new User(userData);
    await user.save();
    return user;
  }
  const users = fileStorage.load(DB_FILES.users);
  const newUser = { id: uuidv4(), ...userData, createdAt: new Date().toISOString() };
  users.push(newUser);
  fileStorage.save(DB_FILES.users, users);
  return newUser;
}

async function getAllUsers() {
  if (isMongoConnected()) {
    return await User.find({}, '-password');
  }
  return fileStorage.load(DB_FILES.users).map(u => {
    const { password, ...rest } = u;
    return rest;
  });
}

async function updateUser(userId, updates) {
  if (isMongoConnected()) {
    return await User.findByIdAndUpdate(userId, updates, { new: true });
  }
  const users = fileStorage.load(DB_FILES.users);
  const idx = users.findIndex(u => u.id === userId || u._id === userId);
  if (idx !== -1) {
    Object.assign(users[idx], updates);
    fileStorage.save(DB_FILES.users, users);
    return users[idx];
  }
  return null;
}

async function deleteUserFromDB(userId) {
  if (isMongoConnected()) {
    return await User.findByIdAndDelete(userId);
  }
  let users = fileStorage.load(DB_FILES.users);
  users = users.filter(u => u.id !== userId && u._id !== userId);
  fileStorage.save(DB_FILES.users, users);
  return true;
}

// Session operations
async function getSessions(ownerId = null) {
  if (isMongoConnected()) {
    const query = ownerId ? { ownerId } : {};
    return await Session.find(query);
  }
  let sessions = fileStorage.load(DB_FILES.sessions);
  if (ownerId) {
    sessions = sessions.filter(s => s.ownerId === ownerId);
  }
  return sessions;
}

async function createSession(data) {
  if (isMongoConnected()) {
    const session = new Session(data);
    await session.save();
    return session;
  }
  const sessions = fileStorage.load(DB_FILES.sessions);
  const newSession = { id: uuidv4(), ...data, createdAt: new Date().toISOString() };
  sessions.push(newSession);
  fileStorage.save(DB_FILES.sessions, sessions);
  return newSession;
}

async function updateSession(sessionId, updates) {
  if (isMongoConnected()) {
    return await Session.findByIdAndUpdate(sessionId, updates, { new: true });
  }
  const sessions = fileStorage.load(DB_FILES.sessions);
  const idx = sessions.findIndex(s => s.id === sessionId || s._id === sessionId);
  if (idx !== -1) {
    Object.assign(sessions[idx], updates);
    fileStorage.save(DB_FILES.sessions, sessions);
    return sessions[idx];
  }
  return null;
}

async function deleteSessionFromDB(sessionId) {
  if (isMongoConnected()) {
    return await Session.findByIdAndDelete(sessionId);
  }
  let sessions = fileStorage.load(DB_FILES.sessions);
  sessions = sessions.filter(s => s.id !== sessionId && s._id !== sessionId);
  fileStorage.save(DB_FILES.sessions, sessions);
  return true;
}

async function findSession(sessionId) {
  if (isMongoConnected()) {
    return await Session.findById(sessionId);
  }
  const sessions = fileStorage.load(DB_FILES.sessions);
  return sessions.find(s => s.id === sessionId || s._id === sessionId);
}

// BotConfig operations
async function getBotConfigs(ownerId = null) {
  if (isMongoConnected()) {
    const query = ownerId ? { ownerId } : {};
    return await BotConfig.find(query);
  }
  let configs = fileStorage.load(DB_FILES.botConfigs);
  if (ownerId) {
    configs = configs.filter(c => c.ownerId === ownerId);
  }
  return configs;
}

async function createBotConfig(data) {
  if (isMongoConnected()) {
    const config = new BotConfig(data);
    await config.save();
    return config;
  }
  const configs = fileStorage.load(DB_FILES.botConfigs);
  const newConfig = { id: uuidv4(), ...data, createdAt: new Date().toISOString() };
  configs.push(newConfig);
  fileStorage.save(DB_FILES.botConfigs, configs);
  return newConfig;
}

async function updateBotConfig(botId, updates) {
  if (isMongoConnected()) {
    return await BotConfig.findByIdAndUpdate(botId, updates, { new: true });
  }
  const configs = fileStorage.load(DB_FILES.botConfigs);
  const idx = configs.findIndex(c => c.id === botId || c._id === botId);
  if (idx !== -1) {
    Object.assign(configs[idx], updates);
    fileStorage.save(DB_FILES.botConfigs, configs);
    return configs[idx];
  }
  return null;
}

async function deleteBotConfigFromDB(botId) {
  if (isMongoConnected()) {
    return await BotConfig.findByIdAndDelete(botId);
  }
  let configs = fileStorage.load(DB_FILES.botConfigs);
  configs = configs.filter(c => c.id !== botId && c._id !== botId);
  fileStorage.save(DB_FILES.botConfigs, configs);
  return true;
}

async function findBotConfig(botId) {
  if (isMongoConnected()) {
    return await BotConfig.findById(botId);
  }
  const configs = fileStorage.load(DB_FILES.botConfigs);
  return configs.find(c => c.id === botId || c._id === botId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure Admin Exists
// ─────────────────────────────────────────────────────────────────────────────
async function ensureAdminExists() {
  const existingAdmin = await findUser({ username: ADMIN_USERNAME });
  if (!existingAdmin) {
    if (isMongoConnected()) {
      const admin = new User({
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD, // Will be hashed by pre-save hook
        role: 'admin',
        coins: 999
      });
      await admin.save();
      log(`Admin user "${ADMIN_USERNAME}" created in MongoDB`, 'ok');
    } else {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      await saveUser({
        username: ADMIN_USERNAME,
        password: hash,
        role: 'admin',
        coins: 999
      });
      log(`Admin user "${ADMIN_USERNAME}" created in file storage`, 'ok');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Auth Routes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const user = await findUser({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    let isValidPassword = false;
    if (isMongoConnected()) {
      isValidPassword = await user.comparePassword(password);
    } else {
      const bcrypt = require('bcryptjs');
      isValidPassword = bcrypt.compareSync(password, user.password);
    }

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userId = user._id || user.id;
    const token = jwt.sign({ id: userId, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    log(`User "${username}" logged in`, 'ok');
    res.json({ ok: true, token, user: { id: userId, username: user.username, role: user.role, coins: user.coins } });
  } catch (err) {
    log(`Login error: ${err.message}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/register', requireAdmin, async (req, res) => {
  const { username, password, coins = 50 } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const existing = await findUser({ username });
    if (existing) return res.status(409).json({ error: 'Username already exists' });

    let newUser;
    if (isMongoConnected()) {
      newUser = new User({ username, password, role: 'user', coins: Number(coins) });
      await newUser.save();
    } else {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(password, 10);
      newUser = await saveUser({ username, password: hash, role: 'user', coins: Number(coins) });
    }

    const userId = newUser._id || newUser.id;
    log(`Admin created user "${username}" with ${coins} coins`, 'ok');
    res.json({ ok: true, user: { id: userId, username, role: 'user', coins: newUser.coins } });
  } catch (err) {
    log(`Registration error: ${err.message}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await findUser({ id: req.user.id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const userId = user._id || user.id;
    res.json({ id: userId, username: user.username, role: user.role, coins: user.coins });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Coin Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/coins', requireAuth, async (req, res) => {
  try {
    const user = await findUser({ id: req.user.id });
    res.json({ coins: user ? user.coins : 0 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/coins/add', requireAdmin, async (req, res) => {
  const { userId, username, amount } = req.body || {};
  if (isNaN(amount) || Number(amount) === 0) return res.status(400).json({ error: 'Valid amount required' });

  try {
    let user = userId ? await findUser({ id: userId }) : await findUser({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newCoins = Math.max(0, (user.coins || 0) + Number(amount));
    user = await updateUser(user._id || user.id, { coins: newCoins });
    
    const finalId = user._id || user.id;
    log(`Admin added ${amount} coins to "${user.username}" (total: ${newCoins})`, 'ok');
    broadcast({ type: 'coins-updated', userId: finalId, coins: newCoins });
    res.json({ ok: true, coins: newCoins });
  } catch (err) {
    log(`Coin add error: ${err.message}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await findUser({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
    
    await deleteUserFromDB(req.params.id);
    log(`Admin deleted user "${user.username}"`, 'warn');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Session Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' ? null : req.user.id;
    const sessions = await getSessions(ownerId);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/sessions', requireAuth, async (req, res) => {
  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone, botId } = req.body || {};
  if (!ownerName || !sessionIdString) return res.status(400).json({ error: 'ownerName and sessionIdString required' });

  try {
    const sessionData = {
      ownerId: req.user.id,
      ownerName,
      ownerNumber: ownerNumber || '',
      sessionIdString,
      botName: botName || 'LadybugBot',
      prefix: prefix || '.',
      timezone: timezone || 'Africa/Harare',
      botId: botId || null,
      status: 'stopped'
    };
    
    const newSess = await createSession(sessionData);
    const sessionId = newSess._id || newSess.id;
    log(`Session "${sessionId}" created by "${req.user.username}"`, 'ok');
    broadcast({ type: 'session-created', session: newSess });
    res.json({ ok: true, session: newSess });
  } catch (err) {
    log(`Session create error: ${err.message}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const session = await findSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    const ownerId = session.ownerId?._id || session.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const allowed = ['ownerName', 'ownerNumber', 'sessionIdString', 'botName', 'prefix', 'timezone', 'botId'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    
    const updated = await updateSession(req.params.id, updates);
    broadcast({ type: 'session-updated', session: updated });
    res.json({ ok: true, session: updated });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const session = await findSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    const ownerId = session.ownerId?._id || session.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopBotProcess(req.params.id);
    await deleteSessionFromDB(req.params.id);
    log(`Session "${req.params.id}" deleted`, 'warn');
    broadcast({ type: 'session-deleted', sessionId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Panel Bot Management Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/panel-bots', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' ? null : req.user.id;
    const configs = await getBotConfigs(ownerId);
    res.json(configs);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/panel-bots/:botId', requireAuth, async (req, res) => {
  try {
    const config = await findBotConfig(req.params.botId);
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    
    const ownerId = config.ownerId?._id || config.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload bot from ZIP file
app.post('/api/panel-bots/upload', requireAuth, uploadZip.single('botZip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const botId = uuidv4();
  const botName = req.body.name || path.parse(req.file.originalname).name;
  const botDescription = req.body.description || '';
  const entryPoint = req.body.entryPoint || 'index.js';
  
  const extractDir = path.join(UPLOADED_BOTS_DIR, botId);
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // Extract the ZIP file
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(req.file.path); // Remove temp zip file

    // Find and handle nested directories
    let actualBotDir = extractDir;
    const files = fs.readdirSync(extractDir);
    if (files.length === 1 && fs.statSync(path.join(extractDir, files[0])).isDirectory()) {
      // ZIP had a single root folder, use that
      actualBotDir = path.join(extractDir, files[0]);
    }

    // Check for package.json and install dependencies
    const packageJsonPath = path.join(actualBotDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      log(`Installing dependencies for bot "${botName}"...`, 'info');
      try {
        execSync('npm install --production', { cwd: actualBotDir, stdio: 'pipe', timeout: 120000 });
        log(`Dependencies installed for bot "${botName}"`, 'ok');
      } catch (err) {
        log(`Warning: Could not install dependencies for "${botName}": ${err.message}`, 'warn');
      }
    }

    // Find entry point
    let finalEntryPoint = entryPoint;
    const entryPath = path.join(actualBotDir, entryPoint);
    if (!fs.existsSync(entryPath)) {
      const botFiles = fs.readdirSync(actualBotDir);
      const jsFile = botFiles.find(f => f.endsWith('.js'));
      if (jsFile) {
        finalEntryPoint = jsFile;
        log(`Entry point "${entryPoint}" not found, using "${jsFile}" instead`, 'warn');
      }
    }

    // Create config
    const configData = {
      name: botName,
      description: botDescription,
      entryPoint: finalEntryPoint,
      ownerId: req.user.id,
      ownerUsername: req.user.username,
      sourceType: 'upload',
      status: 'stopped',
      path: actualBotDir
    };
    
    const config = await createBotConfig(configData);
    const configId = config._id || config.id;

    log(`Panel bot "${botName}" uploaded by "${req.user.username}"`, 'ok');
    broadcast({ type: 'panel-bot-created', bot: config });
    res.json({ ok: true, bot: config });
  } catch (err) {
    // Cleanup on error
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    log(`Failed to extract bot: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to extract bot: ' + err.message });
  }
});

// Upload bot from GitHub repository
app.post('/api/panel-bots/github', requireAuth, async (req, res) => {
  const { githubUrl, name, description, entryPoint, branch } = req.body || {};
  
  if (!githubUrl) return res.status(400).json({ error: 'GitHub URL is required' });
  if (!name) return res.status(400).json({ error: 'Bot name is required' });

  const botId = uuidv4();
  const botDir = path.join(UPLOADED_BOTS_DIR, botId);
  
  // Parse GitHub URL
  let repoUrl = githubUrl;
  if (githubUrl.includes('github.com')) {
    // Convert to clone URL if needed
    if (!githubUrl.endsWith('.git')) {
      repoUrl = githubUrl.replace(/\/$/, '') + '.git';
    }
  }

  log(`Cloning bot "${name}" from GitHub: ${repoUrl}`, 'info');

  try {
    fs.mkdirSync(botDir, { recursive: true });
    
    // Clone the repository
    const cloneBranch = branch || 'main';
    execSync(`git clone --depth 1 --branch ${cloneBranch} "${repoUrl}" .`, {
      cwd: botDir,
      stdio: 'pipe',
      timeout: 120000
    });

    // Install dependencies
    const packageJsonPath = path.join(botDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      log(`Installing dependencies for bot "${name}"...`, 'info');
      try {
        execSync('npm install --production', { cwd: botDir, stdio: 'pipe', timeout: 180000 });
        log(`Dependencies installed for bot "${name}"`, 'ok');
      } catch (err) {
        log(`Warning: Could not install dependencies: ${err.message}`, 'warn');
      }
    }

    // Find entry point
    let finalEntryPoint = entryPoint || 'index.js';
    const entryPath = path.join(botDir, finalEntryPoint);
    if (!fs.existsSync(entryPath)) {
      const files = fs.readdirSync(botDir);
      const jsFile = files.find(f => f.endsWith('.js'));
      if (jsFile) {
        finalEntryPoint = jsFile;
        log(`Entry point "${entryPoint}" not found, using "${jsFile}"`, 'warn');
      }
    }

    // Create config
    const configData = {
      name,
      description: description || '',
      entryPoint: finalEntryPoint,
      ownerId: req.user.id,
      ownerUsername: req.user.username,
      sourceType: 'github',
      githubUrl: repoUrl,
      status: 'stopped',
      path: botDir
    };
    
    const config = await createBotConfig(configData);

    log(`Panel bot "${name}" cloned from GitHub by "${req.user.username}"`, 'ok');
    broadcast({ type: 'panel-bot-created', bot: config });
    res.json({ ok: true, bot: config });
  } catch (err) {
    // Cleanup on error
    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }
    log(`Failed to clone bot from GitHub: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to clone from GitHub: ' + err.message });
  }
});

// Update panel bot config
app.put('/api/panel-bots/:botId', requireAuth, async (req, res) => {
  try {
    const config = await findBotConfig(req.params.botId);
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    
    const ownerId = config.ownerId?._id || config.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const allowed = ['name', 'description', 'entryPoint'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    
    const updated = await updateBotConfig(req.params.botId, updates);
    broadcast({ type: 'panel-bot-updated', bot: updated });
    res.json({ ok: true, bot: updated });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a panel bot
app.delete('/api/panel-bots/:botId', requireAuth, async (req, res) => {
  try {
    const config = await findBotConfig(req.params.botId);
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    
    const ownerId = config.ownerId?._id || config.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopPanelBotProcess(req.params.botId);

    // Remove bot directory
    const botDir = config.path || path.join(UPLOADED_BOTS_DIR, req.params.botId);
    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }

    await deleteBotConfigFromDB(req.params.botId);
    log(`Panel bot "${config.name}" deleted`, 'warn');
    broadcast({ type: 'panel-bot-deleted', botId: req.params.botId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Start a panel bot
app.post('/api/panel-bots/:botId/start', requireAuth, async (req, res) => {
  try {
    const config = await findBotConfig(req.params.botId);
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    
    const ownerId = config.ownerId?._id || config.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Coin check (skip for admin)
    if (req.user.role !== 'admin') {
      const user = await findUser({ id: req.user.id });
      if (!user || user.coins < COIN_COST_START) {
        return res.status(402).json({ error: `Not enough coins. Starting a bot costs ${COIN_COST_START} coins.` });
      }
      const newCoins = user.coins - COIN_COST_START;
      await updateUser(user._id || user.id, { coins: newCoins });
      const userId = user._id || user.id;
      broadcast({ type: 'coins-updated', userId, coins: newCoins });
    }

    startPanelBotProcess(config);
    res.json({ ok: true });
  } catch (err) {
    log(`Bot start error: ${err.message}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Stop a panel bot
app.post('/api/panel-bots/:botId/stop', requireAuth, async (req, res) => {
  try {
    const config = await findBotConfig(req.params.botId);
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    
    const ownerId = config.ownerId?._id || config.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopPanelBotProcess(req.params.botId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Restart a panel bot
app.post('/api/panel-bots/:botId/restart', requireAuth, async (req, res) => {
  try {
    const config = await findBotConfig(req.params.botId);
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    
    const ownerId = config.ownerId?._id || config.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopPanelBotProcess(req.params.botId);
    setTimeout(() => startPanelBotProcess(config), 1500);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get bot logs
app.get('/api/panel-bots/:botId/logs', requireAuth, async (req, res) => {
  try {
    const config = await findBotConfig(req.params.botId);
    if (!config) return res.status(404).json({ error: 'Bot not found' });
    
    const ownerId = config.ownerId?._id || config.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const botLogs = logBuffer.filter(l => l.sessionId === req.params.botId);
    res.json({ logs: botLogs });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bot Control Routes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/bot/start', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  
  try {
    const sess = await findSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    
    const ownerId = sess.ownerId?._id || sess.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Coin check (skip for admin)
    if (req.user.role !== 'admin') {
      const user = await findUser({ id: req.user.id });
      if (!user || user.coins < COIN_COST_START) {
        return res.status(402).json({ error: `Not enough coins. Starting a bot costs ${COIN_COST_START} coins.` });
      }
      const newCoins = user.coins - COIN_COST_START;
      await updateUser(user._id || user.id, { coins: newCoins });
      const userId = user._id || user.id;
      broadcast({ type: 'coins-updated', userId, coins: newCoins });
      log(`${COIN_COST_START} coins deducted from "${user.username}" for bot start (remaining: ${newCoins})`, 'warn');
    }

    startBotProcess(sess);
    res.json({ ok: true });
  } catch (err) {
    log(`Bot start error: ${err.message}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/bot/stop', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  
  try {
    const sess = await findSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    
    const ownerId = sess.ownerId?._id || sess.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopBotProcess(sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/bot/restart', requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  
  try {
    const sess = await findSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    
    const ownerId = sess.ownerId?._id || sess.ownerId;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    stopBotProcess(sessionId);
    setTimeout(async () => {
      const freshSess = await findSession(sessionId);
      if (freshSess) startBotProcess(freshSess);
    }, 1500);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/bot/cleanup', requireAdmin, (req, res) => {
  const result = runCleanup();
  res.json({ ok: true, ...result });
});

// ─────────────────────────────────────────────────────────────────────────────
// Install Bot Route
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/install-bot', requireAdmin, (req, res) => {
  try {
    log('Installing bot from GitHub...', 'info');
    const botDir = path.join(__dirname, 'bot-src');
    
    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }
    
    execSync('git clone --depth 1 https://github.com/dev-modder/Ladybug-Mini.git bot-src', {
      cwd: __dirname, stdio: 'pipe', timeout: 120000
    });
    
    execSync('npm install --production', { cwd: botDir, stdio: 'pipe', timeout: 180000 });
    log('Bot installed successfully!', 'ok');
    res.json({ ok: true });
  } catch (err) {
    log(`Bot install failed: ${err.message}`, 'error');
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Status & Health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    pingCount: state.pingCount,
    cleanCount: state.cleanCount,
    mem,
    dbType: isMongoConnected() ? 'mongodb' : 'file'
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ─────────────────────────────────────────────────────────────────────────────
// Serve HTML pages
// ─────────────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/panel-bots', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'panel-bots.html')));

// ─────────────────────────────────────────────────────────────────────────────
// Bot Process Manager
// ─────────────────────────────────────────────────────────────────────────────
async function setSessionStatus(sessionId, status) {
  try {
    await updateSession(sessionId, { status });
    broadcast({ type: 'status', sessionId, status });
  } catch (err) {
    log(`Error updating session status: ${err.message}`, 'error');
  }
}

async function startBotProcess(sess) {
  const sessionId = sess._id || sess.id;
  
  if (state.botProcesses[sessionId]) {
    log(`Bot "${sessionId}" is already running`, 'warn');
    return;
  }

  // Check if this session uses a panel bot
  const botId = sess.botId?._id || sess.botId;
  if (botId) {
    const botConfig = await findBotConfig(botId);
    if (botConfig) {
      await startPanelBotForSession(sess, botConfig);
      return;
    }
  }

  // Default bot source
  const botDir = path.join(__dirname, 'bot-src');
  if (!fs.existsSync(botDir)) {
    log(`Bot source not found. Click "Install Bot" first.`, 'error');
    await setSessionStatus(sessionId, 'crashed');
    return;
  }

  log(`Starting bot for session "${sessionId}" (${sess.ownerName})...`, 'info', sessionId);
  await setSessionStatus(sessionId, 'starting');

  const env = {
    ...process.env,
    SESSION_ID: sess.sessionIdString,
    BOT_NAME: sess.botName || 'LadybugBot',
    PREFIX: sess.prefix || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ: sess.timezone || 'Africa/Harare'
  };

  const proc = spawn('node', ['index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.botProcesses[sessionId] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', sessionId));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', sessionId));

  proc.on('spawn', () => setSessionStatus(sessionId, 'running'));

  proc.on('exit', async (code) => {
    delete state.botProcesses[sessionId];
    const status = code === 0 ? 'stopped' : 'crashed';
    await setSessionStatus(sessionId, status);
    log(`Bot "${sessionId}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', sessionId);
  });
}

async function startPanelBotForSession(sess, botConfig) {
  const sessionId = sess._id || sess.id;
  
  if (state.botProcesses[sessionId]) {
    log(`Bot "${sessionId}" is already running`, 'warn');
    return;
  }

  const botDir = botConfig.path || path.join(UPLOADED_BOTS_DIR, botConfig._id || botConfig.id);
  if (!fs.existsSync(botDir)) {
    log(`Panel bot directory not found for "${botConfig.name}"`, 'error');
    await setSessionStatus(sessionId, 'crashed');
    return;
  }

  log(`Starting panel bot "${botConfig.name}" for session "${sessionId}"...`, 'info', sessionId);
  await setSessionStatus(sessionId, 'starting');

  const env = {
    ...process.env,
    SESSION_ID: sess.sessionIdString,
    BOT_NAME: sess.botName || botConfig.name,
    PREFIX: sess.prefix || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ: sess.timezone || 'Africa/Harare'
  };

  const proc = spawn('node', [botConfig.entryPoint || 'index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.botProcesses[sessionId] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', sessionId));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', sessionId));

  proc.on('spawn', () => setSessionStatus(sessionId, 'running'));

  proc.on('exit', async (code) => {
    delete state.botProcesses[sessionId];
    const status = code === 0 ? 'stopped' : 'crashed';
    await setSessionStatus(sessionId, status);
    log(`Panel bot "${botConfig.name}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', sessionId);
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

// ─────────────────────────────────────────────────────────────────────────────
// Panel Bot Process Manager
// ─────────────────────────────────────────────────────────────────────────────
async function setPanelBotStatus(botId, status) {
  try {
    await updateBotConfig(botId, { status });
    broadcast({ type: 'panel-bot-status', botId, status });
  } catch (err) {
    log(`Error updating panel bot status: ${err.message}`, 'error');
  }
}

async function startPanelBotProcess(config) {
  const botId = config._id || config.id;
  
  if (state.panelBotProcesses[botId]) {
    log(`Panel bot "${config.name}" is already running`, 'warn');
    return;
  }

  const botDir = config.path || path.join(UPLOADED_BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) {
    log(`Panel bot directory not found for "${config.name}"`, 'error');
    await setPanelBotStatus(botId, 'crashed');
    return;
  }

  log(`Starting panel bot "${config.name}"...`, 'info', botId);
  await setPanelBotStatus(botId, 'starting');

  const env = {
    ...process.env,
    BOT_ID: botId,
    BOT_NAME: config.name
  };

  const proc = spawn('node', [config.entryPoint || 'index.js'], { cwd: botDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.panelBotProcesses[botId] = proc;

  proc.stdout.on('data', d => log(d.toString().trim(), 'bot', botId));
  proc.stderr.on('data', d => log(d.toString().trim(), 'warn', botId));

  proc.on('spawn', () => setPanelBotStatus(botId, 'running'));

  proc.on('exit', async (code) => {
    delete state.panelBotProcesses[botId];
    const status = code === 0 ? 'stopped' : 'crashed';
    await setPanelBotStatus(botId, status);
    log(`Panel bot "${config.name}" exited with code ${code} → ${status}`, code === 0 ? 'warn' : 'error', botId);
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

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Keep-Alive Ping
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Server
// ─────────────────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', async (ws) => {
  clients.add(ws);

  try {
    const sessions = await getSessions();
    const botConfigs = await getBotConfigs();
    
    ws.send(JSON.stringify({
      type: 'init',
      logs: logBuffer.slice(-150),
      sessions,
      panelBots: botConfigs,
      serverStatus: {
        uptime: Math.floor((Date.now() - state.startTime) / 1000),
        pingCount: state.pingCount,
        cleanCount: state.cleanCount,
        mem: process.memoryUsage(),
        dbType: isMongoConnected() ? 'mongodb' : 'file'
      }
    }));
  } catch (err) {
    log(`WS init error: ${err.message}`, 'error');
  }

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron Jobs
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 */6 * * *', runCleanup);

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    // Connect to MongoDB first
    await connectDB();
    
    // Ensure admin exists
    await ensureAdminExists();
    
    // Start server
    server.listen(PORT, () => {
      log(`LADYBUGNODES v3.0.0 running on port ${PORT}`, 'ok');
      log(`Database: ${isMongoConnected() ? 'MongoDB' : 'File-based storage'}`, 'info');
      if (RENDER_URL) log(`Keep-alive targeting: ${RENDER_URL}`, 'info');
      else log(`Set RENDER_URL env var to enable keep-alive pings`, 'warn');
    });
  } catch (err) {
    log(`Server startup error: ${err.message}`, 'error');
    process.exit(1);
  }
}

startServer();

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down bots...', 'warn');
  Object.keys(state.botProcesses).forEach(stopBotProcess);
  Object.keys(state.panelBotProcesses).forEach(stopPanelBotProcess);
  process.exit(0);
});
