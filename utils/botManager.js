'use strict';

/**
 * Advanced Bot Management System for LADYBUGNODES V5.2
 * Supports categories, templates, cloning, bulk operations, and health monitoring
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('events');
const { BotLogger, BotLoggerManager } = require('./botLogger');
const { SessionAuthAdapter, SessionType } = require('./sessionAuth');

// Bot status
const BotStatus = {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    ERROR: 'error',
    RESTARTING: 'restarting',
    CRASHED: 'crashed',
    QUEUED: 'queued'
};

// Bot types
const BotType = {
    WHATSAPP_BAILEYS: 'whatsapp-baileys',
    WHATSAPP_MD: 'whatsapp-md',
    WHATSAPP_LEGACY: 'whatsapp-legacy',
    TELEGRAM: 'telegram',
    DISCORD: 'discord',
    SLACK: 'slack',
    CUSTOM: 'custom'
};

/**
 * Bot Instance - Represents a single bot
 */
class BotInstance extends EventEmitter {
    constructor(config, manager) {
        super();
        this.id = config.id || uuidv4();
        this.name = config.name || `Bot-${this.id.substring(0, 8)}`;
        this.type = config.type || BotType.WHATSAPP_BAILEYS;
        this.status = BotStatus.STOPPED;
        this.config = config;
        this.manager = manager;
        
        // Paths
        this.botDir = config.botDir || path.join(manager.botsDir, this.id);
        this.sessionDir = path.join(this.botDir, 'session');
        this.logDir = path.join(this.botDir, 'logs');
        
        // Logging
        this.logger = manager.loggerManager.getLogger(this.id);
        
        // Session auth
        this.sessionAuth = new SessionAuthAdapter(this.sessionDir);
        
        // Process
        this.process = null;
        this.startTime = null;
        this.restartCount = 0;
        this.maxRestarts = config.maxRestarts || 5;
        this.autoRestart = config.autoRestart !== false;
        this.restartDelay = config.restartDelay || 5000;
        
        // Metrics
        this.metrics = {
            messagesSent: 0,
            messagesReceived: 0,
            commandsExecuted: 0,
            errors: 0,
            uptime: 0,
            lastActivity: null,
            memoryUsage: 0,
            cpuUsage: 0
        };
        
        // Health
        this.healthStatus = 'unknown';
        this.lastHealthCheck = null;
        this.healthCheckInterval = null;
    }

    /**
     * Initialize bot
     */
    async init() {
        // Ensure directories exist
        if (!fs.existsSync(this.botDir)) {
            fs.mkdirSync(this.botDir, { recursive: true });
        }
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        // Initialize session auth
        await this.sessionAuth.init();
        
        // Save config
        this.saveConfig();
        
        this.logger.system(`Bot initialized: ${this.name}`, { 
            id: this.id, 
            type: this.type,
            sessionType: this.sessionAuth.type 
        });
        
        return this;
    }

    /**
     * Save bot configuration
     */
    saveConfig() {
        const configPath = path.join(this.botDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({
            id: this.id,
            name: this.name,
            type: this.type,
            config: this.config,
            autoRestart: this.autoRestart,
            maxRestarts: this.maxRestarts,
            restartDelay: this.restartDelay,
            createdAt: this.config.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }, null, 2));
    }

    /**
     * Start the bot
     */
    async start() {
        if (this.status === BotStatus.RUNNING || this.status === BotStatus.STARTING) {
            this.logger.warn('Bot is already running or starting');
            return false;
        }

        this.status = BotStatus.STARTING;
        this.emit('status', this.status);
        this.logger.system('Starting bot...');

        try {
            // Check session
            const sessionInfo = this.sessionAuth.getInfo();
            this.logger.info('Session info', sessionInfo);

            // Find entry point
            const entryPoint = this._findEntryPoint();
            if (!entryPoint) {
                throw new Error('No entry point found');
            }

            // Start process
            this.process = this._spawnProcess(entryPoint);
            this.startTime = Date.now();
            this.status = BotStatus.RUNNING;
            
            this.emit('status', this.status);
            this.logger.success('Bot started successfully');

            // Start health monitoring
            this._startHealthCheck();
            
            return true;
        } catch (error) {
            this.status = BotStatus.ERROR;
            this.emit('status', this.status);
            this.logger.error(`Failed to start bot: ${error.message}`, { error: error.stack });
            return false;
        }
    }

    /**
     * Stop the bot
     */
    async stop() {
        if (this.status !== BotStatus.RUNNING) {
            return false;
        }

        this.status = BotStatus.STOPPING;
        this.emit('status', this.status);
        this.logger.system('Stopping bot...');

        // Stop health check
        this._stopHealthCheck();

        // Kill process
        if (this.process) {
            this.process.kill('SIGTERM');
            
            // Force kill after 10 seconds
            setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGKILL');
                }
            }, 10000);
        }

        this.metrics.uptime += Date.now() - this.startTime;
        this.status = BotStatus.STOPPED;
        this.emit('status', this.status);
        this.logger.success('Bot stopped');

        return true;
    }

    /**
     * Restart the bot
     */
    async restart() {
        this.logger.system('Restarting bot...');
        this.status = BotStatus.RESTARTING;
        this.emit('status', this.status);
        
        await this.stop();
        await new Promise(resolve => setTimeout(resolve, this.restartDelay));
        return this.start();
    }

    /**
     * Find entry point file
     */
    _findEntryPoint() {
        const entryFiles = ['index.js', 'main.js', 'bot.js', 'app.js', 'start.js'];
        
        // Check config entry point first
        if (this.config.entryPoint) {
            const entryPath = path.join(this.botDir, this.config.entryPoint);
            if (fs.existsSync(entryPath)) {
                return entryPath;
            }
        }
        
        // Check common entry points
        for (const file of entryFiles) {
            const filePath = path.join(this.botDir, file);
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }
        
        return null;
    }

    /**
     * Spawn bot process
     */
    _spawnProcess(entryPoint) {
        const { spawn } = require('child_process');
        
        const env = {
            ...process.env,
            ...this.config.env || {},
            BOT_ID: this.id,
            BOT_NAME: this.name,
            SESSION_DIR: this.sessionDir
        };

        const proc = spawn('node', [entryPoint], {
            cwd: this.botDir,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Handle stdout
        proc.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                this.logger.bot(output);
                this.emit('output', output);
            }
        });

        // Handle stderr
        proc.stderr.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                this.logger.error(output);
                this.emit('error', output);
            }
        });

        // Handle close
        proc.on('close', (code, signal) => {
            this.logger.system(`Process exited with code ${code}, signal ${signal}`);
            
            if (this.status === BotStatus.RUNNING) {
                this.metrics.uptime += Date.now() - this.startTime;
                
                if (code !== 0 && this.autoRestart && this.restartCount < this.maxRestarts) {
                    this.restartCount++;
                    this.logger.warn(`Auto-restarting (${this.restartCount}/${this.maxRestarts})...`);
                    setTimeout(() => this.start(), this.restartDelay);
                } else {
                    this.status = code === 0 ? BotStatus.STOPPED : BotStatus.CRASHED;
                    this.emit('status', this.status);
                }
            }
        });

        // Handle error
        proc.on('error', (error) => {
            this.logger.error(`Process error: ${error.message}`);
            this.metrics.errors++;
        });

        return proc;
    }

    /**
     * Start health monitoring
     */
    _startHealthCheck() {
        this.healthCheckInterval = setInterval(() => {
            this.checkHealth();
        }, 30000); // Every 30 seconds
    }

    /**
     * Stop health monitoring
     */
    _stopHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    /**
     * Check bot health
     */
    checkHealth() {
        const health = {
            status: 'healthy',
            timestamp: Date.now(),
            checks: {}
        };

        // Check if process is running
        health.checks.process = this.process && !this.process.killed;
        if (!health.checks.process) {
            health.status = 'unhealthy';
        }

        // Check memory usage
        if (this.process && this.process.pid) {
            try {
                const usage = process.memoryUsage();
                this.metrics.memoryUsage = usage.heapUsed;
                health.checks.memory = usage.heapUsed < 500 * 1024 * 1024; // Under 500MB
                if (!health.checks.memory) {
                    health.status = 'warning';
                }
            } catch (e) {
                health.checks.memory = false;
            }
        }

        // Check session validity
        health.checks.session = this.sessionAuth.isValid();

        // Check recent activity
        if (this.metrics.lastActivity) {
            const inactiveMs = Date.now() - this.metrics.lastActivity;
            health.checks.recentActivity = inactiveMs < 3600000; // Active in last hour
        }

        this.healthStatus = health.status;
        this.lastHealthCheck = health;
        this.emit('health', health);

        return health;
    }

    /**
     * Import session
     */
    async importSession(source, type) {
        await this.sessionAuth.importSession(source, type);
        this.logger.info('Session imported', { type: this.sessionAuth.type });
    }

    /**
     * Export session
     */
    async exportSession(format) {
        return this.sessionAuth.exportSession(format);
    }

    /**
     * Get session info
     */
    async getSessionInfo() {
        const type = this.sessionAuth.type || await this.sessionAuth.init();
        return {
            botId: this.id,
            type: type,
            valid: this.sessionAuth.isValid(),
            path: this.sessionDir,
            lastChecked: new Date().toISOString()
        };
    }

    /**
     * Get bot info
     */
    getInfo() {
        return {
            id: this.id,
            name: this.name,
            type: this.type,
            status: this.status,
            autoRestart: this.autoRestart,
            restartCount: this.restartCount,
            sessionType: this.sessionAuth.type,
            sessionValid: this.sessionAuth.isValid(),
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            totalUptime: this.metrics.uptime + (this.startTime ? Date.now() - this.startTime : 0),
            health: this.lastHealthCheck,
            metrics: this.metrics,
            config: this.config
        };
    }

    /**
     * Get logs
     */
    getLogs(options) {
        return this.logger.getLogs(options);
    }

    /**
     * Update configuration
     */
    updateConfig(updates) {
        this.config = { ...this.config, ...updates };
        
        if (updates.name) this.name = updates.name;
        if (updates.type) this.type = updates.type;
        if (updates.autoRestart !== undefined) this.autoRestart = updates.autoRestart;
        if (updates.maxRestarts !== undefined) this.maxRestarts = updates.maxRestarts;
        
        this.saveConfig();
        this.emit('config', this.config);
    }
}

/**
 * Bot Manager - Manages all bots
 */
class BotManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.botsDir = options.botsDir || './data/bots';
        this.bots = new Map();
        this.categories = new Map();
        this.templates = new Map();
        this.loggerManager = new BotLoggerManager({ logDir: path.join(this.botsDir, '../logs') });
        
        this._ensureDirectories();
        this._loadDefaultTemplates();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.botsDir)) {
            fs.mkdirSync(this.botsDir, { recursive: true });
        }
    }

    /**
     * Load default bot templates
     */
    _loadDefaultTemplates() {
        // Baileys WhatsApp Bot Template
        this.templates.set('whatsapp-baileys', {
            id: 'whatsapp-baileys',
            name: 'WhatsApp Bot (Baileys)',
            type: BotType.WHATSAPP_BAILEYS,
            description: 'A WhatsApp bot using Baileys library',
            files: {
                'index.js': `// WhatsApp Bot - Baileys
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Connection opened');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            console.log('New message:', msg.message?.conversation);
            // Handle message here
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();`,
                'package.json': JSON.stringify({
                    name: 'whatsapp-bot',
                    version: '1.0.0',
                    main: 'index.js',
                    dependencies: {
                        '@whiskeysockets/baileys': 'latest',
                        'pino': '^8.0.0'
                    }
                }, null, 2)
            },
            dependencies: ['@whiskeysockets/baileys', 'pino']
        });

        // WhatsApp MD Bot Template
        this.templates.set('whatsapp-md', {
            id: 'whatsapp-md',
            name: 'WhatsApp Bot (MD)',
            type: BotType.WHATSAPP_MD,
            description: 'WhatsApp bot with MD authentication',
            files: {
                'index.js': `// WhatsApp MD Bot
const { WASocket, makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const sock = makeWASocket({ auth: state });
    sock.ev.on('creds.update', saveCreds);
    // Your bot logic here
}
start();`,
                'package.json': JSON.stringify({
                    name: 'whatsapp-md-bot',
                    version: '1.0.0',
                    main: 'index.js',
                    dependencies: {
                        '@whiskeysockets/baileys': 'latest'
                    }
                }, null, 2)
            }
        });

        // Pairing Code Bot Template
        this.templates.set('pairing-code', {
            id: 'pairing-code',
            name: 'WhatsApp Bot (Pairing Code)',
            type: BotType.WHATSAPP_BAILEYS,
            description: 'WhatsApp bot with pairing code authentication',
            files: {
                'index.js': `// WhatsApp Bot with Pairing Code
const { makeWASocket, useMultiFileAuthState, Delay } = require('@whiskeysockets/baileys');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['LADYBUGNODES', 'Chrome', '1.0.0']
    });

    // Request pairing code if not authenticated
    if (!state.creds.registered) {
        const phoneNumber = process.env.PHONE_NUMBER; // Set via env
        if (phoneNumber) {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log('Pairing code:', code);
        }
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        console.log('Connection:', update.connection);
    });
}

startBot();`,
                'package.json': JSON.stringify({
                    name: 'pairing-code-bot',
                    version: '1.0.0',
                    main: 'index.js',
                    dependencies: {
                        '@whiskeysockets/baileys': 'latest'
                    }
                }, null, 2)
            }
        });

        // Custom Bot Template
        this.templates.set('custom', {
            id: 'custom',
            name: 'Custom Bot',
            type: BotType.CUSTOM,
            description: 'Empty template for custom bots',
            files: {
                'index.js': `// Custom Bot
console.log('Hello from custom bot!');
// Your custom bot logic here`,
                'package.json': JSON.stringify({
                    name: 'custom-bot',
                    version: '1.0.0',
                    main: 'index.js',
                    dependencies: {}
                }, null, 2)
            }
        });

        // Telegram Bot Template
        this.templates.set('telegram', {
            id: 'telegram',
            name: 'Telegram Bot',
            type: BotType.TELEGRAM,
            description: 'A Telegram bot using node-telegram-bot-api',
            files: {
                'index.js': `// Telegram Bot - LADYBUGNODES V(7)
const TelegramBot = require('node-telegram-bot-api');

// Get token from environment
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN not set in environment');
    process.exit(1);
}

// Create bot
const bot = new TelegramBot(token, { polling: true });

console.log('Telegram Bot started!');

// Handle /start command
bot.onText(/\\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Welcome to LADYBUGNODES Bot! 🐝\\n\\nUse /help to see available commands.');
});

// Handle /help command
bot.onText(/\\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Available commands:\\n/start - Start the bot\\n/help - Show this help\\n/echo <text> - Echo back your text');
});

// Handle /echo command
bot.onText(/\\/echo (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const resp = match[1];
    bot.sendMessage(chatId, resp);
});

// Handle any message
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Log received messages
    console.log(\`Received: "\${text}" from \${chatId}\`);
});

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
});

console.log('Bot is running...');
`,
                'package.json': JSON.stringify({
                    name: 'telegram-bot',
                    version: '1.0.0',
                    main: 'index.js',
                    scripts: { start: 'node index.js' },
                    dependencies: {
                        'node-telegram-bot-api': '^0.64.0'
                    }
                }, null, 2)
            },
            dependencies: ['node-telegram-bot-api']
        });

        // Discord Bot Template
        this.templates.set('discord', {
            id: 'discord',
            name: 'Discord Bot',
            type: BotType.DISCORD,
            description: 'A Discord bot using discord.js',
            files: {
                'index.js': `// Discord Bot - LADYBUGNODES V(7)
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

// Get token from environment
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token) {
    console.error('ERROR: DISCORD_BOT_TOKEN not set in environment');
    process.exit(1);
}

// Create client with intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Commands
const commands = [
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check if bot is responsive'),
    new SlashCommandBuilder()
        .setName('hello')
        .setDescription('Say hello!')
];

// Register commands
if (clientId) {
    const rest = new REST({ version: '10' }).setToken(token);
    (async () => {
        try {
            console.log('Registering slash commands...');
            await rest.put(Routes.applicationCommands(clientId), { body: commands });
            console.log('Slash commands registered!');
        } catch (error) {
            console.error('Error registering commands:', error.message);
        }
    })();
}

// Ready event
client.once('ready', () => {
    console.log(\`Discord Bot logged in as \${client.user.tag}\`);
});

// Interaction handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'ping') {
        await interaction.reply('Pong! 🐝');
    } else if (commandName === 'hello') {
        await interaction.reply('Hello from LADYBUGNODES! 👋');
    }
});

// Message handler
client.on('messageCreate', message => {
    if (message.author.bot) return;
    
    // Log messages
    console.log(\`Message in \${message.guild?.name || 'DM'}: \${message.content}\`);
    
    // Simple responses
    if (message.content.toLowerCase() === 'hello') {
        message.reply('Hi there! 🐝');
    }
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error.message);
});

// Login
client.login(token);
`,
                'package.json': JSON.stringify({
                    name: 'discord-bot',
                    version: '1.0.0',
                    main: 'index.js',
                    scripts: { start: 'node index.js' },
                    dependencies: {
                        'discord.js': '^14.14.0'
                    }
                }, null, 2)
            },
            dependencies: ['discord.js']
        });

        // Slack Bot Template
        this.templates.set('slack', {
            id: 'slack',
            name: 'Slack Bot',
            type: BotType.SLACK,
            description: 'A Slack bot using Bolt SDK',
            files: {
                'index.js': `// Slack Bot - LADYBUGNODES V(7)
const { App } = require('@slack/bolt');

// Get credentials from environment
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});

// Listen to messages
app.message('hello', async ({ message, say }) => {
    await say(\`Hey there <@\${message.user}>! 🐝\`);
});

// Slash command
app.command('/ladybug', async ({ command, ack, respond }) => {
    await ack();
    await respond(\`Hello from LADYBUGNODES! Your command: \${command.text}\`);
});

// Start app
(async () => {
    await app.start();
    console.log('Slack Bot is running! ⚡️');
})();
`,
                'package.json': JSON.stringify({
                    name: 'slack-bot',
                    version: '1.0.0',
                    main: 'index.js',
                    scripts: { start: 'node index.js' },
                    dependencies: {
                        '@slack/bolt': '^3.17.0'
                    }
                }, null, 2)
            },
            dependencies: ['@slack/bolt']
        });
    }

    /**
     * Create a new bot
     */
    async createBot(options) {
        const bot = new BotInstance(options, this);
        await bot.init();
        this.bots.set(bot.id, bot);

        // Forward events
        bot.on('status', (status) => this.emit('bot-status', { botId: bot.id, status }));
        bot.on('health', (health) => this.emit('bot-health', { botId: bot.id, health }));
        bot.on('output', (output) => this.emit('bot-output', { botId: bot.id, output }));

        this.emit('bot-created', bot);
        return bot;
    }

    /**
     * Create bot from template
     */
    async createFromTemplate(templateId, options = {}) {
        const template = this.templates.get(templateId);
        if (!template) {
            throw new Error(`Template not found: ${templateId}`);
        }

        const bot = await this.createBot({
            ...options,
            type: template.type,
            templateId
        });

        // Create template files
        for (const [filename, content] of Object.entries(template.files)) {
            const filePath = path.join(bot.botDir, filename);
            fs.writeFileSync(filePath, content);
        }

        // Install dependencies
        if (template.dependencies && template.dependencies.length > 0) {
            const { execSync } = require('child_process');
            try {
                execSync(`npm install ${template.dependencies.join(' ')}`, {
                    cwd: bot.botDir,
                    stdio: 'pipe'
                });
            } catch (e) {
                // Ignore install errors
            }
        }

        return bot;
    }

    /**
     * Get bot by ID
     */
    getBot(botId) {
        return this.bots.get(botId);
    }

    /**
     * Get all bots
     */
    getAllBots() {
        return Array.from(this.bots.values());
    }

    /**
     * Delete a bot
     */
    async deleteBot(botId) {
        const bot = this.bots.get(botId);
        if (!bot) return false;

        await bot.stop();
        
        // Delete files
        if (fs.existsSync(bot.botDir)) {
            fs.rmSync(bot.botDir, { recursive: true, force: true });
        }

        this.bots.delete(botId);
        this.loggerManager.removeLogger(botId);
        this.emit('bot-deleted', botId);

        return true;
    }

    /**
     * Clone a bot
     */
    async cloneBot(botId, options = {}) {
        const original = this.bots.get(botId);
        if (!original) {
            throw new Error(`Bot not found: ${botId}`);
        }

        const clone = await this.createBot({
            ...options,
            name: options.name || `${original.name} (Clone)`,
            type: original.type,
            config: { ...original.config, clonedFrom: botId }
        });

        // Copy files (except session)
        const files = fs.readdirSync(original.botDir);
        for (const file of files) {
            if (file !== 'session' && file !== 'logs') {
                const srcPath = path.join(original.botDir, file);
                const destPath = path.join(clone.botDir, file);
                
                if (fs.statSync(srcPath).isDirectory()) {
                    fs.cpSync(srcPath, destPath, { recursive: true });
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        }

        return clone;
    }

    /**
     * Start all bots
     */
    async startAll() {
        const results = [];
        for (const bot of this.bots.values()) {
            results.push({
                botId: bot.id,
                success: await bot.start()
            });
        }
        return results;
    }

    /**
     * Stop all bots
     */
    async stopAll() {
        const results = [];
        for (const bot of this.bots.values()) {
            results.push({
                botId: bot.id,
                success: await bot.stop()
            });
        }
        return results;
    }

    /**
     * Get all templates
     */
    getTemplates() {
        return Array.from(this.templates.values());
    }

    /**
     * Add custom template
     */
    addTemplate(template) {
        this.templates.set(template.id, template);
    }

    /**
     * Save bot configuration
     */
    async saveBotConfig(botId, config) {
        const bot = this.bots.get(botId);
        if (!bot) return false;
        
        bot.config = { ...bot.config, ...config };
        
        // Save to disk
        const configPath = path.join(bot.botDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(bot.config, null, 2));
        
        this.emit('bot-updated', { botId, config: bot.config });
        return true;
    }

    /**
     * Get categories
     */
    getCategories() {
        return Array.from(this.categories.values());
    }

    /**
     * Create category
     */
    createCategory(options) {
        const categoryId = uuidv4();
        const category = {
            id: categoryId,
            name: options.name,
            icon: options.icon || 'folder',
            color: options.color || '#6366f1',
            bots: [],
            createdAt: new Date().toISOString()
        };
        this.categories.set(categoryId, category);
        
        // Save categories
        this._saveCategories();
        
        return category;
    }

    /**
     * Save categories to disk
     */
    _saveCategories() {
        const categoriesPath = path.join(this.botsDir, '..', 'categories.json');
        const data = Array.from(this.categories.values());
        fs.writeFileSync(categoriesPath, JSON.stringify(data, null, 2));
    }

    /**
     * Load categories from disk
     */
    _loadCategories() {
        const categoriesPath = path.join(this.botsDir, '..', 'categories.json');
        if (fs.existsSync(categoriesPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
                for (const cat of data) {
                    this.categories.set(cat.id, cat);
                }
            } catch (e) {
                console.error('Failed to load categories:', e.message);
            }
        }
    }

    /**
     * Bulk operation on multiple bots
     */
    async bulkOperation(botIds, operation) {
        const results = [];
        
        for (const botId of botIds) {
            const bot = this.bots.get(botId);
            if (!bot) {
                results.push({ botId, success: false, error: 'Bot not found' });
                continue;
            }

            try {
                switch (operation) {
                    case 'start':
                        await bot.start();
                        results.push({ botId, success: true, status: bot.status });
                        break;
                    case 'stop':
                        await bot.stop();
                        results.push({ botId, success: true, status: bot.status });
                        break;
                    case 'restart':
                        await bot.restart();
                        results.push({ botId, success: true, status: bot.status });
                        break;
                    case 'delete':
                        await this.deleteBot(botId);
                        results.push({ botId, success: true, deleted: true });
                        break;
                    default:
                        results.push({ botId, success: false, error: 'Unknown operation' });
                }
            } catch (error) {
                results.push({ botId, success: false, error: error.message });
            }
        }

        return results;
    }

    /**
     * Add bot to category
     */
    addToCategory(categoryId, botId) {
        const category = this.categories.get(categoryId);
        if (category && !category.bots.includes(botId)) {
            category.bots.push(botId);
        }
    }

    /**
     * Get bots by category
     */
    getBotsByCategory(categoryId) {
        const category = this.categories.get(categoryId);
        if (!category) return [];
        return category.bots.map(id => this.bots.get(id)).filter(Boolean);
    }

    /**
     * Load all bots from disk
     */
    async loadBots() {
        if (!fs.existsSync(this.botsDir)) return;

        const dirs = fs.readdirSync(this.botsDir);
        for (const botId of dirs) {
            const configPath = path.join(this.botsDir, botId, 'config.json');
            if (fs.existsSync(configPath)) {
                try {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    await this.createBot(config);
                } catch (e) {
                    console.error(`Failed to load bot ${botId}:`, e.message);
                }
            }
        }
    }

    /**
     * Get system stats
     */
    getStats() {
        const stats = {
            totalBots: this.bots.size,
            runningBots: 0,
            stoppedBots: 0,
            errorBots: 0,
            categories: this.categories.size,
            templates: this.templates.size,
            bots: {}
        };

        for (const [id, bot] of this.bots) {
            stats.bots[id] = bot.getInfo();
            
            switch (bot.status) {
                case BotStatus.RUNNING:
                    stats.runningBots++;
                    break;
                case BotStatus.ERROR:
                case BotStatus.CRASHED:
                    stats.errorBots++;
                    break;
                default:
                    stats.stoppedBots++;
            }
        }

        return stats;
    }
}

// Bot Templates (static definitions for export)
const BotTemplates = {
    WHATSAPP_BAILEYS: {
        id: 'whatsapp-baileys',
        name: 'WhatsApp Bot (Baileys)',
        type: BotType.WHATSAPP_BAILEYS,
        description: 'A WhatsApp bot using Baileys library with QR code authentication',
        sessionType: 'auth_state',
        features: ['qr-code', 'multi-device', 'message-handling']
    },
    WHATSAPP_MD: {
        id: 'whatsapp-md',
        name: 'WhatsApp Bot (MD)',
        type: BotType.WHATSAPP_MD,
        description: 'WhatsApp bot with MD authentication',
        sessionType: 'auth_state',
        features: ['multi-device', 'message-handling']
    },
    PAIRING_CODE: {
        id: 'pairing-code',
        name: 'WhatsApp Bot (Pairing Code)',
        type: BotType.WHATSAPP_BAILEYS,
        description: 'WhatsApp bot with pairing code authentication',
        sessionType: 'session_id',
        features: ['pairing-code', 'multi-device']
    },
    TELEGRAM: {
        id: 'telegram',
        name: 'Telegram Bot',
        type: BotType.TELEGRAM,
        description: 'A Telegram bot using node-telegram-bot-api',
        sessionType: 'token',
        features: ['polling', 'webhooks', 'commands']
    },
    DISCORD: {
        id: 'discord',
        name: 'Discord Bot',
        type: BotType.DISCORD,
        description: 'A Discord bot using discord.js',
        sessionType: 'token',
        features: ['slash-commands', 'message-handling', 'voice']
    },
    SLACK: {
        id: 'slack',
        name: 'Slack Bot',
        type: BotType.SLACK,
        description: 'A Slack bot using Bolt SDK',
        sessionType: 'token',
        features: ['slash-commands', 'events', 'modals']
    },
    CUSTOM: {
        id: 'custom',
        name: 'Custom Bot',
        type: BotType.CUSTOM,
        description: 'Empty template for custom bots',
        sessionType: 'any',
        features: ['custom']
    }
};

module.exports = {
    BotStatus,
    BotType,
    BotInstance,
    BotManager,
    BotTemplates
};