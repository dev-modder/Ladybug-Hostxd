/**
 * LADYBUGNODES v3.0 — server.js
 * Multi-Host WhatsApp Bot Dashboard
 * Features:
 *  - MongoDB persistence (sessions survive restarts)
 *  - User roles: admin | developer | user
 *  - GitHub URL bot script loading for developers
 *  - express-session backed by MongoDB
 *  - JWT authentication
 *  - WebSocket live log streaming
 *  - Render.com ready
 */

'use strict';
require('dotenv').config();

const express       = require('express');
const http          = require('http');
const WebSocket     = require('ws');
const bcrypt        = require('bcryptjs');
const jwt           = require('jsonwebtoken');
const session       = require('express-session');
const MongoStore    = require('connect-mongo');
const mongoose      = require('mongoose');
const { v4: uuid }  = require('uuid');
const path          = require('path');
const fs            = require('fs');
const { execFile, spawn } = require('child_process');
const cron          = require('node-cron');
const si            = require('systeminformation');
const fetch         = require('node-fetch');
const multer        = require('multer');
const AdmZip        = require('adm-zip');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const JWT_SECRET   = process.env.JWT_SECRET   || 'ladybugnodes_jwt_secret_change_me';
const SESSION_SEC  = process.env.SESSION_SECRET|| 'ladybugnodes_session_secret_change_me';
const MONGO_URI    = process.env.MONGODB_URI  || 'mongodb+srv://ntandomods:vHdmLZJTw5lHXmXz@modsxxx.n82ej6m.mongodb.net/?appName=Modsxxx';
const ADMIN_USER   = process.env.ADMIN_USERNAME|| 'devntando';
const ADMIN_PASS   = process.env.ADMIN_PASSWORD|| 'ntando';

// Directories
const PUBLIC_DIR   = path.join(__dirname, 'public');
const BOTS_DIR     = path.join(__dirname, 'panel-bots');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
[PUBLIC_DIR, BOTS_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Mongoose Schemas ─────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:   { type: String, required: true, unique: true },
  password:   { type: String, required: true },
  role:       { type: String, enum: ['admin','developer','user'], default: 'user' },
  coins:      { type: Number, default: 100 },
  createdAt:  { type: Date, default: Date.now },
  createdBy:  { type: String, default: 'system' },
  active:     { type: Boolean, default: true },
  githubUrl:  { type: String, default: '' },   // developer's main GitHub repo
  apiKey:     { type: String, default: '' },   // developer API key
});

const sessionSchema = new mongoose.Schema({
  id:          { type: String, required: true, unique: true },
  owner:       { type: String, required: true },   // username
  ownerName:   { type: String, required: true },
  botName:     { type: String, default: 'MyBot' },
  ownerNumber: { type: String, default: '' },
  prefix:      { type: String, default: '.' },
  timezone:    { type: String, default: 'UTC' },
  status:      { type: String, default: 'stopped' },
  panelBotId:  { type: String, default: null },    // which panel bot script to use
  createdAt:   { type: Date, default: Date.now },
  lastStart:   { type: Date, default: null },
  lastStop:    { type: Date, default: null },
  pid:         { type: Number, default: null },
});

const panelBotSchema = new mongoose.Schema({
  id:          { type: String, required: true, unique: true },
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  author:      { type: String, default: '' },         // developer username
  githubUrl:   { type: String, default: '' },         // GitHub raw URL of the script
  scriptPath:  { type: String, default: '' },         // local path after download
  version:     { type: String, default: '1.0.0' },
  status:      { type: String, default: 'idle' },
  type:        { type: String, enum: ['zip','github','local'], default: 'local' },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

const logSchema = new mongoose.Schema({
  sessionId: String,
  message:   String,
  level:     { type: String, default: 'info' },
  ts:        { type: Date, default: Date.now },
});

const User      = mongoose.model('User',      userSchema);
const Session   = mongoose.model('Session',   sessionSchema);
const PanelBot  = mongoose.model('PanelBot',  panelBotSchema);
const Log       = mongoose.model('Log',       logSchema);

// ─── Runtime State ───────────────────────────────────────────────────────────
const runningProcs = new Map();   // sessionId → ChildProcess
let pingCount   = 0;
let lastPing    = null;
let cleanCount  = 0;
let lastClean   = null;
let startTime   = Date.now();

// ─── MongoDB Connect ──────────────────────────────────────────────────────────
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('✅  MongoDB connected:', MONGO_URI.replace(/:([^@]+)@/, ':***@'));
    await seedAdmin();
  } catch (err) {
    console.error('❌  MongoDB connection failed:', err.message);
    console.error('    Retrying in 5s…');
    setTimeout(connectDB, 5000);
  }
}

async function seedAdmin() {
  const existing = await User.findOne({ username: ADMIN_USER });
  if (!existing) {
    const hashed = await bcrypt.hash(ADMIN_PASS, 12);
    await User.create({ username: ADMIN_USER, password: hashed, role: 'admin', coins: 999999 });
    console.log(`✅  Admin user created: ${ADMIN_USER}`);
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions backed by MongoDB
app.use(session({
  secret: SESSION_SEC,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    ttl: 7 * 24 * 60 * 60,   // 7 days
    touchAfter: 24 * 3600,   // re-save only once per 24h unless data changes
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));

app.use(express.static(PUBLIC_DIR));

// ─── Multer (zip uploads) ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },   // 50MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) cb(null, true);
    else cb(new Error('Only ZIP files allowed'));
  },
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function developerOrAdmin(req, res, next) {
  if (!['admin','developer'].includes(req.user?.role))
    return res.status(403).json({ error: 'Developer or admin access required' });
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str = '') {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatUptime(ms) {
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600).toString().padStart(2,'0');
  const m = Math.floor((s%3600)/60).toString().padStart(2,'0');
  const sec = (s%60).toString().padStart(2,'0');
  return `${h}:${m}:${sec}`;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

function broadcast(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

function broadcastLog(sessionId, message, level = 'info') {
  broadcast({ type: 'log', sessionId, message, level, ts: new Date().toISOString() });
  // Persist last 200 logs per session (non-blocking)
  Log.create({ sessionId, message, level }).catch(() => {});
}

wss.on('connection', (ws, req) => {
  // Validate JWT from query param
  const url   = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  if (!token) { ws.close(4001, 'Unauthorized'); return; }
  try { ws.user = jwt.verify(token, JWT_SECRET); }
  catch { ws.close(4001, 'Invalid token'); return; }

  ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket live' }));
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: formatUptime(Date.now() - startTime) }));

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await User.findOne({ username, active: true });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user._id.toString(), username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // also set server session
    req.session.userId   = user._id.toString();
    req.session.username = user.username;
    req.session.role     = user.role;
    await req.session.save();

    res.json({ token, username: user.username, role: user.role, coins: user.coins });
  } catch (err) {
    console.error('/api/auth/login', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username, role: user.role, coins: user.coins, githubUrl: user.githubUrl, apiKey: user.apiKey });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── Admin — User Management ──────────────────────────────────────────────────
app.get('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const users = await User.find().select('-password').sort({ createdAt: -1 });
  res.json(users);
});

app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username, password, role, coins } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!['admin','developer','user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const exists = await User.findOne({ username });
    if (exists) return res.status(409).json({ error: 'Username already taken' });

    const hashed = await bcrypt.hash(password, 12);
    const apiKey = role === 'developer' ? `dev_${uuid().replace(/-/g,'').slice(0,24)}` : '';
    const user   = await User.create({
      username, password: hashed, role,
      coins: coins ?? (role === 'developer' ? 500 : 100),
      createdBy: req.user.username,
      apiKey,
    });

    res.json({ ok: true, id: user._id, username: user.username, role: user.role, apiKey: user.apiKey });
  } catch (err) {
    console.error('/api/admin/users POST', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { role, coins, active, password } = req.body;
    const update = {};
    if (role  !== undefined) update.role   = role;
    if (coins !== undefined) update.coins  = coins;
    if (active !== undefined) update.active = active;
    if (password) update.password = await bcrypt.hash(password, 12);
    if (role === 'developer') update.apiKey = `dev_${uuid().replace(/-/g,'').slice(0,24)}`;

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.username === ADMIN_USER) return res.status(403).json({ error: 'Cannot delete root admin' });
    await User.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/coins', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username, amount } = req.body;
    const user = await User.findOneAndUpdate({ username }, { $inc: { coins: amount } }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, coins: user.coins });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── Sessions API ─────────────────────────────────────────────────────────────
app.get('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const filter = req.user.role === 'admin' ? {} : { owner: req.user.username };
    const list   = await Session.find(filter).sort({ createdAt: -1 });
    // Attach runtime status
    const enriched = list.map(s => ({
      ...s.toObject(),
      status: runningProcs.has(s.id) ? 'running' : s.status,
    }));
    res.json(enriched);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const { botName, ownerName, ownerNumber, prefix, timezone, panelBotId } = req.body;
    if (!ownerName) return res.status(400).json({ error: 'ownerName required' });

    const id   = uuid();
    const sess = await Session.create({
      id, owner: req.user.username, ownerName,
      botName: botName || 'MyBot',
      ownerNumber: ownerNumber || '',
      prefix: prefix || '.',
      timezone: timezone || 'UTC',
      panelBotId: panelBotId || null,
      status: 'stopped',
    });
    broadcast({ type: 'session_created', session: sess });
    res.json({ ok: true, session: sess });
  } catch (err) {
    console.error('/api/sessions POST', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const sess = await Session.findOne({ id: req.params.id });
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (sess.owner !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });

    const { botName, ownerName, ownerNumber, prefix, timezone, panelBotId } = req.body;
    if (botName)     sess.botName     = botName;
    if (ownerName)   sess.ownerName   = ownerName;
    if (ownerNumber) sess.ownerNumber = ownerNumber;
    if (prefix)      sess.prefix      = prefix;
    if (timezone)    sess.timezone    = timezone;
    if (panelBotId !== undefined) sess.panelBotId = panelBotId;
    await sess.save();
    res.json({ ok: true, session: sess });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const sess = await Session.findOne({ id: req.params.id });
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (sess.owner !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });

    // Stop process if running
    if (runningProcs.has(sess.id)) {
      const proc = runningProcs.get(sess.id);
      proc.kill('SIGTERM');
      runningProcs.delete(sess.id);
    }
    await Session.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── Bot Control ──────────────────────────────────────────────────────────────
app.post('/api/bot/start', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sess = await Session.findOne({ id: sessionId });
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (sess.owner !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    if (runningProcs.has(sessionId)) return res.status(409).json({ error: 'Already running' });

    const user = await User.findOne({ username: req.user.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.coins < 5 && user.role !== 'admin') return res.status(402).json({ error: 'Insufficient coins (need 5)' });

    // Deduct coins
    if (user.role !== 'admin') {
      user.coins -= 5;
      await user.save();
    }

    // Find which script to run
    let scriptPath = null;
    if (sess.panelBotId) {
      const pb = await PanelBot.findOne({ id: sess.panelBotId });
      if (pb?.scriptPath && fs.existsSync(pb.scriptPath)) scriptPath = pb.scriptPath;
    }

    if (!scriptPath) {
      // fallback: write a dummy keep-alive script
      scriptPath = path.join(BOTS_DIR, 'default-bot.js');
      if (!fs.existsSync(scriptPath)) {
        fs.writeFileSync(scriptPath, `
const id = '${sessionId}';
console.log('[BOT] Session ' + id + ' started (default script)');
setInterval(() => {
  process.stdout.write('[BOT] ' + new Date().toISOString() + ' — keep alive\\n');
}, 10000);
process.on('SIGTERM', () => { console.log('[BOT] Stopping…'); process.exit(0); });
`);
      }
    }

    const proc = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        SESSION_ID:    sessionId,
        BOT_NAME:      sess.botName,
        OWNER_NUMBER:  sess.ownerNumber,
        PREFIX:        sess.prefix,
        TIMEZONE:      sess.timezone,
      },
      stdio: ['ignore','pipe','pipe'],
    });

    runningProcs.set(sessionId, proc);
    sess.status    = 'running';
    sess.lastStart = new Date();
    sess.pid       = proc.pid;
    await sess.save();
    broadcast({ type: 'status', sessionId, status: 'running' });

    proc.stdout.on('data', d => broadcastLog(sessionId, d.toString().trim()));
    proc.stderr.on('data', d => broadcastLog(sessionId, d.toString().trim(), 'error'));
    proc.on('exit', async (code) => {
      runningProcs.delete(sessionId);
      const s = await Session.findOne({ id: sessionId });
      if (s) { s.status = code === 0 ? 'stopped' : 'crashed'; s.pid = null; s.lastStop = new Date(); await s.save(); }
      broadcast({ type: 'status', sessionId, status: code === 0 ? 'stopped' : 'crashed' });
      broadcastLog(sessionId, `Process exited with code ${code}`, code === 0 ? 'info' : 'error');
    });

    res.json({ ok: true, coins: user.coins });
  } catch (err) {
    console.error('/api/bot/start', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/bot/stop', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const proc = runningProcs.get(sessionId);
    if (!proc) return res.status(404).json({ error: 'Bot not running' });
    proc.kill('SIGTERM');
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/bot/restart', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const proc = runningProcs.get(sessionId);
    if (proc) { proc.kill('SIGTERM'); await new Promise(r => proc.on('exit', r)); }

    // Re-use start logic via internal call
    const sess = await Session.findOne({ id: sessionId });
    if (!sess) return res.status(404).json({ error: 'Session not found' });

    let scriptPath = null;
    if (sess.panelBotId) {
      const pb = await PanelBot.findOne({ id: sess.panelBotId });
      if (pb?.scriptPath && fs.existsSync(pb.scriptPath)) scriptPath = pb.scriptPath;
    }
    if (!scriptPath) scriptPath = path.join(BOTS_DIR, 'default-bot.js');

    const newProc = spawn('node', [scriptPath], {
      env: { ...process.env, SESSION_ID: sessionId, BOT_NAME: sess.botName,
             OWNER_NUMBER: sess.ownerNumber, PREFIX: sess.prefix, TIMEZONE: sess.timezone },
      stdio: ['ignore','pipe','pipe'],
    });

    runningProcs.set(sessionId, newProc);
    sess.status = 'running'; sess.lastStart = new Date(); sess.pid = newProc.pid;
    await sess.save();
    broadcast({ type: 'status', sessionId, status: 'running' });

    newProc.stdout.on('data', d => broadcastLog(sessionId, d.toString().trim()));
    newProc.stderr.on('data', d => broadcastLog(sessionId, d.toString().trim(), 'error'));
    newProc.on('exit', async code => {
      runningProcs.delete(sessionId);
      const s = await Session.findOne({ id: sessionId });
      if (s) { s.status = code === 0 ? 'stopped' : 'crashed'; s.pid = null; s.lastStop = new Date(); await s.save(); }
      broadcast({ type: 'status', sessionId, status: code === 0 ? 'stopped' : 'crashed' });
    });

    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── Panel Bots API ───────────────────────────────────────────────────────────
app.get('/api/panel-bots', authMiddleware, async (req, res) => {
  const filter = req.user.role === 'admin'
    ? {}
    : { $or: [{ author: req.user.username }, { type: { $ne: 'local' } }] };
  const bots = await PanelBot.find(filter).sort({ createdAt: -1 });
  res.json(bots);
});

app.get('/api/panel-bots/:id', authMiddleware, async (req, res) => {
  const bot = await PanelBot.findOne({ id: req.params.id });
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json(bot);
});

// Upload ZIP bot
app.post('/api/panel-bots/upload', authMiddleware, developerOrAdmin, upload.single('botZip'), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Bot name required' });
    if (!req.file) return res.status(400).json({ error: 'ZIP file required' });

    const botId  = uuid();
    const destDir = path.join(BOTS_DIR, botId);
    fs.mkdirSync(destDir, { recursive: true });

    // Extract ZIP
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(destDir, true);
    fs.unlinkSync(req.file.path);

    // Find entry point
    const entries = fs.readdirSync(destDir);
    let entryPoint = entries.find(f => f === 'index.js') || entries.find(f => f.endsWith('.js'));
    if (!entryPoint) return res.status(400).json({ error: 'No .js file found in ZIP' });

    const scriptPath = path.join(destDir, entryPoint);
    const bot = await PanelBot.create({
      id: botId, name, description,
      author: req.user.username,
      scriptPath,
      type: 'zip',
      status: 'idle',
    });

    broadcast({ type: 'panel_bot_added', bot });
    res.json({ ok: true, bot });
  } catch (err) {
    console.error('/api/panel-bots/upload', err);
    res.status(500).json({ error: err.message });
  }
});

// Add bot via GitHub URL
app.post('/api/panel-bots/github', authMiddleware, developerOrAdmin, async (req, res) => {
  try {
    const { name, description, githubUrl } = req.body;
    if (!name)      return res.status(400).json({ error: 'Bot name required' });
    if (!githubUrl) return res.status(400).json({ error: 'GitHub URL required' });

    // Convert GitHub blob URL to raw URL
    let rawUrl = githubUrl
      .replace('https://github.com/', 'https://raw.githubusercontent.com/')
      .replace('/blob/', '/');

    // Validate it's actually a JS file or a repo
    if (!rawUrl.endsWith('.js')) {
      return res.status(400).json({ error: 'GitHub URL must point to a .js file (e.g. https://github.com/user/repo/blob/main/index.js)' });
    }

    // Fetch the script
    const response = await fetch(rawUrl, { headers: { 'User-Agent': 'LadyBugNodes/3.0' } });
    if (!response.ok) return res.status(400).json({ error: `Failed to fetch script (HTTP ${response.status}). Make sure the file is public.` });

    const scriptContent = await response.text();
    if (scriptContent.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Script too large (max 5MB)' });

    const botId     = uuid();
    const botDir    = path.join(BOTS_DIR, botId);
    fs.mkdirSync(botDir, { recursive: true });

    const scriptPath = path.join(botDir, 'index.js');
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');

    const bot = await PanelBot.create({
      id: botId, name, description,
      author: req.user.username,
      githubUrl: rawUrl,
      scriptPath,
      type: 'github',
      status: 'idle',
    });

    broadcast({ type: 'panel_bot_added', bot });
    res.json({ ok: true, bot });
  } catch (err) {
    console.error('/api/panel-bots/github', err);
    res.status(500).json({ error: err.message });
  }
});

// Update/re-pull GitHub bot
app.post('/api/panel-bots/:id/pull', authMiddleware, developerOrAdmin, async (req, res) => {
  try {
    const bot = await PanelBot.findOne({ id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (bot.type !== 'github') return res.status(400).json({ error: 'Not a GitHub bot' });
    if (bot.author !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });

    const response = await fetch(bot.githubUrl, { headers: { 'User-Agent': 'LadyBugNodes/3.0' } });
    if (!response.ok) return res.status(400).json({ error: `Failed to fetch: HTTP ${response.status}` });

    const content = await response.text();
    fs.writeFileSync(bot.scriptPath, content, 'utf8');
    bot.updatedAt = new Date();
    await bot.save();
    res.json({ ok: true, updatedAt: bot.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/panel-bots/:id', authMiddleware, developerOrAdmin, async (req, res) => {
  try {
    const bot = await PanelBot.findOne({ id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (bot.author !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });

    // Remove files
    if (bot.scriptPath) {
      const dir = path.dirname(bot.scriptPath);
      if (dir.startsWith(BOTS_DIR)) fs.rmSync(dir, { recursive: true, force: true });
    }
    await PanelBot.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── System Stats ─────────────────────────────────────────────────────────────
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const mem   = await si.mem();
    const total = await Session.countDocuments(req.user.role === 'admin' ? {} : { owner: req.user.username });
    const active = runningProcs.size;
    const user  = await User.findById(req.user.id).select('coins');
    res.json({
      uptime:      formatUptime(Date.now() - startTime),
      activeBots:  active,
      totalSessions: total,
      coins:       user?.coins ?? 0,
      pingCount,
      lastPing,
      cleanCount,
      lastClean,
      memUsed:     Math.round(mem.used / 1024 / 1024),
      memTotal:    Math.round(mem.total / 1024 / 1024),
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── Logs API ─────────────────────────────────────────────────────────────────
app.get('/api/logs/:sessionId', authMiddleware, async (req, res) => {
  const sess = await Session.findOne({ id: req.params.sessionId });
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  if (sess.owner !== req.user.username && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  const logs = await Log.find({ sessionId: req.params.sessionId }).sort({ ts: -1 }).limit(200);
  res.json(logs.reverse());
});

// ─── Developer: API key regen ─────────────────────────────────────────────────
app.post('/api/developer/regen-key', authMiddleware, developerOrAdmin, async (req, res) => {
  try {
    const key  = `dev_${uuid().replace(/-/g,'').slice(0,24)}`;
    const user = await User.findByIdAndUpdate(req.user.id, { apiKey: key }, { new: true });
    res.json({ ok: true, apiKey: user.apiKey });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Update developer GitHub profile URL
app.patch('/api/developer/profile', authMiddleware, developerOrAdmin, async (req, res) => {
  try {
    const { githubUrl } = req.body;
    const user = await User.findByIdAndUpdate(req.user.id, { githubUrl }, { new: true });
    res.json({ ok: true, githubUrl: user.githubUrl });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── Bot Installation ─────────────────────────────────────────────────────────
app.post('/api/install', authMiddleware, adminOnly, async (req, res) => {
  const mainScript = path.join(__dirname, 'bot', 'index.js');
  if (!fs.existsSync(mainScript)) return res.status(404).json({ error: 'Bot source not found' });
  res.json({ ok: true, message: 'Bot is installed' });
});

// ─── Cron: Keep-Alive Ping ────────────────────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  pingCount++;
  lastPing = new Date().toISOString();
  broadcast({ type: 'ping', count: pingCount, ts: lastPing });
  console.log(`⚡ Keep-alive ping #${pingCount}`);
});

// ─── Cron: Cleanup stopped/crashed procs ─────────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  cleanCount++;
  lastClean = new Date().toISOString();
  let cleaned = 0;
  for (const [id, proc] of runningProcs) {
    if (proc.exitCode !== null) {
      runningProcs.delete(id);
      cleaned++;
    }
  }
  console.log(`🧹 Cleanup #${cleanCount}: removed ${cleaned} dead procs`);
  broadcast({ type: 'cleanup', count: cleanCount, cleaned, ts: lastClean });
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🐞 LADYBUGNODES v3.0 running on http://localhost:${PORT}`);
    console.log(`   MongoDB: ${MONGO_URI.replace(/:([^@]+)@/, ':***@')}`);
    console.log(`   Admin:   ${ADMIN_USER}`);
    console.log('');
  });
});
