/**
 * LADYBUGNODES v3.0 — server.js
 * Original working logic preserved + MongoDB persistence + new roles/features
 */
'use strict';
require('dotenv').config();

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const session      = require('express-session');
const MongoStore   = require('connect-mongo');
const mongoose     = require('mongoose');
const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');
const { spawn }    = require('child_process');
const cron         = require('node-cron');
const fetch        = require('node-fetch');
const multer       = require('multer');
const AdmZip       = require('adm-zip');

const PORT        = process.env.PORT          || 3000;
const JWT_SECRET  = process.env.JWT_SECRET    || 'ladybugnodes_secret_change_me_in_production';
const SESSION_SEC = process.env.SESSION_SECRET|| 'ladybugnodes_session_secret_change_me';
const MONGO_URI   = process.env.MONGODB_URI   || 'mongodb://127.0.0.1:27017/ladybugnodes';
const ADMIN_USER  = process.env.ADMIN_USERNAME|| 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD|| 'Admin@LadyBug2024!';

const PUBLIC_DIR  = path.join(__dirname, 'public');
const BOTS_DIR    = path.join(__dirname, 'panel-bots');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[PUBLIC_DIR, BOTS_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Schemas ──────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuid(), unique: true },
  username:  { type: String, required: true, unique: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['admin','developer','user'], default: 'user' },
  coins:     { type: Number, default: 50 },
  createdAt: { type: Date, default: Date.now },
  active:    { type: Boolean, default: true },
});

const sessionSchema = new mongoose.Schema({
  id:           { type: String, default: () => uuid(), unique: true },
  ownerUsername:{ type: String, required: true },
  ownerName:    { type: String, required: true },
  ownerNumber:  { type: String, default: '' },
  sessionIdStr: { type: String, default: '' },
  botName:      { type: String, default: 'LadybugBot' },
  prefix:       { type: String, default: '.' },
  timezone:     { type: String, default: 'Africa/Harare' },
  panelBotId:   { type: String, default: null },
  status:       { type: String, default: 'stopped' },
  createdAt:    { type: Date, default: Date.now },
  pid:          { type: Number, default: null },
});

const panelBotSchema = new mongoose.Schema({
  id:           { type: String, default: () => uuid(), unique: true },
  name:         { type: String, required: true },
  description:  { type: String, default: '' },
  entryPoint:   { type: String, default: 'index.js' },
  ownerUsername:{ type: String, default: '' },
  githubUrl:    { type: String, default: '' },
  scriptPath:   { type: String, default: '' },
  type:         { type: String, enum: ['zip','github','local'], default: 'zip' },
  status:       { type: String, default: 'stopped' },
  createdAt:    { type: Date, default: Date.now },
});

const User     = mongoose.model('User',     userSchema);
const Session  = mongoose.model('Session',  sessionSchema);
const PanelBot = mongoose.model('PanelBot', panelBotSchema);

// ── Runtime state ────────────────────────────────────────────────────────────
const runningProcs = new Map();
let pingCount = 0, lastPing = null;
let cleanCount = 0, lastClean = null;
const startTime = Date.now();
const logBuffer = [];

function pushLog(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer.shift();
  broadcast({ type: 'log', ...entry });
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅  MongoDB connected');
    await seedAdmin();
  } catch (err) {
    console.error('❌  MongoDB:', err.message, '— retry in 5s');
    setTimeout(connectDB, 5000);
  }
}

async function seedAdmin() {
  if (!(await User.findOne({ username: ADMIN_USER }))) {
    const hash = await bcrypt.hash(ADMIN_PASS, 12);
    await User.create({ username: ADMIN_USER, password: hash, role: 'admin', coins: 999999 });
    console.log('✅  Admin created:', ADMIN_USER);
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SEC,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, ttl: 7*24*3600, touchAfter: 24*3600 }),
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 7*24*60*60*1000 },
}));

app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({
  storage,
  limits: { fileSize: 50*1024*1024 },
  fileFilter: (req, file, cb) =>
    (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) ? cb(null,true) : cb(new Error('ZIP only')),
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ ok:false, error:'Unauthorized' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ ok:false, error:'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok:false, error:'Admin only' });
  next();
}
function devOrAdmin(req, res, next) {
  if (!['admin','developer'].includes(req.user?.role))
    return res.status(403).json({ ok:false, error:'Developer or admin only' });
  next();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

wss.on('connection', async (ws) => {
  try {
    const sessions  = await Session.find().lean();
    const panelBots = await PanelBot.find().lean();
    ws.send(JSON.stringify({ type:'init', logs: logBuffer, sessions, panelBots, serverStatus: getServerStatus() }));
  } catch {}
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok:true }));

// ── Login page ────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ ok:false, error:'Missing credentials' });
    const user = await User.findOne({ username, active:true });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ ok:false, error:'Invalid username or password' });
    const token = jwt.sign({ id:user.id, username:user.username, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    res.json({ ok:true, token, user:{ id:user.id, username:user.username, role:user.role, coins:user.coins } });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok:true })); });

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findOne({ id:req.user.id });
    if (!user) return res.status(404).json({ ok:false, error:'Not found' });
    res.json({ id:user.id, username:user.username, role:user.role, coins:user.coins });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

// Register — admin only, with role selector
app.post('/api/auth/register', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, coins, role } = req.body;
    if (!username || !password) return res.status(400).json({ ok:false, error:'Username and password required' });
    const validRoles   = ['admin','developer','user'];
    const assignedRole = validRoles.includes(role) ? role : 'user';
    if (await User.findOne({ username })) return res.status(409).json({ ok:false, error:'Username already exists' });
    const hash = await bcrypt.hash(password, 12);
    const defaultCoins = assignedRole==='developer' ? 500 : assignedRole==='admin' ? 999999 : 50;
    const user = await User.create({ username, password:hash, role:assignedRole, coins: Number(coins)||defaultCoins });
    pushLog({ level:'ok', ts:new Date().toISOString(), msg:`Admin created user: ${username} (${assignedRole})` });
    res.json({ ok:true, user:{ id:user.id, username:user.username, role:user.role, coins:user.coins } });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt:-1 }).lean();
    res.json(users.map(u => ({ ...u, id: u.id || u._id.toString() })));
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const user = await User.findOne({ id:req.params.id });
    if (!user) return res.status(404).json({ ok:false, error:'Not found' });
    if (user.username === ADMIN_USER) return res.status(403).json({ ok:false, error:'Cannot delete root admin' });
    await User.deleteOne({ id:req.params.id });
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

// ── Coins ─────────────────────────────────────────────────────────────────────
app.post('/api/coins/add', auth, adminOnly, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const user = await User.findOneAndUpdate({ id:userId }, { $inc:{ coins:Number(amount) } }, { new:true });
    if (!user) return res.status(404).json({ ok:false, error:'User not found' });
    broadcast({ type:'coins-updated', userId:user.id, coins:user.coins });
    res.json({ ok:true, coins:user.coins });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', auth, async (req, res) => {
  try {
    const filter = req.user.role==='admin' ? {} : { ownerUsername:req.user.username };
    const list   = await Session.find(filter).sort({ createdAt:-1 }).lean();
    res.json(list.map(s => ({ ...s, id: s.id||s._id.toString(), status: runningProcs.has(s.id) ? 'running' : (s.status||'stopped') })));
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/sessions', auth, async (req, res) => {
  try {
    const { ownerName, ownerNumber, sessionIdStr, botName, prefix, timezone, panelBotId } = req.body;
    if (!ownerName) return res.status(400).json({ ok:false, error:'ownerName required' });
    const sess = await Session.create({
      ownerUsername: req.user.username,
      ownerName, ownerNumber, sessionIdStr,
      botName: botName||'LadybugBot',
      prefix: prefix||'.',
      timezone: timezone||'Africa/Harare',
      panelBotId: panelBotId||null,
      status:'stopped',
    });
    broadcast({ type:'session-created', session:{ ...sess.toObject(), id:sess.id } });
    res.json({ ok:true, session:{ ...sess.toObject(), id:sess.id } });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.put('/api/sessions/:id', auth, async (req, res) => {
  try {
    const sess = await Session.findOne({ id:req.params.id });
    if (!sess) return res.status(404).json({ ok:false, error:'Not found' });
    if (sess.ownerUsername!==req.user.username && req.user.role!=='admin') return res.status(403).json({ ok:false, error:'Forbidden' });
    ['ownerName','ownerNumber','sessionIdStr','botName','prefix','timezone','panelBotId'].forEach(f => { if (req.body[f]!==undefined) sess[f]=req.body[f]; });
    await sess.save();
    broadcast({ type:'session-updated', session:{ ...sess.toObject(), id:sess.id } });
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.delete('/api/sessions/:id', auth, async (req, res) => {
  try {
    const sess = await Session.findOne({ id:req.params.id });
    if (!sess) return res.status(404).json({ ok:false, error:'Not found' });
    if (sess.ownerUsername!==req.user.username && req.user.role!=='admin') return res.status(403).json({ ok:false, error:'Forbidden' });
    if (runningProcs.has(sess.id)) { runningProcs.get(sess.id).kill('SIGTERM'); runningProcs.delete(sess.id); }
    await Session.deleteOne({ id:req.params.id });
    broadcast({ type:'session-deleted', sessionId:sess.id });
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

// ── Bot spawn helper ──────────────────────────────────────────────────────────
async function spawnBot(sess) {
  if (runningProcs.has(sess.id)) return;
  let scriptPath = null;
  if (sess.panelBotId) {
    const pb = await PanelBot.findOne({ id:sess.panelBotId });
    if (pb?.scriptPath && fs.existsSync(pb.scriptPath)) scriptPath = pb.scriptPath;
  }
  if (!scriptPath) {
    scriptPath = path.join(BOTS_DIR, 'default-bot.js');
    if (!fs.existsSync(scriptPath)) {
      fs.writeFileSync(scriptPath, `
const id = process.env.SESSION_ID;
console.log('[BOT] Session started: ' + id);
setInterval(() => process.stdout.write('[BOT] alive\\n'), 15000);
process.on('SIGTERM', () => { console.log('[BOT] Stopping'); process.exit(0); });
`);
    }
  }
  const proc = spawn('node', [scriptPath], {
    env: { ...process.env, SESSION_ID:sess.id, SESSION_ID_STR:sess.sessionIdStr||'', BOT_NAME:sess.botName, OWNER_NAME:sess.ownerName, OWNER_NUMBER:sess.ownerNumber||'', PREFIX:sess.prefix||'.', TIMEZONE:sess.timezone||'Africa/Harare' },
    stdio: ['ignore','pipe','pipe'],
  });
  runningProcs.set(sess.id, proc);
  sess.status = 'running'; sess.pid = proc.pid; await sess.save();
  broadcast({ type:'status', sessionId:sess.id, status:'running' });
  proc.stdout.on('data', d => pushLog({ level:'bot', ts:new Date().toISOString(), msg:`[${sess.id.slice(0,8)}] ${d.toString().trim()}` }));
  proc.stderr.on('data', d => pushLog({ level:'error', ts:new Date().toISOString(), msg:`[${sess.id.slice(0,8)}] ${d.toString().trim()}` }));
  proc.on('exit', async (code) => {
    runningProcs.delete(sess.id);
    const s = await Session.findOne({ id:sess.id });
    if (s) { s.status = code===0 ? 'stopped' : 'crashed'; s.pid = null; await s.save(); }
    broadcast({ type:'status', sessionId:sess.id, status: code===0 ? 'stopped' : 'crashed' });
  });
}

// ── Bot control ───────────────────────────────────────────────────────────────
app.post('/api/bot/start', auth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sess = await Session.findOne({ id:sessionId });
    if (!sess) return res.status(404).json({ ok:false, error:'Session not found' });
    if (sess.ownerUsername!==req.user.username && req.user.role!=='admin') return res.status(403).json({ ok:false, error:'Forbidden' });
    if (runningProcs.has(sessionId)) return res.status(409).json({ ok:false, error:'Already running' });
    const user = await User.findOne({ id:req.user.id });
    if (user.role!=='admin' && user.coins < 5) return res.status(402).json({ ok:false, error:'Not enough coins (need 5)' });
    if (user.role!=='admin') { user.coins -= 5; await user.save(); }
    await spawnBot(sess);
    res.json({ ok:true, coins:user.coins });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/bot/stop', auth, async (req, res) => {
  try {
    const proc = runningProcs.get(req.body.sessionId);
    if (!proc) return res.status(404).json({ ok:false, error:'Not running' });
    proc.kill('SIGTERM');
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/bot/restart', auth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const proc = runningProcs.get(sessionId);
    if (proc) { proc.kill('SIGTERM'); await new Promise(r => proc.on('exit', r)); }
    const sess = await Session.findOne({ id:sessionId });
    if (!sess) return res.status(404).json({ ok:false, error:'Not found' });
    await spawnBot(sess);
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

// ── Panel Bots ────────────────────────────────────────────────────────────────
app.get('/api/panel-bots', auth, async (req, res) => {
  try {
    const bots = await PanelBot.find().sort({ createdAt:-1 }).lean();
    res.json(bots.map(b => ({ ...b, id: b.id||b._id.toString() })));
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/panel-bots/upload', auth, upload.single('botZip'), async (req, res) => {
  try {
    const { name, description, entryPoint } = req.body;
    if (!name) return res.status(400).json({ ok:false, error:'Name required' });
    if (!req.file) return res.status(400).json({ ok:false, error:'ZIP file required' });
    const botId = uuid();
    const destDir = path.join(BOTS_DIR, botId);
    fs.mkdirSync(destDir, { recursive:true });
    new AdmZip(req.file.path).extractAllTo(destDir, true);
    fs.unlinkSync(req.file.path);
    const ep = entryPoint||'index.js';
    const scriptPath = path.join(destDir, ep);
    if (!fs.existsSync(scriptPath)) return res.status(400).json({ ok:false, error:`Entry point "${ep}" not found in ZIP` });
    const bot = await PanelBot.create({ id:botId, name, description:description||'', entryPoint:ep, ownerUsername:req.user.username, scriptPath, type:'zip', status:'stopped' });
    pushLog({ level:'ok', ts:new Date().toISOString(), msg:`Panel bot uploaded: ${name} by ${req.user.username}` });
    res.json({ ok:true, bot:{ ...bot.toObject(), id:bot.id } });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:err.message }); }
});

// GitHub URL bot — developer or admin only
app.post('/api/panel-bots/github', auth, devOrAdmin, async (req, res) => {
  try {
    const { name, description, githubUrl } = req.body;
    if (!name)      return res.status(400).json({ ok:false, error:'Name required' });
    if (!githubUrl) return res.status(400).json({ ok:false, error:'GitHub URL required' });
    let rawUrl = githubUrl.replace('https://github.com/','https://raw.githubusercontent.com/').replace('/blob/','/');
    if (!rawUrl.endsWith('.js')) return res.status(400).json({ ok:false, error:'URL must point to a .js file (e.g. .../blob/main/index.js)' });
    const response = await fetch(rawUrl, { headers:{ 'User-Agent':'LadyBugNodes/3.0' } });
    if (!response.ok) return res.status(400).json({ ok:false, error:`Cannot fetch: HTTP ${response.status}. Is the repo public?` });
    const content = await response.text();
    const botId = uuid();
    const botDir = path.join(BOTS_DIR, botId);
    fs.mkdirSync(botDir, { recursive:true });
    const scriptPath = path.join(botDir, 'index.js');
    fs.writeFileSync(scriptPath, content, 'utf8');
    const bot = await PanelBot.create({ id:botId, name, description:description||'', entryPoint:'index.js', ownerUsername:req.user.username, githubUrl:rawUrl, scriptPath, type:'github', status:'stopped' });
    pushLog({ level:'ok', ts:new Date().toISOString(), msg:`GitHub bot added: ${name} by ${req.user.username}` });
    res.json({ ok:true, bot:{ ...bot.toObject(), id:bot.id } });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:err.message }); }
});

app.post('/api/panel-bots/:id/pull', auth, devOrAdmin, async (req, res) => {
  try {
    const bot = await PanelBot.findOne({ id:req.params.id });
    if (!bot) return res.status(404).json({ ok:false, error:'Not found' });
    if (bot.type!=='github') return res.status(400).json({ ok:false, error:'Not a GitHub bot' });
    const r = await fetch(bot.githubUrl, { headers:{ 'User-Agent':'LadyBugNodes/3.0' } });
    if (!r.ok) return res.status(400).json({ ok:false, error:`Fetch failed: HTTP ${r.status}` });
    fs.writeFileSync(bot.scriptPath, await r.text(), 'utf8');
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

app.put('/api/panel-bots/:id', auth, async (req, res) => {
  try {
    const bot = await PanelBot.findOne({ id:req.params.id });
    if (!bot) return res.status(404).json({ ok:false, error:'Not found' });
    if (bot.ownerUsername!==req.user.username && req.user.role!=='admin') return res.status(403).json({ ok:false, error:'Forbidden' });
    const { name, description, entryPoint } = req.body;
    if (name) bot.name = name;
    if (description!==undefined) bot.description = description;
    if (entryPoint) bot.entryPoint = entryPoint;
    await bot.save();
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/panel-bots/:id/start', auth, async (req, res) => {
  try {
    const bot = await PanelBot.findOne({ id:req.params.id });
    if (!bot) return res.status(404).json({ ok:false, error:'Not found' });
    if (runningProcs.has(bot.id)) return res.status(409).json({ ok:false, error:'Already running' });
    if (!bot.scriptPath || !fs.existsSync(bot.scriptPath)) return res.status(400).json({ ok:false, error:'Script not found on server' });
    const user = await User.findOne({ id:req.user.id });
    if (user.role!=='admin' && user.coins < 5) return res.status(402).json({ ok:false, error:'Not enough coins (need 5)' });
    if (user.role!=='admin') { user.coins -= 5; await user.save(); }
    const proc = spawn('node', [bot.scriptPath], { env:{ ...process.env, PANEL_BOT_ID:bot.id, BOT_NAME:bot.name }, stdio:['ignore','pipe','pipe'] });
    runningProcs.set(bot.id, proc);
    bot.status = 'running'; await bot.save();
    broadcast({ type:'status', panelBotId:bot.id, status:'running' });
    proc.stdout.on('data', d => pushLog({ level:'bot', ts:new Date().toISOString(), msg:`[PB:${bot.id.slice(0,8)}] ${d.toString().trim()}` }));
    proc.stderr.on('data', d => pushLog({ level:'error', ts:new Date().toISOString(), msg:`[PB:${bot.id.slice(0,8)}] ${d.toString().trim()}` }));
    proc.on('exit', async (code) => {
      runningProcs.delete(bot.id);
      const b = await PanelBot.findOne({ id:bot.id });
      if (b) { b.status = code===0 ? 'stopped' : 'crashed'; await b.save(); }
      broadcast({ type:'status', panelBotId:bot.id, status: code===0 ? 'stopped' : 'crashed' });
    });
    res.json({ ok:true, coins:user.coins });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/panel-bots/:id/stop', auth, async (req, res) => {
  try {
    const proc = runningProcs.get(req.params.id);
    if (!proc) return res.status(404).json({ ok:false, error:'Not running' });
    proc.kill('SIGTERM');
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/panel-bots/:id/restart', auth, async (req, res) => {
  try {
    const proc = runningProcs.get(req.params.id);
    if (proc) { proc.kill('SIGTERM'); await new Promise(r => proc.on('exit', r)); }
    const bot = await PanelBot.findOne({ id:req.params.id });
    if (!bot) return res.status(404).json({ ok:false, error:'Not found' });
    const newProc = spawn('node', [bot.scriptPath], { env:{ ...process.env, PANEL_BOT_ID:bot.id, BOT_NAME:bot.name }, stdio:['ignore','pipe','pipe'] });
    runningProcs.set(bot.id, newProc);
    bot.status = 'running'; await bot.save();
    broadcast({ type:'status', panelBotId:bot.id, status:'running' });
    newProc.stdout.on('data', d => pushLog({ level:'bot', ts:new Date().toISOString(), msg:`[PB:${bot.id.slice(0,8)}] ${d.toString().trim()}` }));
    newProc.stderr.on('data', d => pushLog({ level:'error', ts:new Date().toISOString(), msg:`[PB:${bot.id.slice(0,8)}] ${d.toString().trim()}` }));
    newProc.on('exit', async (code) => {
      runningProcs.delete(bot.id);
      const b = await PanelBot.findOne({ id:bot.id });
      if (b) { b.status = code===0 ? 'stopped' : 'crashed'; await b.save(); }
      broadcast({ type:'status', panelBotId:bot.id, status: code===0 ? 'stopped' : 'crashed' });
    });
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

app.delete('/api/panel-bots/:id', auth, async (req, res) => {
  try {
    const bot = await PanelBot.findOne({ id:req.params.id });
    if (!bot) return res.status(404).json({ ok:false, error:'Not found' });
    if (bot.ownerUsername!==req.user.username && req.user.role!=='admin') return res.status(403).json({ ok:false, error:'Forbidden' });
    if (runningProcs.has(bot.id)) { runningProcs.get(bot.id).kill('SIGTERM'); runningProcs.delete(bot.id); }
    if (bot.scriptPath) { const dir = path.dirname(bot.scriptPath); if (dir.startsWith(BOTS_DIR)) fs.rmSync(dir, { recursive:true, force:true }); }
    await PanelBot.deleteOne({ id:req.params.id });
    res.json({ ok:true });
  } catch { res.status(500).json({ ok:false, error:'Server error' }); }
});

// ── Install ───────────────────────────────────────────────────────────────────
app.post('/api/install', auth, adminOnly, (req, res) => {
  pushLog({ level:'ok', ts:new Date().toISOString(), msg:'Install triggered by admin' });
  res.json({ ok:true, message:'Install triggered. Check logs.' });
});

// ── Status ────────────────────────────────────────────────────────────────────
function getServerStatus() {
  return { uptime: Math.floor((Date.now()-startTime)/1000), pingCount, lastPing, cleanCount, lastClean, mem: process.memoryUsage() };
}
app.get('/api/status', (req, res) => res.json(getServerStatus()));

// ── Crons ─────────────────────────────────────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  pingCount++; lastPing = new Date().toISOString();
  broadcast({ type:'ping', pingCount, ts:lastPing });
  console.log('⚡ Keep-alive #' + pingCount);
});

cron.schedule('*/30 * * * *', async () => {
  cleanCount++; lastClean = new Date().toISOString();
  let removed = 0, freedBytes = 0;
  for (const [id, proc] of runningProcs) { if (proc.exitCode !== null) { runningProcs.delete(id); removed++; } }
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, f);
      const stat = fs.statSync(fp);
      if (Date.now()-stat.mtimeMs > 3600000) { freedBytes += stat.size; fs.unlinkSync(fp); }
    }
  } catch {}
  const freedMB = (freedBytes/1024/1024).toFixed(2);
  broadcast({ type:'cleanup', cleanCount, removed, freedMB, ts:lastClean });
  console.log('🧹 Cleanup #' + cleanCount + ': ' + removed + ' procs, ' + freedMB + 'MB freed');
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok:false, error:'Not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log('\n🐞 LADYBUGNODES v3.0 — http://localhost:' + PORT);
    console.log('   MongoDB: ' + MONGO_URI.replace(/:([^@]+)@/, ':***@'));
  });
});
