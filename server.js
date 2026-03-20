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
  res.json({ 
    id: user.id, 
    username: user.username, 
    role: user.role, 
    coins: user.coins,
    email: user.email || '',
    phone: user.phone || '',
    timezone: user.timezone || 'Africa/Harare',
    settings: user.settings || {},
    createdAt: user.createdAt
  });
});

// WhatsApp OTP Verification Service
const { 
  sendVerificationOTP, 
  sendPasswordResetOTP, 
  send2FAOTP, 
  sendBotNotification,
  verifyOTP 
} = require('./utils/whatsapp');

// Send OTP for verification/signup
app.post('/api/auth/send-otp', async (req, res) => {
  const { phone, type } = req.body || {};
  
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  
  try {
    let result;
    
    switch (type) {
      case 'verification':
        result = await sendVerificationOTP(phone);
        break;
      case 'password-reset':
        result = await sendPasswordResetOTP(phone);
        break;
      case '2fa':
      case '2fa-enable':
        result = await send2FAOTP(phone);
        break;
      default:
        result = await sendVerificationOTP(phone);
    }
    
    if (result.sent) {
      log(`OTP sent to ${phone} via WhatsApp (${type || 'verification'})`, 'ok');
      res.json({ 
        ok: true, 
        otp: process.env.NODE_ENV === 'development' ? result.otp : undefined 
      });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send OTP' });
    }
  } catch (err) {
    log(`OTP send error: ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Signup with WhatsApp verification
app.post('/api/auth/signup', async (req, res) => {
  const { username, email, phone, password, otp } = req.body || {};
  
  if (!username || !phone || !password || !otp) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  // Verify OTP
  const otpResult = verifyOTP(phone, otp, 'verification');
  if (!otpResult.valid) {
    return res.status(400).json({ error: otpResult.error });
  }
  
  const users = loadUsers();
  
  // Check if username exists
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  
  // Check if phone exists
  if (users.find(u => u.phone === phone)) {
    return res.status(409).json({ error: 'Phone number already registered' });
  }
  
  // Create user
  const hash = bcrypt.hashSync(password, 10);
  const newUser = {
    id: uuidv4(),
    username,
    email: email || '',
    phone,
    password: hash,
    role: 'user',
    coins: 50, // Starting coins
    timezone: 'Africa/Harare',
    settings: {
      twoFactor: false,
      loginNotify: true,
      botStart: true,
      botStop: true,
      botCrash: true,
      lowBalance: true
    },
    apiKeys: [],
    createdAt: new Date().toISOString()
  };
  
  users.push(newUser);
  saveUsers(users);
  
  // Generate token
  const token = jwt.sign(
    { id: newUser.id, username: newUser.username, role: newUser.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  log(`New user "${username}" registered via WhatsApp`, 'ok');
  
  // Send welcome notification
  sendBotNotification(phone, 'session_created', { 
    botName: 'Welcome!', 
    ownerName: username 
  }).catch(() => {});
  
  res.json({ 
    ok: true, 
    token,
    user: { 
      id: newUser.id, 
      username: newUser.username, 
      role: newUser.role, 
      coins: newUser.coins,
      phone: newUser.phone
    } 
  });
});

// Password reset request
app.post('/api/auth/forgot-password', async (req, res) => {
  const { phone } = req.body || {};
  
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  
  const users = loadUsers();
  const user = users.find(u => u.phone === phone);
  
  if (!user) {
    // Don't reveal if user exists
    return res.json({ ok: true, message: 'If the number exists, an OTP will be sent' });
  }
  
  try {
    const result = await sendPasswordResetOTP(phone);
    
    if (result.sent) {
      log(`Password reset OTP sent to ${phone}`, 'ok');
      res.json({ 
        ok: true, 
        otp: process.env.NODE_ENV === 'development' ? result.otp : undefined 
      });
    } else {
      res.json({ ok: true }); // Don't reveal errors
    }
  } catch (err) {
    res.json({ ok: true });
  }
});

// Reset password with OTP
app.post('/api/auth/reset-password', async (req, res) => {
  const { phone, otp, newPassword } = req.body || {};
  
  if (!phone || !otp || !newPassword) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  // Verify OTP
  const otpResult = verifyOTP(phone, otp, 'password-reset');
  if (!otpResult.valid) {
    return res.status(400).json({ error: otpResult.error });
  }
  
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.phone === phone);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Update password
  users[userIndex].password = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  
  log(`Password reset for user "${users[userIndex].username}"`, 'ok');
  
  res.json({ ok: true, message: 'Password reset successfully' });
});

// Verify 2FA
app.post('/api/auth/verify-2fa', requireAuth, async (req, res) => {
  const { otp } = req.body || {};
  
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user || !user.phone) {
    return res.status(400).json({ error: 'User not found or no phone number' });
  }
  
  const otpResult = verifyOTP(user.phone, otp, '2fa');
  if (!otpResult.valid) {
    return res.status(400).json({ error: otpResult.error });
  }
  
  res.json({ ok: true });
});

// Verify OTP (for password reset flow - no auth required)
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp, type } = req.body || {};
  
  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required' });
  }
  
  const otpResult = verifyOTP(phone, otp, type || 'password-reset');
  if (!otpResult.valid) {
    return res.status(400).json({ error: otpResult.error });
  }
  
  res.json({ ok: true, verified: true });
});

// Dashboard Statistics
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Load sessions
  const sessions = loadSessions();
  const userSessions = sessions.filter(s => s.ownerId === user.id || (user.role === 'admin' && s.ownerId === user.id));
  
  // Load bot configs
  const botConfigs = loadBotConfigs();
  const userBots = botConfigs.filter(b => b.ownerId === user.id || user.role === 'admin');
  
  // Calculate statistics
  const runningBots = userBots.filter(b => state.panelBotProcesses[b.id]);
  const runningSessions = userSessions.filter(s => state.botProcesses[s.id]);
  
  // Calculate total uptime
  let totalUptime = 0;
  const now = Date.now();
  
  runningSessions.forEach(s => {
    if (state.botProcesses[s.id] && state.botProcesses[s.id].startTime) {
      totalUptime += now - state.botProcesses[s.id].startTime;
    }
  });
  
  runningBots.forEach(b => {
    if (state.panelBotProcesses[b.id] && state.panelBotProcesses[b.id].startTime) {
      totalUptime += now - state.panelBotProcesses[b.id].startTime;
    }
  });
  
  // Days since account created
  const accountAge = user.createdAt ? Math.floor((now - new Date(user.createdAt)) / (1000 * 60 * 60 * 24)) : 0;
  
  res.json({
    coins: user.coins || 0,
    totalBots: userBots.length,
    runningBots: runningBots.length,
    totalSessions: userSessions.length,
    runningSessions: runningSessions.length,
    totalUptime: Math.floor(totalUptime / 1000), // in seconds
    accountAge,
    role: user.role,
    username: user.username
  });
});

// Get recent activity for dashboard
app.get('/api/dashboard/activity', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  
  const userActivities = activityLog
    .filter(a => a.userId === req.user.id || req.user.role === 'admin')
    .slice(0, limit);
  
  res.json({ activities: userActivities });
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

// User Profile Routes
app.get('/api/user/profile', requireAuth, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    id: user.id,
    username: user.username,
    email: user.email || '',
    phone: user.phone || '',
    role: user.role,
    coins: user.coins,
    timezone: user.timezone || 'Africa/Harare',
    settings: user.settings || {},
    createdAt: user.createdAt
  });
});

app.put('/api/user/profile', requireAuth, (req, res) => {
  const { username, email, timezone } = req.body || {};
  
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Check if username is taken by another user
  if (username && username !== users[userIndex].username) {
    if (users.find(u => u.id !== req.user.id && u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    users[userIndex].username = username;
  }
  
  if (email !== undefined) users[userIndex].email = email;
  if (timezone !== undefined) users[userIndex].timezone = timezone;
  
  saveUsers(users);
  
  log(`User "${users[userIndex].username}" updated profile`, 'ok');
  
  res.json({ 
    ok: true, 
    user: {
      id: users[userIndex].id,
      username: users[userIndex].username,
      email: users[userIndex].email,
      timezone: users[userIndex].timezone
    }
  });
});

app.put('/api/user/settings', requireAuth, (req, res) => {
  const { settings } = req.body || {};
  
  if (typeof settings !== 'object') {
    return res.status(400).json({ error: 'Settings must be an object' });
  }
  
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  users[userIndex].settings = { ...users[userIndex].settings, ...settings };
  saveUsers(users);
  
  res.json({ ok: true, settings: users[userIndex].settings });
});

app.put('/api/user/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  
  user.password = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  
  log(`User "${user.username}" changed password`, 'ok');
  
  // Send notification
  if (user.phone && user.settings?.loginNotify) {
    sendBotNotification(user.phone, 'custom', { 
      message: 'Your password was changed. If this wasn\'t you, secure your account immediately.' 
    }).catch(() => {});
  }
  
  res.json({ ok: true });
});

// API Key Management
app.get('/api/user/api-keys', requireAuth, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const apiKeys = (user.apiKeys || []).map(k => ({
    id: k.id,
    name: k.name,
    prefix: k.key.substring(0, 12) + '...',
    createdAt: k.createdAt,
    lastUsed: k.lastUsed
  }));
  
  res.json({ apiKeys });
});

app.post('/api/user/api-keys', requireAuth, (req, res) => {
  const { name } = req.body || {};
  
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!users[userIndex].apiKeys) {
    users[userIndex].apiKeys = [];
  }
  
  // Generate API key
  const crypto = require('crypto');
  const apiKey = 'lbn_' + crypto.randomBytes(32).toString('hex');
  
  const newKey = {
    id: uuidv4(),
    name,
    key: apiKey,
    createdAt: new Date().toISOString(),
    lastUsed: null
  };
  
  users[userIndex].apiKeys.push(newKey);
  saveUsers(users);
  
  log(`API key "${name}" created for user "${users[userIndex].username}"`, 'ok');
  
  res.json({ 
    ok: true, 
    apiKey: {
      id: newKey.id,
      name: newKey.name,
      key: apiKey, // Only shown once!
      createdAt: newKey.createdAt
    }
  });
});

app.delete('/api/user/api-keys/:id', requireAuth, (req, res) => {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const keyIndex = (users[userIndex].apiKeys || []).findIndex(k => k.id === req.params.id);
  
  if (keyIndex === -1) {
    return res.status(404).json({ error: 'API key not found' });
  }
  
  users[userIndex].apiKeys.splice(keyIndex, 1);
  saveUsers(users);
  
  res.json({ ok: true });
});

// Activity Log
const activityLog = [];

function logActivity(userId, action, details = {}) {
  activityLog.push({
    id: uuidv4(),
    userId,
    action,
    details,
    ip: details.ip || 'unknown',
    userAgent: details.userAgent || 'unknown',
    timestamp: new Date().toISOString()
  });
  
  // Keep only last 1000 entries
  if (activityLog.length > 1000) {
    activityLog.shift();
  }
}

app.get('/api/user/activity', requireAuth, (req, res) => {
  const userActivities = activityLog
    .filter(a => a.userId === req.user.id)
    .slice(-50)
    .reverse();
  
  res.json({ activities: userActivities });
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
// Scheduled Bot Management
const scheduledTasks = new Map();

// Schedule bot start/stop
app.post('/api/schedule', requireAuth, (req, res) => {
  const { sessionId, action, cronExpression, enabled } = req.body || {};
  
  if (!sessionId || !action || !cronExpression) {
    return res.status(400).json({ error: 'sessionId, action, and cronExpression are required' });
  }
  
  if (!['start', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'Action must be "start" or "stop"' });
  }
  
  // Validate cron expression
  if (!cron.validate(cronExpression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }
  
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  if (req.user.role !== 'admin' && session.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  // Create scheduled task
  const taskId = uuidv4();
  const task = {
    id: taskId,
    sessionId,
    sessionName: session.botName || session.ownerName,
    action,
    cronExpression,
    enabled: enabled !== false,
    ownerId: req.user.id,
    createdAt: new Date().toISOString()
  };
  
  // Schedule the task
  const job = cron.schedule(cronExpression, () => {
    log(`Scheduled ${action} for session "${session.botName}"`, 'info');
    
    if (action === 'start') {
      startBotProcess(session);
    } else {
      stopBotProcess(sessionId);
    }
    
    // Notify user
    const users = loadUsers();
    const user = users.find(u => u.id === session.ownerId);
    if (user?.phone && user.settings?.botStart) {
      sendBotNotification(user.phone, action === 'start' ? 'bot_started' : 'bot_stopped', {
        botName: session.botName,
        ownerName: session.ownerName
      }).catch(() => {});
    }
  }, { scheduled: enabled !== false });
  
  scheduledTasks.set(taskId, { ...task, job });
  
  log(`Scheduled ${action} for session "${session.botName}" (${cronExpression})`, 'ok');
  
  res.json({ ok: true, task });
});

// List scheduled tasks
app.get('/api/schedule', requireAuth, (req, res) => {
  const tasks = Array.from(scheduledTasks.values())
    .filter(t => req.user.role === 'admin' || t.ownerId === req.user.id)
    .map(t => ({
      id: t.id,
      sessionId: t.sessionId,
      sessionName: t.sessionName,
      action: t.action,
      cronExpression: t.cronExpression,
      enabled: t.enabled,
      createdAt: t.createdAt
    }));
  
  res.json({ tasks });
});

// Delete scheduled task
app.delete('/api/schedule/:id', requireAuth, (req, res) => {
  const task = scheduledTasks.get(req.params.id);
  
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  if (req.user.role !== 'admin' && task.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  task.job.stop();
  scheduledTasks.delete(req.params.id);
  
  res.json({ ok: true });
});

// Webhook Management
app.get('/api/webhooks', requireAuth, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  res.json({ webhooks: user?.webhooks || [] });
});

app.post('/api/webhooks', requireAuth, async (req, res) => {
  const { url, events, secret } = req.body || {};
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  // Validate URL
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!users[userIndex].webhooks) {
    users[userIndex].webhooks = [];
  }
  
  const webhook = {
    id: uuidv4(),
    url,
    events: events || ['bot_start', 'bot_stop', 'bot_crash'],
    secret: secret || '',
    createdAt: new Date().toISOString()
  };
  
  users[userIndex].webhooks.push(webhook);
  saveUsers(users);
  
  res.json({ ok: true, webhook });
});

app.delete('/api/webhooks/:id', requireAuth, (req, res) => {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const webhookIndex = (users[userIndex].webhooks || []).findIndex(w => w.id === req.params.id);
  
  if (webhookIndex === -1) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  
  users[userIndex].webhooks.splice(webhookIndex, 1);
  saveUsers(users);
  
  res.json({ ok: true });
});

// Trigger webhooks
async function triggerWebhooks(userId, event, data) {
  const users = loadUsers();
  const user = users.find(u => u.id === userId);
  
  if (!user?.webhooks?.length) return;
  
  const relevantWebhooks = user.webhooks.filter(w => w.events.includes(event));
  
  for (const webhook of relevantWebhooks) {
    try {
      await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ladybug-Signature': webhook.secret ? 
            require('crypto').createHmac('sha256', webhook.secret).update(JSON.stringify(data)).digest('hex') : ''
        },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          data
        })
      });
    } catch (err) {
      log(`Webhook failed: ${err.message}`, 'warn');
    }
  }
}

// Session Templates
app.get('/api/templates', requireAuth, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  
  res.json({ templates: user?.templates || [] });
});

app.post('/api/templates', requireAuth, (req, res) => {
  const { name, config } = req.body || {};
  
  if (!name || !config) {
    return res.status(400).json({ error: 'Name and config are required' });
  }
  
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!users[userIndex].templates) {
    users[userIndex].templates = [];
  }
  
  const template = {
    id: uuidv4(),
    name,
    config,
    createdAt: new Date().toISOString()
  };
  
  users[userIndex].templates.push(template);
  saveUsers(users);
  
  res.json({ ok: true, template });
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === req.user.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const templateIndex = (users[userIndex].templates || []).findIndex(t => t.id === req.params.id);
  
  if (templateIndex === -1) {
    return res.status(404).json({ error: 'Template not found' });
  }
  
  users[userIndex].templates.splice(templateIndex, 1);
  saveUsers(users);
  
  res.json({ ok: true });
});

// Backup & Restore Sessions
app.get('/api/backup', requireAuth, (req, res) => {
  const sessions = loadSessions();
  const userSessions = req.user.role === 'admin' 
    ? sessions 
    : sessions.filter(s => s.ownerId === req.user.id);
  
  const backup = {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.username,
    sessions: userSessions.map(s => ({
      ownerName: s.ownerName,
      ownerNumber: s.ownerNumber,
      sessionIdString: s.sessionIdString,
      botName: s.botName,
      prefix: s.prefix,
      timezone: s.timezone,
      botId: s.botId
    }))
  };
  
  res.json(backup);
});

app.post('/api/restore', requireAuth, (req, res) => {
  const { sessions: sessionsToRestore } = req.body || {};
  
  if (!Array.isArray(sessionsToRestore)) {
    return res.status(400).json({ error: 'Sessions array is required' });
  }
  
  const sessions = loadSessions();
  let imported = 0;
  
  for (const sess of sessionsToRestore) {
    if (!sess.ownerName || !sess.sessionIdString) continue;
    
    const newSession = {
      id: uuidv4(),
      ownerId: req.user.id,
      ownerName: sess.ownerName,
      ownerNumber: sess.ownerNumber || '',
      sessionIdString: sess.sessionIdString,
      botName: sess.botName || 'LadybugBot',
      prefix: sess.prefix || '.',
      timezone: sess.timezone || 'Africa/Harare',
      botId: sess.botId || null,
      status: 'stopped',
      createdAt: new Date().toISOString()
    };
    
    sessions.push(newSession);
    imported++;
  }
  
  saveSessions(sessions);
  
  log(`Restored ${imported} sessions for user "${req.user.username}"`, 'ok');
  
  res.json({ ok: true, imported });
});

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

// Backup bot configuration and files
app.get('/api/panel-bots/:botId/backup', requireAuth, async (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  
  const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
  
  if (!fs.existsSync(botDir)) {
    return res.status(404).json({ error: 'Bot directory not found' });
  }
  
  try {
    const backupId = uuidv4();
    const backupDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    
    const backupPath = path.join(backupDir, `${config.id}-${backupId}.zip`);
    
    // Create zip archive
    const zip = new AdmZip();
    zip.addLocalFolder(botDir);
    
    // Add config metadata
    const metadata = {
      ...config,
      backupId,
      backedUpAt: new Date().toISOString(),
      backedUpBy: req.user.username
    };
    zip.addFile('ladybug-backup.json', Buffer.from(JSON.stringify(metadata, null, 2)));
    
    zip.writeZip(backupPath);
    
    log(`Backup created for bot "${config.name}" by ${req.user.username}`, 'ok');
    
    res.json({
      ok: true,
      backupId,
      downloadUrl: `/api/panel-bots/${config.id}/backup/${backupId}`
    });
  } catch (err) {
    log(`Backup failed for bot "${config.name}": ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to create backup: ' + err.message });
  }
});

// Download backup file
app.get('/api/panel-bots/:botId/backup/:backupId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  
  const backupPath = path.join(DATA_DIR, 'backups', `${req.params.botId}-${req.params.backupId}.zip`);
  
  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  
  res.download(backupPath, `${config.name}-backup-${req.params.backupId}.zip`);
});

// List backups for a bot
app.get('/api/panel-bots/:botId/backups', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  
  const backupDir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(backupDir)) {
    return res.json({ backups: [] });
  }
  
  const backups = fs.readdirSync(backupDir)
    .filter(f => f.startsWith(req.params.botId))
    .map(f => {
      const stats = fs.statSync(path.join(backupDir, f));
      const backupId = f.replace(`${req.params.botId}-`, '').replace('.zip', '');
      return {
        backupId,
        filename: f,
        size: stats.size,
        createdAt: stats.birthtime
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  res.json({ backups });
});

// Restore bot from backup
app.post('/api/panel-bots/:botId/restore/:backupId', requireAuth, async (req, res) => {
  const configs = loadBotConfigs();
  const configIdx = configs.findIndex(c => c.id === req.params.botId);
  
  if (configIdx === -1) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && configs[configIdx].ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  
  const config = configs[configIdx];
  const backupPath = path.join(DATA_DIR, 'backups', `${req.params.botId}-${req.params.backupId}.zip`);
  
  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  
  // Stop bot if running
  if (state.panelBotProcesses[config.id]) {
    stopPanelBotProcess(config.id);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  try {
    const botDir = path.join(UPLOADED_BOTS_DIR, config.id);
    
    // Clear existing files (keep .env)
    const envPath = path.join(botDir, '.env');
    let envContent = null;
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    // Remove all files
    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }
    fs.mkdirSync(botDir, { recursive: true });
    
    // Extract backup
    const zip = new AdmZip(backupPath);
    zip.extractAllTo(botDir, true);
    
    // Restore .env if it was preserved
    if (envContent) {
      fs.writeFileSync(envPath, envContent, 'utf8');
    }
    
    // Remove metadata file from extraction
    const metadataPath = path.join(botDir, 'ladybug-backup.json');
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }
    
    log(`Bot "${config.name}" restored from backup by ${req.user.username}`, 'ok');
    
    res.json({ ok: true, message: 'Bot restored successfully' });
  } catch (err) {
    log(`Restore failed for bot "${config.name}": ${err.message}`, 'error');
    res.status(500).json({ error: 'Failed to restore backup: ' + err.message });
  }
});

// Delete backup
app.delete('/api/panel-bots/:botId/backup/:backupId', requireAuth, (req, res) => {
  const configs = loadBotConfigs();
  const config = configs.find(c => c.id === req.params.botId);
  
  if (!config) return res.status(404).json({ error: 'Bot not found' });
  if (req.user.role !== 'admin' && config.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  
  const backupPath = path.join(DATA_DIR, 'backups', `${req.params.botId}-${req.params.backupId}.zip`);
  
  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  
  fs.unlinkSync(backupPath);
  log(`Backup deleted for bot "${config.name}" by ${req.user.username}`, 'ok');
  
  res.json({ ok: true });
});

// Session Templates
app.get('/api/session-templates', requireAuth, (req, res) => {
  const templates = [
    {
      id: 'basic-whatsapp',
      name: 'Basic WhatsApp Bot',
      description: 'A simple WhatsApp bot with basic commands',
      entryPoint: 'index.js'
    },
    {
      id: 'multi-device',
      name: 'Multi-Device WhatsApp',
      description: 'WhatsApp bot with multi-device support',
      entryPoint: 'index.js'
    },
    {
      id: 'group-manager',
      name: 'Group Manager Bot',
      description: 'WhatsApp bot for group management',
      entryPoint: 'index.js'
    }
  ];
  
  res.json({ templates });
});

// Create bot from template
app.post('/api/panel-bots/from-template', requireAuth, async (req, res) => {
  const { templateId, name, description } = req.body || {};
  
  if (!templateId || !name) {
    return res.status(400).json({ error: 'Template ID and name are required' });
  }
  
  const templateCode = {
    'basic-whatsapp': `// LADYBUGNODES V(5) - Basic WhatsApp Bot
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('whiskey-connect-baileys');
const pino = require('pino');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }) });
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });
  
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message) {
      const from = msg.key.remoteJid;
      const text = msg.message.conversation || '';
      if (text === '!ping') await sock.sendMessage(from, { text: 'Pong!' });
    }
  });
}
startBot();`,
    'multi-device': `// LADYBUGNODES V(5) - Multi-Device Bot
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('whiskey-connect-baileys');
const pino = require('pino');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }), version });
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
  });
  
  sock.ev.on('creds.update', saveCreds);
}
startBot();`,
    'group-manager': `// LADYBUGNODES V(5) - Group Manager Bot
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('whiskey-connect-baileys');
const pino = require('pino');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }) });
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
  });
  
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.key.fromMe && msg.message && msg.key.remoteJid.endsWith('@g.us')) {
      const from = msg.key.remoteJid;
      const text = msg.message.conversation || '';
      if (text === '!tagall') {
        const metadata = await sock.groupMetadata(from);
        await sock.sendMessage(from, { text: 'Tagging all!', mentions: metadata.participants.map(p => p.id) });
      }
    }
  });
}
startBot();`
  };
  
  const code = templateCode[templateId];
  if (!code) return res.status(404).json({ error: 'Template not found' });
  
  const botId = uuidv4();
  const botDir = path.join(UPLOADED_BOTS_DIR, botId);
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(path.join(botDir, 'auth'), { recursive: true });
  
  fs.writeFileSync(path.join(botDir, 'index.js'), code, 'utf8');
  fs.writeFileSync(path.join(botDir, 'package.json'), JSON.stringify({
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: '1.0.0',
    main: 'index.js',
    scripts: { start: 'node index.js' },
    dependencies: { 'whiskey-connect-baileys': 'latest', 'pino': '^8.0.0' }
  }, null, 2), 'utf8');
  
  try {
    execSync('npm install', { cwd: botDir, stdio: 'pipe', timeout: 180000 });
  } catch (e) {}
  
  const configs = loadBotConfigs();
  const newConfig = {
    id: botId, name, description: description || '', entryPoint: 'index.js',
    ownerId: req.user.id, source: 'template', templateId,
    createdAt: new Date().toISOString(), status: 'stopped', autoRestart: false, envVars: {}
  };
  configs.push(newConfig);
  saveBotConfigs(configs);
  
  log(`Bot "${name}" created from template by ${req.user.username}`, 'ok');
  res.json({ ok: true, bot: newConfig });
});

// ────────────────────────────────────────────────────────────── Start ──────────────────────────────────────────────────────────────
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