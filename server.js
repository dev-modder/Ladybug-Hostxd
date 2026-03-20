'use strict';

require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// LADYBUGNODES V5 - Advanced Multi-Host WhatsApp Bot Dashboard
// ─────────────────────────────────────────────────────────────────────────────

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
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const slowDown   = require('express-slow-down');
const xss        = require('xss');
const { authenticator } = require('otplib');
const QRCode     = require('qrcode');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const RENDER_URL   = process.env.RENDER_URL || '';
const JWT_SECRET   = process.env.JWT_SECRET || 'ladybugnodes-v5-secret-change-me';
const PING_INTERVAL_MS = 14 * 60 * 1000;

// Default admin credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'devntando';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ntando';

// Rate limiting config
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Data Paths
// ─────────────────────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const UPLOADED_BOTS_DIR = path.join(DATA_DIR, 'uploaded-bots');
const BOT_CONFIGS_FILE = path.join(DATA_DIR, 'bot-configs.json');
const ACTIVITY_LOG_FILE = path.join(DATA_DIR, 'activity-log.json');
const API_KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADED_BOTS_DIR)) fs.mkdirSync(UPLOADED_BOTS_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Multer Config for Bot Uploads
// ─────────────────────────────────────────────────────────────────────────────
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
  limits: { fileSize: 50 * 1024 * 1024 }
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
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ─────────────────────────────────────────────────────────────────────────────
// Data Store Functions
// ─────────────────────────────────────────────────────────────────────────────
function loadJSON(file, defaultValue = []) {
  try { 
    return JSON.parse(fs.readFileSync(file, 'utf8')); 
  } catch { 
    return defaultValue; 
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// User Store
function loadUsers() { return loadJSON(USERS_FILE, []); }
function saveUsers(users) { saveJSON(USERS_FILE, users); }

// Session Store
function loadSessions() { return loadJSON(SESSIONS_FILE, []); }
function saveSessions(sessions) { saveJSON(SESSIONS_FILE, sessions); }

// Bot Configs Store
function loadBotConfigs() { return loadJSON(BOT_CONFIGS_FILE, []); }
function saveBotConfigs(configs) { saveJSON(BOT_CONFIGS_FILE, configs); }

// Activity Log Store
function loadActivityLog() { return loadJSON(ACTIVITY_LOG_FILE, []); }
function saveActivityLog(logs) { saveJSON(ACTIVITY_LOG_FILE, logs.slice(-5000)); }

// API Keys Store
function loadApiKeys() { return loadJSON(API_KEYS_FILE, []); }
function saveApiKeys(keys) { saveJSON(API_KEYS_FILE, keys); }

// Settings Store
function loadSettings() { 
  return loadJSON(SETTINGS_FILE, {
    siteName: 'LADYBUGNODES',
    coinCostStart: 5,
    maxBotsPerUser: 10,
    maxUsersPerAdmin: 100,
    enable2FA: true,
    enableEmailNotifications: false,
    sessionTimeout: 24,
    maintenanceMode: false
  });
}
function saveSettings(settings) { saveJSON(SETTINGS_FILE, settings); }

// Templates Store
function loadTemplates() { return loadJSON(TEMPLATES_FILE, []); }
function saveTemplates(templates) { saveJSON(TEMPLATES_FILE, templates); }

// ─────────────────────────────────────────────────────────────────────────────
// Activity Logging
// ─────────────────────────────────────────────────────────────────────────────
function logActivity(userId, username, action, details = {}) {
  const logs = loadActivityLog();
  logs.push({
    id: uuidv4(),
    userId,
    username,
    action,
    details,
    ip: details.ip || 'unknown',
    timestamp: new Date().toISOString()
  });
  saveActivityLog(logs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialize Admin User
// ─────────────────────────────────────────────────────────────────────────────
function ensureAdminExists() {
  let users = loadUsers();
  if (!users.find(u => u.username === ADMIN_USERNAME)) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    const secret = authenticator.generateSecret();
    users.push({
      id: uuidv4(),
      username: ADMIN_USERNAME,
      password: hash,
      role: 'admin',
      coins: 999999999999999,
      twoFactorSecret: secret,
      twoFactorEnabled: false,
      email: process.env.ADMIN_EMAIL || '',
      createdAt: new Date().toISOString(),
      lastLogin: null,
      loginAttempts: 0,
      lockedUntil: null
    });
    saveUsers(users);
    console.log(chalk.green(`[AUTH] Admin user "${ADMIN_USERNAME}" created.`));
    console.log(chalk.cyan(`[AUTH] 2FA Secret: ${secret} (save this securely)`));
  }
}

ensureAdminExists();

// ─────────────────────────────────────────────────────────────────────────────
// Server State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  pingCount: 0,
  cleanCount: 0,
  startTime: Date.now(),
  botProcesses: {},
  panelBotProcesses: {},
  userSessions: {},
  rateLimitHits: {}
};

// ─────────────────────────────────────────────────────────────────────────────
// Log Buffer
// ─────────────────────────────────────────────────────────────────────────────
const MAX_LOG = 1000;
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
// Express App Setup with Security
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "https:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Rate limiting - General
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', generalLimiter);

// Rate limiting - Auth (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Slow down for repeated requests
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 50,
  delayMs: 500
});
app.use('/api/', speedLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Input Sanitization Middleware
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeInput(req, res, next) {
  const sanitize = (obj) => {
    if (typeof obj === 'string') return xss(obj);
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sanitize);
    const result = {};
    for (const key in obj) {
      result[key] = sanitize(obj[key]);
    }
    return result;
  };
  
  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);
  next();
}

app.use(sanitizeInput);

// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;
  
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      return res.status(403).json({ error: 'Account temporarily locked. Please try again later.' });
    }
    
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

// API Key Authentication
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  
  const keys = loadApiKeys();
  const key = keys.find(k => k.key === apiKey && k.active);
  
  if (!key) return res.status(401).json({ error: 'Invalid API key' });
  
  key.lastUsed = new Date().toISOString();
  saveApiKeys(keys);
  
  req.apiKey = key;
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost Configuration
// ─────────────────────────────────────────────────────────────────────────────
const settings = loadSettings();
const COIN_COST_START = settings.coinCostStart || 5;

// ─────────────────────────────────────────────────────────────────────────────
// Auth Routes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password, twoFactorCode } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const users = loadUsers();
  const user = users.find(u => u.username === username);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    const remaining = Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000);
    return res.status(403).json({ error: `Account locked. Try again in ${remaining} minutes.` });
  }
  
  if (!bcrypt.compareSync(password, user.password)) {
    user.loginAttempts = (user.loginAttempts || 0) + 1;
    
    if (user.loginAttempts >= 5) {
      user.lockedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      user.loginAttempts = 0;
      saveUsers(users);
      return res.status(403).json({ error: 'Account locked due to too many failed attempts. Try again in 30 minutes.' });
    }
    
    saveUsers(users);
    return res.status(401).json({ error: `Invalid credentials. ${5 - user.loginAttempts} attempts remaining.` });
  }
  
  // Check 2FA if enabled
  if (user.twoFactorEnabled && user.twoFactorSecret) {
    if (!twoFactorCode) {
      return res.status(200).json({ requires2FA: true, message: 'Two-factor authentication required' });
    }
    
    const isValidCode = authenticator.check(twoFactorCode, user.twoFactorSecret);
    if (!isValidCode) {
      return res.status(401).json({ error: 'Invalid two-factor code' });
    }
  }
  
  user.loginAttempts = 0;
  user.lockedUntil = null;
  user.lastLogin = new Date().toISOString();
  saveUsers(users);
  
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: `${settings.sessionTimeout || 24}h` }
  );
  
  logActivity(user.id, user.username, 'login', { ip: req.ip });
  
  log(`User "${username}" logged in`, 'ok');
  res.json({ 
    ok: true, 
    token, 
    user: { 
      id: user.id, 
      username: user.username, 
      role: user.role, 
      coins: user.coins,
      twoFactorEnabled: user.twoFactorEnabled || false
    } 
  });
});

// Setup 2FA
app.post('/api/auth/2fa/setup', requireAuth, async (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const secret = authenticator.generateSecret();
  user.twoFactorSecret = secret;
  saveUsers(users);
  
  const otpauth = authenticator.keyuri(user.username, 'LADYBUGNODES', secret);
  const qrImage = await QRCode.toDataURL(otpauth);
  
  res.json({ 
    ok: true, 
    secret, 
    qrImage,
    message: 'Scan this QR code with your authenticator app'
  });
});

// Enable 2FA
app.post('/api/auth/2fa/enable', requireAuth, (req, res) => {
  const { code } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user || !user.twoFactorSecret) {
    return res.status(400).json({ error: '2FA not set up' });
  }
  
  const isValid = authenticator.check(code, user.twoFactorSecret);
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  
  user.twoFactorEnabled = true;
  saveUsers(users);
  
  logActivity(user.id, user.username, '2fa_enabled', { ip: req.ip });
  
  res.json({ ok: true, message: 'Two-factor authentication enabled' });
});

// Disable 2FA
app.post('/api/auth/2fa/disable', requireAuth, (req, res) => {
  const { code, password } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  if (user.twoFactorEnabled && user.twoFactorSecret) {
    const isValid = authenticator.check(code, user.twoFactorSecret);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid 2FA code' });
    }
  }
  
  user.twoFactorEnabled = false;
  user.twoFactorSecret = null;
  saveUsers(users);
  
  logActivity(user.id, user.username, '2fa_disabled', { ip: req.ip });
  
  res.json({ ok: true, message: 'Two-factor authentication disabled' });
});

app.post('/api/auth/register', requireAdmin, (req, res) => {
  const { username, password, coins = 50, email } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const users = loadUsers();
  
  if (users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const newUser = { 
    id: uuidv4(), 
    username, 
    password: hash, 
    role: 'user', 
    coins: Number(coins),
    email: email || '',
    twoFactorSecret: null,
    twoFactorEnabled: false,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    loginAttempts: 0,
    lockedUntil: null
  };
  
  users.push(newUser);
  saveUsers(users);
  
  logActivity(req.user.id, req.user.username, 'user_created', { targetUser: username, coins });
  log(`Admin created user "${username}" with ${coins} coins`, 'ok');
  
  res.json({ ok: true, user: { id: newUser.id, username, role: newUser.role, coins: newUser.coins } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  res.json({ 
    id: user.id, 
    username: user.username, 
    role: user.role, 
    coins: user.coins,
    email: user.email || '',
    twoFactorEnabled: user.twoFactorEnabled || false,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt
  });
});

// Change password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, twoFactorCode } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Invalid current password' });
  }
  
  if (user.twoFactorEnabled && user.twoFactorSecret) {
    if (!twoFactorCode) {
      return res.status(400).json({ error: '2FA code required' });
    }
    const isValid = authenticator.check(twoFactorCode, user.twoFactorSecret);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid 2FA code' });
    }
  }
  
  user.password = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  
  logActivity(user.id, user.username, 'password_changed', { ip: req.ip });
  
  res.json({ ok: true, message: 'Password changed successfully' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coin Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/coins', requireAuth, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  res.json({ coins: user ? user.coins : 0 });
});

app.post('/api/coins/add', requireAdmin, (req, res) => {
  const { userId, username, amount } = req.body || {};
  
  if (isNaN(amount) || Number(amount) === 0) {
    return res.status(400).json({ error: 'Valid amount required' });
  }

  const users = loadUsers();
  const user = userId
    ? users.find(u => u.id === userId)
    : users.find(u => u.username === username);

  if (!user) return res.status(404).json({ error: 'User not found' });

  user.coins = Math.max(0, (user.coins || 0) + Number(amount));
  saveUsers(users);
  
  logActivity(req.user.id, req.user.username, 'coins_added', { 
    targetUser: user.username, 
    amount, 
    newTotal: user.coins 
  });
  
  log(`Admin added ${amount} coins to "${user.username}" (total: ${user.coins})`, 'ok');
  broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
  res.json({ ok: true, coins: user.coins });
});

// Transfer coins between users
app.post('/api/coins/transfer', requireAuth, (req, res) => {
  const { targetUsername, amount } = req.body;
  
  if (!targetUsername || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Valid target username and amount required' });
  }
  
  const users = loadUsers();
  const sender = users.find(u => u.id === req.user.id);
  const recipient = users.find(u => u.username === targetUsername);
  
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
  if (sender.coins < amount) return res.status(400).json({ error: 'Insufficient coins' });
  
  sender.coins -= amount;
  recipient.coins += amount;
  saveUsers(users);
  
  logActivity(sender.id, sender.username, 'coins_transferred', { 
    recipient: targetUsername, 
    amount 
  });
  
  broadcast({ type: 'coins-updated', userId: sender.id, coins: sender.coins });
  broadcast({ type: 'coins-updated', userId: recipient.id, coins: recipient.coins });
  
  res.json({ ok: true, newBalance: sender.coins });
});

// ─────────────────────────────────────────────────────────────────────────────
// User Management Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = loadUsers().map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    coins: u.coins,
    email: u.email || '',
    twoFactorEnabled: u.twoFactorEnabled || false,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
    lockedUntil: u.lockedUntil
  }));
  res.json(users);
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  let users = loadUsers();
  const user = users.find(u => u.id === req.params.id);
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
  
  users = users.filter(u => u.id !== req.params.id);
  saveUsers(users);
  
  logActivity(req.user.id, req.user.username, 'user_deleted', { targetUser: user.username });
  log(`Admin deleted user "${user.username}"`, 'warn');
  
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Activity Log Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/activity-log', requireAdmin, (req, res) => {
  const logs = loadActivityLog();
  const { limit = 100, offset = 0, userId, action } = req.query;
  
  let filtered = logs;
  if (userId) filtered = filtered.filter(l => l.userId === userId);
  if (action) filtered = filtered.filter(l => l.action === action);
  
  res.json({
    total: filtered.length,
    logs: filtered.slice(offset, offset + limit)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Key Management Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/api-keys', requireAuth, (req, res) => {
  const keys = loadApiKeys();
  
  const filtered = req.user.role === 'admin' 
    ? keys 
    : keys.filter(k => k.ownerId === req.user.id);
  
  res.json(filtered.map(k => ({
    id: k.id,
    name: k.name,
    key: k.key.substring(0, 8) + '...',
    active: k.active,
    createdAt: k.createdAt,
    lastUsed: k.lastUsed
  })));
});

app.post('/api/api-keys', requireAuth, (req, res) => {
  const { name } = req.body;
  
  const keys = loadApiKeys();
  const newKey = {
    id: uuidv4(),
    name: name || 'API Key',
    key: 'lbn_' + uuidv4().replace(/-/g, ''),
    ownerId: req.user.id,
    ownerUsername: req.user.username,
    active: true,
    createdAt: new Date().toISOString(),
    lastUsed: null
  };
  
  keys.push(newKey);
  saveApiKeys(keys);
  
  logActivity(req.user.id, req.user.username, 'api_key_created', { keyId: newKey.id });
  
  res.json({ ok: true, key: newKey });
});

app.delete('/api/api-keys/:id', requireAuth, (req, res) => {
  const keys = loadApiKeys();
  const key = keys.find(k => k.id === req.params.id);
  
  if (!key) return res.status(404).json({ error: 'API key not found' });
  if (req.user.role !== 'admin' && key.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  const newKeys = keys.filter(k => k.id !== req.params.id);
  saveApiKeys(newKeys);
  
  logActivity(req.user.id, req.user.username, 'api_key_deleted', { keyId: req.params.id });
  
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/sessions', requireAuth, (req, res) => {
  const sessions = loadSessions();
  if (req.user.role === 'admin') return res.json(sessions);
  res.json(sessions.filter(s => s.ownerId === req.user.id));
});

app.post('/api/sessions', requireAuth, (req, res) => {
  const { ownerName, ownerNumber, sessionIdString, botName, prefix, timezone, botId } = req.body || {};
  
  if (!ownerName || !sessionIdString) {
    return res.status(400).json({ error: 'ownerName and sessionIdString required' });
  }

  const settings = loadSettings();
  const sessions = loadSessions();
  const userSessions = sessions.filter(s => s.ownerId === req.user.id);
  
  if (req.user.role !== 'admin' && userSessions.length >= (settings.maxBotsPerUser || 10)) {
    return res.status(400).json({ error: `Maximum ${settings.maxBotsPerUser} bots per user` });
  }

  const newSess = {
    id: uuidv4(),
    ownerId: req.user.id,
    ownerName,
    ownerNumber: ownerNumber || '',
    sessionIdString,
    botName: botName || 'LadybugBot',
    prefix: prefix || '.',
    timezone: timezone || 'Africa/Harare',
    botId: botId || null,
    status: 'stopped',
    autoRestart: false,
    createdAt: new Date().toISOString()
  };
  
  sessions.push(newSess);
  saveSessions(sessions);
  
  logActivity(req.user.id, req.user.username, 'session_created', { sessionId: newSess.id });
  log(`Session "${newSess.id}" created by "${req.user.username}"`, 'ok');
  broadcast({ type: 'session-created', session: newSess });
  
  res.json({ ok: true, session: newSess });
});

app.put('/api/sessions/:id', requireAuth, (req, res) => {
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === req.params.id);
  
  if (idx === -1) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sessions[idx].ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const allowed = ['ownerName', 'ownerNumber', 'sessionIdString', 'botName', 'prefix', 'timezone', 'botId', 'autoRestart'];
  allowed.forEach(k => { 
    if (req.body[k] !== undefined) sessions[idx][k] = req.body[k]; 
  });
  
  saveSessions(sessions);
  broadcast({ type: 'session-updated', session: sessions[idx] });
  
  res.json({ ok: true, session: sessions[idx] });
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  let sessions = loadSessions();
  const sess = sessions.find(s => s.id === req.params.id);
  
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  stopBotProcess(sess.id);
  sessions = sessions.filter(s => s.id !== req.params.id);
  saveSessions(sessions);
  
  logActivity(req.user.id, req.user.username, 'session_deleted', { sessionId: sess.id });
  log(`Session "${sess.id}" deleted`, 'warn');
  broadcast({ type: 'session-deleted', sessionId: sess.id });
  
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Panel Bot Management Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/panel-bots', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  if (req.user.role === 'admin') return res.json(configs);
  res.json(configs.filter(c => c.ownerId === req.user.id));
});

app.get('/api/panel-bots/:botId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  res.json(config);
});

// Upload ZIP bot
app.post('/api/panel-bots/upload', requireAuth, uploadZip.single('botZip'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const botId = uuidv4();
  const botName = req.body.name || path.parse(req.file.originalname).name;
  const botDescription = req.body.description || '';
  const entryPoint = req.body.entryPoint || 'index.js';
  
  const extractDir = path.join(UPLOADED_BOTS_DIR, botId);
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(req.file.path);

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

    const entryPath = path.join(extractDir, entryPoint);
    if (!fs.existsSync(entryPath)) {
      const files = fs.readdirSync(extractDir);
      const jsFile = files.find(f => f.endsWith('.js'));
      if (jsFile) {
        log(`Entry point "${entryPoint}" not found, using "${jsFile}" instead`, 'warn');
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
      source: 'upload',
      autoRestart: false,
      envVars: {},
      createdAt: new Date().toISOString(),
      path: extractDir
    };

    const configs = loadBotConfigs();
    configs.push(config);
    saveBotConfigs(configs);

    logActivity(req.user.id, req.user.username, 'bot_uploaded', { botId, botName });
    log(`Panel bot "${botName}" uploaded by "${req.user.username}"`, 'ok');
    broadcast({ type: 'panel-bot-created', bot: config });
    
    res.json({ ok: true, bot: config });
  } catch (err) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    log(`Failed to extract bot: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to extract bot: ' + err.message });
  }
});

// GitHub upload
app.post('/api/panel-bots/upload-github', requireAuth, async (req, res) => {
  const { repoUrl, name, description, entryPoint, branch } = req.body || {};
  
  if (!repoUrl) {
    return res.status(400).json({ error: 'GitHub repository URL is required' });
  }

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
    execSync(`git clone --depth 1 --branch ${botBranch} https://github.com/${owner}/${repoName}.git .`, {
      cwd: extractDir,
      stdio: 'pipe',
      timeout: 120000
    });

    const gitDir = path.join(extractDir, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

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

    logActivity(req.user.id, req.user.username, 'bot_uploaded_github', { botId, botName, source: repoUrl });
    log(`Panel bot "${botName}" uploaded from GitHub by "${req.user.username}"`, 'ok');
    broadcast({ type: 'panel-bot-created', bot: config });
    
    res.json({ ok: true, bot: config });
  } catch (err) {
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
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (config.source !== 'github' || !config.sourceUrl) {
    return res.status(400).json({ error: 'This bot was not uploaded from GitHub' });
  }

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  if (!fs.existsSync(botDir)) {
    return res.status(404).json({ error: 'Bot directory not found' });
  }

  const wasRunning = config.status === 'running';
  if (wasRunning) stopPanelBotProcess(config.id);

  log(`Updating bot "${config.name}" from GitHub...`, 'info');

  try {
    const branch = config.branch || 'main';
    const tempDir = path.join(UPLOADED_BOTS_DIR, 'temp-' + config.id);
    
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });

    execSync(`git clone --depth 1 --branch ${branch} ${config.sourceUrl}.git .`, {
      cwd: tempDir,
      stdio: 'pipe',
      timeout: 120000
    });

    const tempGitDir = path.join(tempDir, '.git');
    if (fs.existsSync(tempGitDir)) fs.rmSync(tempGitDir, { recursive: true, force: true });

    const files = fs.readdirSync(botDir);
    for (const file of files) {
      if (file !== '.env') {
        fs.rmSync(path.join(botDir, file), { recursive: true, force: true });
      }
    }

    const tempFiles = fs.readdirSync(tempDir);
    for (const file of tempFiles) {
      fs.renameSync(path.join(tempDir, file), path.join(botDir, file));
    }

    fs.rmSync(tempDir, { recursive: true, force: true });

    const packageJsonPath = path.join(botDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        execSync('npm install --production', { cwd: botDir, stdio: 'pipe', timeout: 180000 });
      } catch (err) {
        log(`Warning: Could not install dependencies: ${err.message}`, 'warn');
      }
    }

    config.updatedAt = new Date().toISOString();
    saveBotConfigs(configs);

    logActivity(req.user.id, req.user.username, 'bot_updated_github', { botId: config.id, botName: config.name });
    log(`Bot "${config.name}" updated successfully from GitHub`, 'ok');
    broadcast({ type: 'panel-bot-updated', bot: config });

    if (wasRunning) setTimeout(() => startPanelBotProcess(config), 1500);

    res.json({ ok: true, bot: config });
  } catch (err) {
    log(`Failed to update bot from GitHub: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to update from GitHub: ' + err.message });
  }
});

// Update panel bot config
app.put('/api/panel-bots/:botId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const idx = configs.findIndex(c => c.id === req.params.botId);
  
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && configs[idx].ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const allowed = ['name', 'description', 'entryPoint'];
  allowed.forEach(k => { 
    if (req.body[k] !== undefined) configs[idx][k] = req.body[k]; 
  });
  
  saveBotConfigs(configs);
  broadcast({ type: 'panel-bot-updated', bot: configs[idx] });
  
  res.json({ ok: true, bot: configs[idx] });
});

// Delete a panel bot
app.delete('/api/panel-bots/:botId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  stopPanelBotProcess(config.id);

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  if (fs.existsSync(botDir)) {
    fs.rmSync(botDir, { recursive: true, force: true });
  }

  const newConfigs = configs.filter(c => c.id !== req.params.botId);
  saveBotConfigs(newConfigs);

  logActivity(req.user.id, req.user.username, 'bot_deleted', { botId: config.id, botName: config.name });
  log(`Panel bot "${config.name}" deleted`, 'warn');
  broadcast({ type: 'panel-bot-deleted', botId: config.id });
  
  res.json({ ok: true });
});

// Start a panel bot
app.post('/api/panel-bots/:botId/start', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.user.role !== 'admin') {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    
    if (!user || user.coins < COIN_COST_START) {
      return res.status(402).json({ error: `Not enough coins. Starting a bot costs ${COIN_COST_START} coins.` });
    }
    
    user.coins -= COIN_COST_START;
    saveUsers(users);
    broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
  }

  startPanelBotProcess(config);
  logActivity(req.user.id, req.user.username, 'bot_started', { botId: config.id, botName: config.name });
  
  res.json({ ok: true });
});

// Stop a panel bot
app.post('/api/panel-bots/:botId/stop', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  stopPanelBotProcess(config.id);
  logActivity(req.user.id, req.user.username, 'bot_stopped', { botId: config.id, botName: config.name });
  
  res.json({ ok: true });
});

// Restart a panel bot
app.post('/api/panel-bots/:botId/restart', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  stopPanelBotProcess(config.id);
  setTimeout(() => startPanelBotProcess(config), 1500);
  logActivity(req.user.id, req.user.username, 'bot_restarted', { botId: config.id, botName: config.name });
  
  res.json({ ok: true });
});

// Get bot logs
app.get('/api/panel-bots/:botId/logs', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const botLogs = logBuffer.filter(l => l.sessionId === req.params.botId);
  res.json({ logs: botLogs });
});

// File browser
app.get('/api/panel-bots/:botId/files', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  const relPath = req.query.path || '';
  const targetDir = path.join(botDir, relPath);

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
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  const relPath = req.query.path || '';
  const filePath = path.join(botDir, relPath);

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

    const ext = path.extname(filePath).toLowerCase();
    const allowedExts = ['.js', '.json', '.md', '.txt', '.env', '.yml', '.yaml', '.ts', '.mjs', '.cjs'];
    
    if (!allowedExts.includes(ext) && !filePath.endsWith('.env')) {
      return res.status(400).json({ error: 'File type not supported for viewing' });
    }

    if (stats.size > 1024 * 1024) {
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
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { path: relPath, content } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'File path required' });

  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  const filePath = path.join(botDir, relPath);

  if (!filePath.startsWith(botDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    fs.writeFileSync(filePath, content, 'utf8');
    log(`File "${relPath}" updated for bot "${config.name}"`, 'ok');
    logActivity(req.user.id, req.user.username, 'file_updated', { botId: config.id, file: relPath });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file: ' + err.message });
  }
});

// Environment variables
app.get('/api/panel-bots/:botId/env', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ envVars: config.envVars || {} });
});

app.put('/api/panel-bots/:botId/env', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const idx = configs.findIndex(c => c.id === req.params.botId);
  
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && configs[idx].ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { envVars } = req.body || {};
  if (typeof envVars !== 'object') {
    return res.status(400).json({ error: 'envVars must be an object' });
  }

  configs[idx].envVars = envVars;
  saveBotConfigs(configs);

  const botDir = path.join(UPLOADED_BOTS_DIR, configs[idx].id);
  const envContent = Object.entries(envVars)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  fs.writeFileSync(path.join(botDir, '.env'), envContent, 'utf8');

  log(`Environment variables updated for bot "${configs[idx].name}"`, 'ok');
  logActivity(req.user.id, req.user.username, 'env_updated', { botId: configs[idx].id });
  
  res.json({ ok: true });
});

// Set auto-restart
app.put('/api/panel-bots/:botId/auto-restart', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const idx = configs.findIndex(c => c.id === req.params.botId);
  
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && configs[idx].ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

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
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

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
    } catch {
      stats.sizeBytes = 0;
      stats.sizeMB = '0';
    }
  }

  if (state.panelBotProcesses[config.id]) {
    stats.uptime = state.panelBotProcesses[config.id].uptime || 0;
  }

  res.json(stats);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bot Control Routes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/bot/start', requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const sessions = loadSessions();
  const sess = sessions.find(s => s.id === sessionId);
  
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.user.role !== 'admin') {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    
    if (!user || user.coins < COIN_COST_START) {
      return res.status(402).json({ error: `Not enough coins. Starting a bot costs ${COIN_COST_START} coins.` });
    }
    
    user.coins -= COIN_COST_START;
    saveUsers(users);
    broadcast({ type: 'coins-updated', userId: user.id, coins: user.coins });
    log(`${COIN_COST_START} coins deducted from "${user.username}" for bot start (remaining: ${user.coins})`, 'warn');
  }

  startBotProcess(sess);
  logActivity(req.user.id, req.user.username, 'session_started', { sessionId });
  
  res.json({ ok: true });
});

app.post('/api/bot/stop', requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const sessions = loadSessions();
  const sess = sessions.find(s => s.id === sessionId);
  
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  stopBotProcess(sessionId);
  logActivity(req.user.id, req.user.username, 'session_stopped', { sessionId });
  
  res.json({ ok: true });
});

app.post('/api/bot/restart', requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const sessions = loadSessions();
  const sess = sessions.find(s => s.id === sessionId);
  
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role !== 'admin' && sess.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  stopBotProcess(sessionId);
  setTimeout(() => startBotProcess(sess), 1500);
  logActivity(req.user.id, req.user.username, 'session_restarted', { sessionId });
  
  res.json({ ok: true });
});

app.post('/api/bot/cleanup', requireAdmin, (req, res) => {
  const result = runCleanup();
  logActivity(req.user.id, req.user.username, 'cleanup_run', result);
  res.json({ ok: true, ...result });
});

// ─────────────────────────────────────────────────────────────────────────────
// Install Bot Route
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/install-bot', requireAdmin, (req, res) => {
  try {
    log('Installing bot from GitHub...', 'info');
    execSync('git clone --depth 1 https://github.com/dev-modder/Ladybug-Mini.git bot-src 2>&1 || (cd bot-src && git pull)', {
      cwd: __dirname, stdio: 'pipe'
    });
    execSync('npm install', { cwd: path.join(__dirname, 'bot-src'), stdio: 'pipe' });
    log('Bot installed successfully!', 'ok');
    logActivity(req.user.id, req.user.username, 'bot_installed', {});
    res.json({ ok: true });
  } catch (err) {
    log(`Bot install failed: ${err.message}`, 'error');
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Backup/Restore Routes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/backup', requireAdmin, (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `backup-${timestamp}.json`);
    
    const backup = {
      timestamp: new Date().toISOString(),
      version: '5.0.0',
      sessions: loadSessions(),
      users: loadUsers().map(u => ({ ...u, password: undefined })),
      botConfigs: loadBotConfigs(),
      settings: loadSettings(),
      templates: loadTemplates()
    };
    
    saveJSON(backupFile, backup);
    logActivity(req.user.id, req.user.username, 'backup_created', { file: backupFile });
    log(`Backup created: ${backupFile}`, 'ok');
    
    res.json({ ok: true, file: backupFile, size: fs.statSync(backupFile).size });
  } catch (err) {
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

app.get('/api/backups', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          filename: f,
          size: stat.size,
          created: stat.mtime
        };
      })
      .sort((a, b) => b.created - a.created);
    
    res.json({ backups: files });
  } catch {
    res.json({ backups: [] });
  }
});

app.post('/api/restore/:filename', requireAdmin, (req, res) => {
  try {
    const backupFile = path.join(BACKUP_DIR, req.params.filename);
    
    if (!fs.existsSync(backupFile)) {
      return res.status(404).json({ error: 'Backup file not found' });
    }
    
    const backup = loadJSON(backupFile, {});
    
    if (backup.sessions) saveSessions(backup.sessions);
    if (backup.botConfigs) saveBotConfigs(backup.botConfigs);
    if (backup.settings) saveSettings(backup.settings);
    if (backup.templates) saveTemplates(backup.templates);
    
    logActivity(req.user.id, req.user.username, 'backup_restored', { file: req.params.filename });
    log(`Backup restored: ${req.params.filename}`, 'ok');
    
    res.json({ ok: true, message: 'Backup restored successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAdmin, (req, res) => {
  res.json(loadSettings());
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const settings = loadSettings();
  const allowed = ['siteName', 'coinCostStart', 'maxBotsPerUser', 'maxUsersPerAdmin', 'enable2FA', 'enableEmailNotifications', 'sessionTimeout', 'maintenanceMode'];
  
  allowed.forEach(k => {
    if (req.body[k] !== undefined) settings[k] = req.body[k];
  });
  
  saveSettings(settings);
  logActivity(req.user.id, req.user.username, 'settings_updated', { changes: req.body });
  
  res.json({ ok: true, settings });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/templates', requireAuth, (req, res) => {
  res.json(loadTemplates());
});

app.post('/api/templates', requireAdmin, (req, res) => {
  const { name, description, config } = req.body;
  
  const templates = loadTemplates();
  const newTemplate = {
    id: uuidv4(),
    name,
    description,
    config,
    createdAt: new Date().toISOString()
  };
  
  templates.push(newTemplate);
  saveTemplates(templates);
  
  res.json({ ok: true, template: newTemplate });
});

app.delete('/api/templates/:id', requireAdmin, (req, res) => {
  let templates = loadTemplates();
  templates = templates.filter(t => t.id !== req.params.id);
  saveTemplates(templates);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Status & Health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const mem = process.memoryUsage();
  let cpuInfo = {};
  
  try {
    cpuInfo = await si.cpuCurrentSpeed();
  } catch {}
  
  res.json({
    version: '5.0.0',
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    pingCount: state.pingCount,
    cleanCount: state.cleanCount,
    mem,
    cpu: cpuInfo.avg || 0,
    activeConnections: clients.size
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '5.0.0', ts: Date.now() }));

// ─────────────────────────────────────────────────────────────────────────────
// Serve HTML pages
// ─────────────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/panel-bots.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel-bots.html')));
app.get('/settings.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/activity-logs.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'activity-logs.html')));

// ─────────────────────────────────────────────────────────────────────────────
// Bot Process Manager
// ─────────────────────────────────────────────────────────────────────────────
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

  if (sess.botId) {
    const configs = loadBotConfigs();
    const botConfig = configs.find(c => c.id === sess.botId);
    if (botConfig) {
      startPanelBotForSession(sess, botConfig);
      return;
    }
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
    BOT_NAME: sess.botName || 'LadybugBot',
    PREFIX: sess.prefix || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ: sess.timezone || 'Africa/Harare'
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

    if (sess.autoRestart && status === 'crashed') {
      log(`Auto-restarting session "${sess.id}" in 5 seconds...`, 'warn', sess.id);
      setTimeout(() => {
        const sessions = loadSessions();
        const updatedSess = sessions.find(s => s.id === sess.id);
        if (updatedSess && updatedSess.autoRestart) {
          startBotProcess(updatedSess);
        }
      }, 5000);
    }
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
    BOT_NAME: sess.botName || botConfig.name,
    PREFIX: sess.prefix || '.',
    OWNER_NUMBER: sess.ownerNumber || '',
    TZ: sess.timezone || 'Africa/Harare'
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

// ─────────────────────────────────────────────────────────────────────────────
// Panel Bot Process Manager
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────
function runCleanup() {
  const tmpDir = '/tmp';
  let removed = 0, freedBytes = 0;
  
  try {
    const files = fs.readdirSync(tmpDir);
    const cutoff = Date.now() - 60 * 60 * 1000;
    
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

wss.on('connection', (ws) => {
  clients.add(ws);

  const sessions = loadSessions();
  const botConfigs = loadBotConfigs();
  
  ws.send(JSON.stringify({
    type: 'init',
    logs: logBuffer.slice(-150),
    sessions,
    panelBots: botConfigs,
    serverStatus: {
      version: '5.0.0',
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      pingCount: state.pingCount,
      cleanCount: state.cleanCount,
      mem: process.memoryUsage()
    }
  }));

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron Jobs
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 */6 * * *', runCleanup);

// Auto-backup daily
cron.schedule('0 3 * * *', () => {
  const users = loadUsers();
  const admin = users.find(u => u.role === 'admin');
  if (admin) {
    const timestamp = new Date().toISOString().split('T')[0];
    const backupFile = path.join(BACKUP_DIR, `auto-backup-${timestamp}.json`);
    
    const backup = {
      timestamp: new Date().toISOString(),
      version: '5.0.0',
      sessions: loadSessions(),
      users: users.map(u => ({ ...u, password: undefined })),
      botConfigs: loadBotConfigs(),
      settings: loadSettings()
    };
    
    saveJSON(backupFile, backup);
    log(`Auto-backup created: ${backupFile}`, 'ok');
    
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('auto-backup-'))
      .sort()
      .slice(0, -7);
    
    files.forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`LADYBUGNODES V5 running on port ${PORT}`, 'ok');
  if (RENDER_URL) log(`Keep-alive targeting: ${RENDER_URL}`, 'info');
  else log(`Set RENDER_URL env var to enable keep-alive pings`, 'warn');
});

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down bots...', 'warn');
  Object.keys(state.botProcesses).forEach(stopBotProcess);
  Object.keys(state.panelBotProcesses).forEach(stopPanelBotProcess);
  process.exit(0);
});