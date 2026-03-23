'use strict';

/**
 * Bot Manager Routes for LADYBUGNODES V5.2
 * Advanced bot management with multi-auth sessions, per-bot logging, and templates
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');

// Import our utilities
const { BotManager, BotInstance, BotStatus, BotType, BotTemplates } = require('../utils/botManager');
const { SessionAuthAdapter, SessionType, detectSessionType, SessionManager } = require('../utils/sessionAuth');
const { BotLogger, BotLoggerManager } = require('../utils/botLogger');

// Configure multer for session uploads
const sessionUpload = multer({
    dest: path.join(__dirname, '../data/temp-sessions'),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Initialize managers
let botManager = null;
let sessionManager = null;
let loggerManager = null;

/**
 * Initialize the bot manager routes
 */
function initBotManagerRoutes(app, config = {}) {
    const {
        dataDir = path.join(__dirname, '../data'),
        botsDir = path.join(dataDir, 'uploaded-bots'),
        sessionsDir = path.join(dataDir, 'sessions'),
        logDir = path.join(dataDir, 'logs')
    } = config;

    // Ensure directories exist
    [botsDir, sessionsDir, logDir].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    // Initialize logger manager
    loggerManager = new BotLoggerManager(logDir);

    // Initialize session manager
    sessionManager = new SessionManager(sessionsDir);

    // Initialize bot manager
    botManager = new BotManager({
        botsDir,
        sessionsDir,
        loggerManager,
        sessionManager
    });

    // Mount routes
    app.use('/api/v2/bots', router);

    console.log('[BotManager] Routes initialized');
    
    return { botManager, sessionManager, loggerManager };
}

// ============================================
// SESSION MANAGEMENT ROUTES
// ============================================

/**
 * Get supported session types
 */
router.get('/session-types', (req, res) => {
    res.json({
        types: Object.values(SessionType),
        descriptions: {
            [SessionType.CREDS_JSON]: 'Baileys credentials JSON file',
            [SessionType.SESSION_ID]: 'String session / Pairing code session',
            [SessionType.AUTH_STATE]: 'Multi-file auth state folder',
            [SessionType.QR_CODE]: 'QR code authentication'
        }
    });
});

/**
 * Detect session type from uploaded files
 */
router.post('/detect-session', sessionUpload.single('session'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const tempDir = path.dirname(req.file.path);
        const sessionType = detectSessionType(tempDir);
        
        // Cleanup temp file
        fs.unlinkSync(req.file.path);

        res.json({
            detected: sessionType !== null,
            type: sessionType,
            supported: sessionType !== null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Import session for a bot
 */
router.post('/:botId/session/import', sessionUpload.single('session'), async (req, res) => {
    try {
        const { botId } = req.params;
        const { type } = req.body;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No session file uploaded' });
        }

        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        // Import the session
        const sessionFile = req.file.path;
        let importResult;

        if (type === SessionType.SESSION_ID) {
            // Read session ID from file
            const sessionId = fs.readFileSync(sessionFile, 'utf8').trim();
            importResult = await bot.importSession(sessionId, SessionType.SESSION_ID);
        } else {
            // Import as file/folder
            importResult = await bot.importSession(sessionFile, type || 'auto');
        }

        // Cleanup temp file
        try { fs.unlinkSync(sessionFile); } catch (e) {}

        res.json({
            success: true,
            type: importResult.type,
            message: 'Session imported successfully'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Export session from a bot
 */
router.get('/:botId/session/export', async (req, res) => {
    try {
        const { botId } = req.params;
        const { format = 'creds.json' } = req.query;

        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const exportData = await bot.exportSession(format);

        if (format === 'creds.json' || format === 'session_id') {
            // Send as file
            const filename = format === 'creds.json' ? 'creds.json' : 'session_id.txt';
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'text/plain');
            res.send(exportData);
        } else {
            // Send as JSON
            res.json(exportData);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get session info for a bot
 */
router.get('/:botId/session', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const sessionInfo = await bot.getSessionInfo();
        res.json(sessionInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// BOT LOGGING ROUTES
// ============================================

/**
 * Get logs for a specific bot
 */
router.get('/:botId/logs', async (req, res) => {
    try {
        const { botId } = req.params;
        const { level, search, limit = 100, offset = 0, startDate, endDate } = req.query;

        const logger = loggerManager.getLogger(botId);
        const options = {
            level: level || null,
            search: search || null,
            limit: parseInt(limit),
            offset: parseInt(offset)
        };

        if (startDate) options.startDate = new Date(startDate);
        if (endDate) options.endDate = new Date(endDate);

        const logs = logger.getLogs(options);
        const stats = logger.getStats();

        res.json({
            logs,
            stats,
            hasMore: logs.length === parseInt(limit)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Stream logs in real-time (SSE)
 */
router.get('/:botId/logs/stream', async (req, res) => {
    try {
        const { botId } = req.params;
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const logger = loggerManager.getLogger(botId);
        
        // Send initial connection message
        res.write(`data: ${JSON.stringify({ type: 'connected', botId })}\n\n`);

        // Subscribe to log events
        const unsubscribe = logger.subscribe((logEntry) => {
            res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
        });

        // Keep alive
        const keepAlive = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 30000);

        // Handle disconnect
        req.on('close', () => {
            unsubscribe();
            clearInterval(keepAlive);
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Export logs
 */
router.get('/:botId/logs/export', async (req, res) => {
    try {
        const { botId } = req.params;
        const { format = 'json', level, search } = req.query;

        const logger = loggerManager.getLogger(botId);
        const options = { level, search };
        
        const exported = logger.export(format, options);
        
        const contentTypes = {
            json: 'application/json',
            jsonl: 'application/x-ndjson',
            text: 'text/plain',
            csv: 'text/csv',
            html: 'text/html'
        };

        const extensions = {
            json: 'json',
            jsonl: 'jsonl',
            text: 'txt',
            csv: 'csv',
            html: 'html'
        };

        res.setHeader('Content-Type', contentTypes[format] || 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${botId}-logs.${extensions[format] || 'txt'}"`);
        res.send(exported);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Clear logs for a bot
 */
router.delete('/:botId/logs', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const logger = loggerManager.getLogger(botId);
        logger.clear();
        
        res.json({ success: true, message: 'Logs cleared' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// BOT MANAGEMENT ROUTES
// ============================================

/**
 * Get all bots
 */
router.get('/', async (req, res) => {
    try {
        const { status, type, category, search } = req.query;
        
        let bots = await botManager.getAllBots();
        
        // Filter bots
        if (status) {
            bots = bots.filter(b => b.status === status);
        }
        if (type) {
            bots = bots.filter(b => b.type === type);
        }
        if (category) {
            bots = bots.filter(b => b.config.category === category);
        }
        if (search) {
            const searchLower = search.toLowerCase();
            bots = bots.filter(b => 
                b.name.toLowerCase().includes(searchLower) ||
                (b.config.description && b.config.description.toLowerCase().includes(searchLower))
            );
        }

        // Get stats for each bot
        const botStats = bots.map(bot => ({
            id: bot.id,
            name: bot.name,
            type: bot.type,
            status: bot.status,
            sessionType: bot.sessionAuth?.type,
            uptime: bot.startTime ? Date.now() - bot.startTime : 0,
            metrics: bot.metrics,
            healthStatus: bot.healthStatus,
            config: {
                category: bot.config.category,
                autoRestart: bot.autoRestart,
                tags: bot.config.tags
            },
            createdAt: bot.config.createdAt,
            lastActivity: bot.metrics.lastActivity
        }));

        res.json({
            bots: botStats,
            total: botStats.length,
            categories: await botManager.getCategories()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get bot templates
 */
router.get('/templates', (req, res) => {
    res.json({
        templates: Object.entries(BotTemplates).map(([key, template]) => ({
            id: key,
            name: template.name,
            description: template.description,
            type: template.type,
            sessionType: template.sessionType,
            features: template.features || []
        }))
    });
});

/**
 * Create bot from template
 */
router.post('/from-template', async (req, res) => {
    try {
        const { templateId, name, description, category, tags, ownerId } = req.body;

        if (!templateId || !name) {
            return res.status(400).json({ error: 'Template ID and name are required' });
        }

        const template = BotTemplates[templateId];
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }

        const options = {
            name,
            description: description || '',
            category: category || 'general',
            tags: tags || [],
            ownerId: ownerId || 'system'
        };

        const bot = await botManager.createBot(options, template);
        
        res.status(201).json({
            success: true,
            bot: {
                id: bot.id,
                name: bot.name,
                type: bot.type,
                status: bot.status,
                config: bot.config
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get a specific bot
 */
router.get('/:botId', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        res.json({
            id: bot.id,
            name: bot.name,
            type: bot.type,
            status: bot.status,
            sessionType: bot.sessionAuth?.type,
            uptime: bot.startTime ? Date.now() - bot.startTime : 0,
            metrics: bot.metrics,
            healthStatus: bot.healthStatus,
            config: bot.config,
            autoRestart: bot.autoRestart,
            restartCount: bot.restartCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Update bot configuration
 */
router.patch('/:botId', async (req, res) => {
    try {
        const { botId } = req.params;
        const updates = req.body;

        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        // Update allowed fields
        const allowedUpdates = ['name', 'description', 'category', 'tags', 'autoRestart', 'maxRestarts', 'restartDelay', 'envVars'];
        
        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                bot.config[field] = updates[field];
            }
        });

        await botManager.saveBotConfig(botId, bot.config);

        res.json({
            success: true,
            bot: {
                id: bot.id,
                name: bot.name,
                config: bot.config
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Start a bot
 */
router.post('/:botId/start', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        await bot.start();

        res.json({
            success: true,
            status: bot.status,
            message: `Bot ${bot.name} started`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Stop a bot
 */
router.post('/:botId/stop', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        await bot.stop();

        res.json({
            success: true,
            status: bot.status,
            message: `Bot ${bot.name} stopped`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Restart a bot
 */
router.post('/:botId/restart', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        await bot.restart();

        res.json({
            success: true,
            status: bot.status,
            message: `Bot ${bot.name} restarted`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Clone a bot
 */
router.post('/:botId/clone', async (req, res) => {
    try {
        const { botId } = req.params;
        const { name, includeSession } = req.body;

        const clonedBot = await botManager.cloneBot(botId, {
            name: name || 'Cloned Bot',
            includeSession: includeSession !== false
        });

        res.status(201).json({
            success: true,
            bot: {
                id: clonedBot.id,
                name: clonedBot.name,
                type: clonedBot.type,
                status: clonedBot.status
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Delete a bot
 */
router.delete('/:botId', async (req, res) => {
    try {
        const { botId } = req.params;
        
        await botManager.deleteBot(botId);

        res.json({
            success: true,
            message: 'Bot deleted successfully'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// BULK OPERATIONS
// ============================================

/**
 * Bulk start bots
 */
router.post('/bulk/start', async (req, res) => {
    try {
        const { botIds } = req.body;
        
        if (!Array.isArray(botIds)) {
            return res.status(400).json({ error: 'botIds must be an array' });
        }

        const results = await botManager.bulkOperation(botIds, 'start');

        res.json({
            success: true,
            results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Bulk stop bots
 */
router.post('/bulk/stop', async (req, res) => {
    try {
        const { botIds } = req.body;
        
        if (!Array.isArray(botIds)) {
            return res.status(400).json({ error: 'botIds must be an array' });
        }

        const results = await botManager.bulkOperation(botIds, 'stop');

        res.json({
            success: true,
            results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Bulk delete bots
 */
router.post('/bulk/delete', async (req, res) => {
    try {
        const { botIds } = req.body;
        
        if (!Array.isArray(botIds)) {
            return res.status(400).json({ error: 'botIds must be an array' });
        }

        const results = await botManager.bulkOperation(botIds, 'delete');

        res.json({
            success: true,
            results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// CATEGORIES
// ============================================

/**
 * Get all categories
 */
router.get('/categories', async (req, res) => {
    try {
        const categories = await botManager.getCategories();
        res.json({ categories });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Create a new category
 */
router.post('/categories', async (req, res) => {
    try {
        const { name, icon, color } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Category name is required' });
        }

        const category = await botManager.createCategory({ name, icon, color });

        res.status(201).json({
            success: true,
            category
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// HEALTH & METRICS
// ============================================

/**
 * Get bot health status
 */
router.get('/:botId/health', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const health = await bot.checkHealth();

        res.json(health);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get bot metrics
 */
router.get('/:botId/metrics', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const bot = await botManager.getBot(botId);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        res.json({
            botId: bot.id,
            metrics: bot.metrics,
            uptime: bot.startTime ? Date.now() - bot.startTime : 0,
            restartCount: bot.restartCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get all bots stats
 */
router.get('/stats/overview', async (req, res) => {
    try {
        const stats = await botManager.getStats();
        const logStats = loggerManager.getAllStats();

        res.json({
            ...stats,
            logs: logStats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = {
    router,
    initBotManagerRoutes,
    getBotManager: () => botManager,
    getSessionManager: () => sessionManager,
    getLoggerManager: () => loggerManager
};