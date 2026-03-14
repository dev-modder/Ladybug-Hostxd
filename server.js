/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║        LADYBUGNODES HOSTING PLATFORM v4.0.0 - WITH MONGODB                  ║
 * ║   Advanced Bot Hosting with Multi-Server, Bot Upload &amp; Approval System     ║
 * ║   Features: MongoDB, Bot Uploads, URL Import, Admin Approval, Multi-Server ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * Features:
 *  • MongoDB database for scalable storage
 *  • User registration and authentication with JWT
 *  • Coin-based service system
 *  • Bot upload via file or URL
 *  • Admin approval workflow for bots
 *  • Multi-server support
 *  • Bot name display when hosted
 *  • Real-time WebSocket log streaming
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
const { spawn, execSync } = require('child_process');
const os          = require('os');
const crypto      = require('crypto');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mongoose    = require('mongoose');
const multer      = require('multer');

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════
const BOT_REPO_URL = process.env.BOT_REPO_URL || 'https://github.com/dev-modder/Ladybug-Mini.git';
const BOT_DIR_NAME = 'Ladybug-Mini';

const PORT            = process.env.PORT || 3000;
const RENDER_URL      = (process.env.RENDER_URL || '').trim();
const PING_INTERVAL   = parseInt(process.env.PING_INTERVAL   || '14');
const CLEANUP_INTERVAL= parseInt(process.env.CLEANUP_INTERVAL|| '30');
const BOT_NAME        = process.env.BOT_NAME   || 'LadybugNodes Bot';
const DASHBOARD_PIN   = process.env.DASHBOARD_PIN || '';
const JWT_SECRET      = process.env.JWT_SECRET || 'ladybugnodes-secret-key-2024';
const MONGODB_URI     = process.env.MONGODB_URI || 'mongodb://localhost:27017/ladybugnodes';
const UPLOAD_DIR      = path.join(__dirname, 'uploads');
const BOTS_DIR        = path.join(__dirname, 'hosted-bots');

// Create necessary directories
[UPLOAD_DIR, BOTS_DIR, path.join(__dirname, 'data')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MongoDB Connection &amp; Models
// ═══════════════════════════════════════════════════════════════════════════════

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => log('OK', 'Connected to MongoDB successfully'))
  .catch(err => log('ERR', 'MongoDB connection error: ' + err.message));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  coins: { type: Number, default: 100 },
  isAdmin: { type: Boolean, default: false },
  isPremium: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
});
const User = mongoose.model('User', userSchema);

// Bot Schema
const botSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerName: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'running', 'stopped'], default: 'pending' },
  sourceType: { type: String, enum: ['upload', 'url', 'github'], required: true },
  sourceUrl: { type: String },
  filePath: { type: String },
  serverId: { type: String },
  sessionName: { type: String },
  port: { type: Number },
  pid: { type: Number },
  coinsSpent: { type: Number, default: 0 },
  hostingDays: { type: Number, default: 7 },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  approvedAt: { type: Date },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectionReason: { type: String }
});
const Bot = mongoose.model('Bot', botSchema);

// Server Schema
const serverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  region: { type: String, default: 'US-East' },
  host: { type: String, default: 'localhost' },
  port: { type: Number },
  maxBots: { type: Number, default: 10 },
  activeBots: { type: Number, default: 0 },
  status: { type: String, enum: ['online', 'offline', 'maintenance'], default: 'online' },
  specs: {
    cpu: { type: String, default: '2 vCPU' },
    ram: { type: String, default: '4GB' },
    storage: { type: String, default: '50GB SSD' }
  },
  createdAt: { type: Date, default: Date.now }
});
const Server = mongoose.model('Server', serverSchema);

// Service Schema
const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  cost: { type: Number, required: true },
  duration: { type: Number, default: 0 },
  features: [String],
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const Service = mongoose.model('Service', serviceSchema);

// Transaction Schema
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['purchase', 'bonus', 'admin_add', 'admin_deduct', 'refund'], required: true },
  amount: { type: Number, required: true },
  description: { type: String },
  botId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot' },
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// ═══════════════════════════════════════════════════════════════════════════════
// Express Setup
// ═══════════════════════════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.zip', '.js', '.json', '.ts'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext) || file.mimetype === 'application/zip') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only .zip, .js, .json, .ts allowed'));
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Logging Utility
// ═══════════════════════════════════════════════════════════════════════════════
const LOG_LEVELS = { INFO: '\x1b[36m', OK: '\x1b[32m', WARN: '\x1b[33m', ERR: '\x1b[31m' };
function log(level, message) {
  const timestamp = new Date().toISOString();
  const color = LOG_LEVELS[level] || '\x1b[0m';
  console.log(`${color}[${level.padEnd(4)}]\x1b[0m ${timestamp} ${message}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Authentication Middleware
// ═══════════════════════════════════════════════════════════════════════════════
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    req.user = user;
    req.token = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const adminMiddleware = async (req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════════════════════
// Initialize Default Data
// ═══════════════════════════════════════════════════════════════════════════════
async function initializeData() {
  try {
    // Create admin user if not exists
    let admin = await User.findOne({ username: 'devntando' });
    if (!admin) {
      const hashedPassword = await bcrypt.hash('ntando', 10);
      admin = await User.create({
        username: 'devntando',
        email: 'admin@ladybugnodes.com',
        password: hashedPassword,
        coins: 999999999,
        isAdmin: true,
        isPremium: true
      });
      log('OK', 'Admin user created: devntando');
    }

    // Create default servers
    const serverCount = await Server.countDocuments();
    if (serverCount === 0) {
      await Server.insertMany([
        { name: 'US-East-1', region: 'US-East', host: 'localhost', maxBots: 20, specs: { cpu: '4 vCPU', ram: '8GB', storage: '100GB SSD' } },
        { name: 'US-West-1', region: 'US-West', host: 'localhost', maxBots: 15, specs: { cpu: '2 vCPU', ram: '4GB', storage: '50GB SSD' } },
        { name: 'EU-London-1', region: 'Europe', host: 'localhost', maxBots: 15, specs: { cpu: '2 vCPU', ram: '4GB', storage: '50GB SSD' } },
        { name: 'Asia-Singapore-1', region: 'Asia-Pacific', host: 'localhost', maxBots: 10, specs: { cpu: '2 vCPU', ram: '4GB', storage: '50GB SSD' } }
      ]);
      log('OK', 'Default servers created');
    }

    // Create default services
    const serviceCount = await Service.countDocuments();
    if (serviceCount === 0) {
      await Service.insertMany([
        { name: 'Basic Bot Hosting', description: 'Host your bot for 7 days', cost: 50, duration: 7, features: ['7 Days Hosting', 'Basic Support', '1 Bot Instance'] },
        { name: 'Premium Bot Hosting', description: 'Host your bot for 30 days', cost: 150, duration: 30, features: ['30 Days Hosting', 'Priority Support', '2 Bot Instances', 'Custom Bot Name'] },
        { name: 'VIP Bot Hosting', description: 'Host your bot for 90 days with premium features', cost: 400, duration: 90, features: ['90 Days Hosting', '24/7 Support', '5 Bot Instances', 'Custom Bot Name', 'Priority Server'] },
        { name: 'Custom Bot Name', description: 'Set a custom name for your bot', cost: 20, duration: 0, features: ['Permanent Custom Name'] },
        { name: 'Extra Session Slot', description: 'Add an additional bot session slot', cost: 100, duration: 30, features: ['30 Days', 'Extra Bot Instance'] }
      ]);
      log('OK', 'Default services created');
    }

    log('OK', 'Initialization complete');
  } catch (error) {
    log('ERR', 'Initialization error: ' + error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Authentication
// ═══════════════════════════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      coins: 100 // Welcome bonus
    });

    const token = jwt.sign(
      { id: user._id, username: user.username, isAdmin: user.isAdmin, coins: user.coins },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Registration successful',
      token,
      user: { id: user._id, username: user.username, email: user.email, coins: user.coins, isAdmin: user.isAdmin, isPremium: user.isPremium }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      { id: user._id, username: user.username, isAdmin: user.isAdmin, coins: user.coins },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user._id, username: user.username, email: user.email, coins: user.coins, isAdmin: user.isAdmin, isPremium: user.isPremium }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Bots
// ═══════════════════════════════════════════════════════════════════════════════

// Get all bots (user sees their own, admin sees all)
app.get('/api/bots', authMiddleware, async (req, res) => {
  try {
    const bots = req.user.isAdmin 
      ? await Bot.find().populate('ownerId', 'username email').populate('approvedBy', 'username')
      : await Bot.find({ ownerId: req.user._id });
    res.json(bots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload bot via file
app.post('/api/bots/upload', authMiddleware, upload.single('botFile'), async (req, res) => {
  try {
    const { name, description, serverId, hostingDays } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const bot = await Bot.create({
      name: name || req.file.originalname,
      description,
      ownerId: req.user._id,
      ownerName: req.user.username,
      status: 'pending',
      sourceType: 'upload',
      filePath: req.file.path,
      serverId,
      hostingDays: parseInt(hostingDays) || 7
    });

    res.json({ message: 'Bot uploaded successfully and pending approval', bot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload bot via URL
app.post('/api/bots/url', authMiddleware, async (req, res) => {
  try {
    const { name, description, serverId, hostingDays, url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL
    let validatedUrl;
    try {
      validatedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Check if it's a GitHub URL
    const isGithub = validatedUrl.hostname === 'github.com' || validatedUrl.hostname === 'raw.githubusercontent.com';
    const sourceType = isGithub ? 'github' : 'url';

    const bot = await Bot.create({
      name: name || 'Bot from URL',
      description,
      ownerId: req.user._id,
      ownerName: req.user.username,
      status: 'pending',
      sourceType,
      sourceUrl: url,
      serverId,
      hostingDays: parseInt(hostingDays) || 7
    });

    res.json({ message: 'Bot URL submitted successfully and pending approval', bot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get bot details
app.get('/api/bots/:id', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).populate('ownerId', 'username email');
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    // Check ownership or admin
    if (!req.user.isAdmin &amp;&amp; bot.ownerId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    res.json(bot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update bot
app.put('/api/bots/:id', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    // Check ownership
    if (!req.user.isAdmin &amp;&amp; bot.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { name, description } = req.body;
    if (name) bot.name = name;
    if (description) bot.description = description;
    
    await bot.save();
    res.json({ message: 'Bot updated successfully', bot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete bot
app.delete('/api/bots/:id', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    // Check ownership or admin
    if (!req.user.isAdmin &amp;&amp; bot.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Stop bot if running
    if (bot.pid) {
      try {
        process.kill(bot.pid, 'SIGTERM');
      } catch (e) {}
    }
    
    // Delete files
    if (bot.filePath &amp;&amp; fs.existsSync(bot.filePath)) {
      fs.unlinkSync(bot.filePath);
    }
    
    await Bot.findByIdAndDelete(req.params.id);
    res.json({ message: 'Bot deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Admin Bot Management
// ═══════════════════════════════════════════════════════════════════════════════

// Get pending bots
app.get('/api/admin/bots/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const bots = await Bot.find({ status: 'pending' }).populate('ownerId', 'username email');
    res.json(bots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve bot
app.post('/api/admin/bots/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).populate('ownerId');
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const owner = await User.findById(bot.ownerId._id);
    
    // Calculate cost
    const service = await Service.findOne({ duration: bot.hostingDays });
    const cost = service ? service.cost : 50 * bot.hostingDays;
    
    // Check if owner has enough coins (admin bots are free)
    if (!owner.isAdmin &amp;&amp; owner.coins < cost) {
      return res.status(400).json({ error: 'Owner does not have enough coins' });
    }

    // Deduct coins
    if (!owner.isAdmin) {
      owner.coins -= cost;
      await owner.save();
      
      await Transaction.create({
        userId: owner._id,
        type: 'purchase',
        amount: -cost,
        description: `Bot hosting: ${bot.name} for ${bot.hostingDays} days`,
        botId: bot._id
      });
    }

    // Set expiration
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + bot.hostingDays);

    bot.status = 'approved';
    bot.coinsSpent = cost;
    bot.expiresAt = expiresAt;
    bot.approvedAt = new Date();
    bot.approvedBy = req.user._id;
    await bot.save();

    res.json({ message: 'Bot approved successfully', bot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reject bot
app.post('/api/admin/bots/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    bot.status = 'rejected';
    bot.rejectionReason = reason || 'Not specified';
    await bot.save();

    res.json({ message: 'Bot rejected', bot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start bot (host it)
app.post('/api/admin/bots/:id/start', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.status !== 'approved') {
      return res.status(400).json({ error: 'Bot must be approved first' });
    }

    // Find available server
    const targetServer = await Server.findById(bot.serverId) || await Server.findOne({ status: 'online' });
    if (!targetServer) {
      return res.status(400).json({ error: 'No available server' });
    }

    // Get bot files ready
    let botPath = bot.filePath;
    if (bot.sourceType === 'github' || bot.sourceType === 'url') {
      // Clone from URL
      const cloneDir = path.join(BOTS_DIR, bot._id.toString());
      if (!fs.existsSync(cloneDir)) {
        fs.mkdirSync(cloneDir, { recursive: true });
        execSync(`git clone ${bot.sourceUrl} .`, { cwd: cloneDir, stdio: 'inherit' });
      }
      botPath = cloneDir;
    }

    // Install dependencies if package.json exists
    const packageJsonPath = path.join(botPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      log('INFO', `Installing dependencies for ${bot.name}...`);
      execSync('npm install', { cwd: botPath, stdio: 'inherit' });
    }

    // Start the bot
    const entryPoint = fs.existsSync(path.join(botPath, 'index.js')) ? 'index.js' : 
                       fs.existsSync(path.join(botPath, 'main.js')) ? 'main.js' :
                       fs.existsSync(path.join(botPath, 'app.js')) ? 'app.js' : null;

    if (!entryPoint) {
      return res.status(400).json({ error: 'No entry point found (index.js, main.js, or app.js)' });
    }

    const botProcess = spawn('node', [entryPoint], {
      cwd: botPath,
      env: { ...process.env, BOT_NAME: bot.name, SESSION_NAME: bot.sessionName || 'session' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    bot.pid = botProcess.pid;
    bot.status = 'running';
    bot.port = targetServer.port;
    await bot.save();

    targetServer.activeBots += 1;
    await targetServer.save();

    // Handle bot output
    botProcess.stdout.on('data', (data) => {
      log('INFO', `[${bot.name}] ${data.toString()}`);
    });

    botProcess.stderr.on('data', (data) => {
      log('ERR', `[${bot.name}] ${data.toString()}`);
    });

    botProcess.on('close', async () => {
      bot.status = 'stopped';
      bot.pid = null;
      await bot.save();
      
      targetServer.activeBots -= 1;
      await targetServer.save();
      
      log('WARN', `Bot ${bot.name} stopped`);
    });

    res.json({ message: `Bot "${bot.name}" started successfully`, bot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop bot
app.post('/api/admin/bots/:id/stop', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.pid) {
      try {
        process.kill(bot.pid, 'SIGTERM');
      } catch (e) {}
    }

    bot.status = 'stopped';
    bot.pid = null;
    await bot.save();

    res.json({ message: 'Bot stopped successfully', bot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Servers
// ═══════════════════════════════════════════════════════════════════════════════

// Get all servers
app.get('/api/servers', async (req, res) => {
  try {
    const servers = await Server.find();
    res.json(servers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create server (admin only)
app.post('/api/admin/servers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, region, host, maxBots, specs } = req.body;
    const server = await Server.create({ name, region, host, maxBots, specs });
    res.json({ message: 'Server created successfully', server });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update server (admin only)
app.put('/api/admin/servers/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const server = await Server.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ message: 'Server updated successfully', server });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete server (admin only)
app.delete('/api/admin/servers/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Server.findByIdAndDelete(req.params.id);
    res.json({ message: 'Server deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Services
// ═══════════════════════════════════════════════════════════════════════════════

// Get all services
app.get('/api/services', async (req, res) => {
  try {
    const services = await Service.find({ active: true });
    res.json(services);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create service (admin only)
app.post('/api/admin/services', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const service = await Service.create(req.body);
    res.json({ message: 'Service created successfully', service });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update service (admin only)
app.put('/api/admin/services/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const service = await Service.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ message: 'Service updated successfully', service });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete service (admin only)
app.delete('/api/admin/services/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Service.findByIdAndDelete(req.params.id);
    res.json({ message: 'Service deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Admin User Management
// ═══════════════════════════════════════════════════════════════════════════════

// Get all users
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adjust user coins
app.post('/api/admin/users/:id/coins', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.coins += amount;
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: amount > 0 ? 'admin_add' : 'admin_deduct',
      amount,
      description: reason || 'Admin adjustment'
    });

    res.json({ message: 'Coins adjusted successfully', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user
app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).select('-password');
    res.json({ message: 'User updated successfully', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete user
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Transactions
// ═══════════════════════════════════════════════════════════════════════════════

// Get user transactions
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all transactions (admin)
app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const transactions = await Transaction.find().populate('userId', 'username email').sort({ createdAt: -1 });
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes - Dashboard Stats
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const userBots = await Bot.find({ ownerId: req.user._id });
    const stats = {
      totalBots: userBots.length,
      runningBots: userBots.filter(b => b.status === 'running').length,
      pendingBots: userBots.filter(b => b.status === 'pending').length,
      coins: req.user.coins,
      isAdmin: req.user.isAdmin
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const stats = {
      totalUsers: await User.countDocuments(),
      totalBots: await Bot.countDocuments(),
      runningBots: await Bot.countDocuments({ status: 'running' }),
      pendingBots: await Bot.countDocuments({ status: 'pending' }),
      totalServers: await Server.countDocuments(),
      onlineServers: await Server.countDocuments({ status: 'online' }),
      totalCoins: (await User.aggregate([{ $group: { _id: null, total: { $sum: '$coins' } } }]))[0]?.total || 0
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WebSocket Server
// ═══════════════════════════════════════════════════════════════════════════════

wss.on('connection', (ws) => {
  log('INFO', 'WebSocket client connected');
  ws.on('close', () => log('INFO', 'WebSocket client disconnected'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scheduled Tasks
// ═══════════════════════════════════════════════════════════════════════════════

// Self-ping keep-alive
if (RENDER_URL) {
  cron.schedule(`*/${PING_INTERVAL} * * * *`, async () => {
    try {
      await fetch(RENDER_URL);
      log('INFO', 'Keep-alive ping sent');
    } catch (error) {
      log('ERR', 'Keep-alive ping failed: ' + error.message);
    }
  });
} else {
  log('WARN', 'RENDER_URL not set — skipping keep-alive ping');
}

// Cleanup expired bots
cron.schedule('0 * * * *', async () => {
  try {
    const expiredBots = await Bot.find({ status: 'running', expiresAt: { $lt: new Date() } });
    for (const bot of expiredBots) {
      if (bot.pid) {
        try {
          process.kill(bot.pid, 'SIGTERM');
        } catch (e) {}
      }
      bot.status = 'expired';
      bot.pid = null;
      await bot.save();
      log('INFO', `Bot ${bot.name} expired and stopped`);
    }
  } catch (error) {
    log('ERR', 'Bot cleanup error: ' + error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════════════════════

server.listen(PORT, async () => {
  await initializeData();
  
  console.log('\x1b[32m[  OK ]\x1b[0m ╔══════════════════════════════════════════════╗');
  console.log('\x1b[32m[  OK ]\x1b[0m ║  LadybugNodes Host \u2022  Port ' + PORT + '           ║');
  console.log('\x1b[32m[  OK ]\x1b[0m ║  Dashboard → http://localhost:' + PORT + '          ║');
  console.log('\x1b[32m[  OK ]\x1b[0m ╚══════════════════════════════════════════════╝');
  log('INFO', 'Developer: Dev-Ntando');
  log('INFO', 'Version: 4.0.0 with MongoDB');
});

module.exports = app;
