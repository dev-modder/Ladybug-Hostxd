'use strict';

/**
 * Individual Bot Logger System for LADYBUGNODES V5.2
 * Each bot has its own isolated log window
 * Supports real-time streaming, filtering, and export
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

// Log levels
const LogLevel = {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
    SUCCESS: 'success',
    BOT: 'bot',
    SYSTEM: 'system',
    QR: 'qr',
    CONNECTION: 'connection'
};

// Log colors for terminal
const LogColors = {
    debug: '\x1b[90m',    // Gray
    info: '\x1b[36m',     // Cyan
    warn: '\x1b[33m',     // Yellow
    error: '\x1b[31m',    // Red
    success: '\x1b[32m',  // Green
    bot: '\x1b[35m',      // Magenta
    system: '\x1b[34m',   // Blue
    qr: '\x1b[37m',       // White
    connection: '\x1b[33m', // Yellow
    reset: '\x1b[0m'
};

/**
 * Individual Bot Logger
 */
class BotLogger extends EventEmitter {
    constructor(botId, options = {}) {
        super();
        this.botId = botId;
        this.options = {
            maxLogs: options.maxLogs || 1000,
            persistToFile: options.persistToFile !== false,
            logDir: options.logDir || './data/logs',
            consoleOutput: options.consoleOutput !== false
        };
        
        this.logs = [];
        this.startTime = Date.now();
        this.logFile = null;
        
        if (this.options.persistToFile) {
            this._initLogFile();
        }
    }

    _initLogFile() {
        const logDir = path.join(this.options.logDir, this.botId);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const date = new Date().toISOString().split('T')[0];
        this.logFile = path.join(logDir, `log-${date}.jsonl`);
    }

    /**
     * Write a log entry
     */
    log(level, message, data = {}) {
        const entry = {
            id: uuidv4(),
            timestamp: Date.now(),
            datetime: new Date().toISOString(),
            botId: this.botId,
            level,
            message,
            data
        };

        // Add to memory buffer
        this.logs.push(entry);
        if (this.logs.length > this.options.maxLogs) {
            this.logs.shift();
        }

        // Persist to file
        if (this.logFile) {
            try {
                fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
            } catch (e) {
                console.error(`[Logger] Failed to write log file: ${e.message}`);
            }
        }

        // Console output
        if (this.options.consoleOutput) {
            const color = LogColors[level] || LogColors.info;
            const reset = LogColors.reset;
            console.log(`${color}[${this.botId.substring(0, 8)}][${level.toUpperCase()}]${reset} ${message}`);
        }

        // Emit for real-time subscribers
        this.emit('log', entry);

        return entry;
    }

    // Convenience methods
    debug(msg, data) { return this.log(LogLevel.DEBUG, msg, data); }
    info(msg, data) { return this.log(LogLevel.INFO, msg, data); }
    warn(msg, data) { return this.log(LogLevel.WARN, msg, data); }
    error(msg, data) { return this.log(LogLevel.ERROR, msg, data); }
    success(msg, data) { return this.log(LogLevel.SUCCESS, msg, data); }
    bot(msg, data) { return this.log(LogLevel.BOT, msg, data); }
    system(msg, data) { return this.log(LogLevel.SYSTEM, msg, data); }
    qr(msg, data) { return this.log(LogLevel.QR, msg, data); }
    connection(msg, data) { return this.log(LogLevel.CONNECTION, msg, data); }

    /**
     * Get logs with filtering
     */
    getLogs(options = {}) {
        let logs = [...this.logs];

        // Filter by level
        if (options.level) {
            logs = logs.filter(l => l.level === options.level);
        }

        // Filter by levels
        if (options.levels && Array.isArray(options.levels)) {
            logs = logs.filter(l => options.levels.includes(l.level));
        }

        // Filter by search
        if (options.search) {
            const search = options.search.toLowerCase();
            logs = logs.filter(l => 
                l.message.toLowerCase().includes(search) ||
                JSON.stringify(l.data).toLowerCase().includes(search)
            );
        }

        // Filter by time range
        if (options.since) {
            logs = logs.filter(l => l.timestamp >= options.since);
        }
        if (options.until) {
            logs = logs.filter(l => l.timestamp <= options.until);
        }

        // Limit
        if (options.limit) {
            logs = logs.slice(-options.limit);
        }

        // Offset
        if (options.offset) {
            logs = logs.slice(options.offset);
        }

        return logs;
    }

    /**
     * Get log statistics
     */
    getStats() {
        const stats = {
            botId: this.botId,
            totalLogs: this.logs.length,
            startTime: this.startTime,
            uptime: Date.now() - this.startTime,
            levels: {}
        };

        for (const level of Object.values(LogLevel)) {
            stats.levels[level] = this.logs.filter(l => l.level === level).length;
        }

        return stats;
    }

    /**
     * Clear logs
     */
    clear() {
        this.logs = [];
        this.emit('clear');
    }

    /**
     * Export logs
     */
    export(format = 'json') {
        switch (format) {
            case 'json':
                return JSON.stringify(this.logs, null, 2);
            
            case 'jsonl':
                return this.logs.map(l => JSON.stringify(l)).join('\n');
            
            case 'text':
                return this.logs.map(l => 
                    `[${new Date(l.timestamp).toISOString()}][${l.level.toUpperCase()}] ${l.message}`
                ).join('\n');
            
            case 'csv':
                const header = 'timestamp,datetime,level,message,data\n';
                const rows = this.logs.map(l => 
                    `${l.timestamp},${l.datetime},${l.level},"${l.message.replace(/"/g, '""')}","${JSON.stringify(l.data).replace(/"/g, '""')}"`
                ).join('\n');
                return header + rows;

            case 'html':
                return this._exportHtml();

            default:
                return JSON.stringify(this.logs, null, 2);
        }
    }

    _exportHtml() {
        const levelColors = {
            debug: '#6b7280',
            info: '#06b6d4',
            warn: '#f59e0b',
            error: '#ef4444',
            success: '#10b981',
            bot: '#8b5cf6',
            system: '#3b82f6',
            qr: '#ffffff',
            connection: '#f59e0b'
        };

        let html = `<!DOCTYPE html>
<html>
<head>
    <title>Bot Logs - ${this.botId}</title>
    <style>
        body { font-family: 'Courier New', monospace; background: #1a1a2e; color: #eee; padding: 20px; }
        .log-entry { padding: 8px 12px; margin: 4px 0; border-radius: 4px; background: #16213e; }
        .timestamp { color: #888; }
        .level { font-weight: bold; padding: 2px 6px; border-radius: 3px; margin: 0 8px; }
        .message { color: #fff; }
        .data { color: #888; font-size: 0.9em; margin-top: 4px; }
    </style>
</head>
<body>
    <h1>Bot Logs: ${this.botId}</h1>
    <div class="logs">`;

        for (const log of this.logs) {
            const color = levelColors[log.level] || '#888';
            html += `
        <div class="log-entry">
            <span class="timestamp">${new Date(log.timestamp).toLocaleString()}</span>
            <span class="level" style="background: ${color}">${log.level.toUpperCase()}</span>
            <span class="message">${this._escapeHtml(log.message)}</span>
            ${Object.keys(log.data).length ? `<div class="data">${this._escapeHtml(JSON.stringify(log.data, null, 2))}</div>` : ''}
        </div>`;
        }

        html += `
    </div>
</body>
</html>`;
        return html;
    }

    _escapeHtml(text) {
        return text.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
    }

    /**
     * Subscribe to real-time logs
     */
    subscribe(callback) {
        this.on('log', callback);
        return () => this.off('log', callback);
    }

    /**
     * Load logs from file
     */
    loadFromFile(date) {
        if (!this.logFile) return [];
        
        const logFile = date 
            ? path.join(this.options.logDir, this.botId, `log-${date}.jsonl`)
            : this.logFile;
        
        if (!fs.existsSync(logFile)) return [];
        
        const content = fs.readFileSync(logFile, 'utf8');
        return content.trim().split('\n').map(line => JSON.parse(line));
    }
}

/**
 * Bot Logger Manager
 * Manages loggers for multiple bots
 */
class BotLoggerManager {
    constructor(options = {}) {
        this.loggers = new Map();
        this.options = options;
        this.logDir = options.logDir || './data/logs';
        
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    /**
     * Get or create logger for a bot
     */
    getLogger(botId) {
        if (!this.loggers.has(botId)) {
            const logger = new BotLogger(botId, {
                ...this.options,
                logDir: this.logDir
            });
            this.loggers.set(botId, logger);
        }
        return this.loggers.get(botId);
    }

    /**
     * Remove logger for a bot
     */
    removeLogger(botId) {
        const logger = this.loggers.get(botId);
        if (logger) {
            logger.removeAllListeners();
            this.loggers.delete(botId);
        }
    }

    /**
     * Get all bot IDs with loggers
     */
    getBotIds() {
        return Array.from(this.loggers.keys());
    }

    /**
     * Get combined stats
     */
    getAllStats() {
        const stats = {};
        for (const [botId, logger] of this.loggers) {
            stats[botId] = logger.getStats();
        }
        return stats;
    }

    /**
     * Broadcast log to all subscribers
     */
    broadcastToAll(level, message, data = {}) {
        for (const logger of this.loggers.values()) {
            logger.log(level, message, data);
        }
    }

    /**
     * Get historical logs for a bot
     */
    getHistoricalLogs(botId, date) {
        const logFile = path.join(this.logDir, botId, `log-${date}.jsonl`);
        if (!fs.existsSync(logFile)) return [];
        
        const content = fs.readFileSync(logFile, 'utf8');
        return content.trim().split('\n').map(line => JSON.parse(line));
    }

    /**
     * List available log dates for a bot
     */
    listLogDates(botId) {
        const botLogDir = path.join(this.logDir, botId);
        if (!fs.existsSync(botLogDir)) return [];
        
        return fs.readdirSync(botLogDir)
            .filter(f => f.startsWith('log-') && f.endsWith('.jsonl'))
            .map(f => f.replace('log-', '').replace('.jsonl', ''))
            .sort()
            .reverse();
    }

    /**
     * Clean old logs
     */
    cleanOldLogs(daysToKeep = 30) {
        const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        let cleaned = 0;

        const botDirs = fs.readdirSync(this.logDir);
        for (const botId of botDirs) {
            const botLogDir = path.join(this.logDir, botId);
            if (!fs.statSync(botLogDir).isDirectory()) continue;

            const files = fs.readdirSync(botLogDir);
            for (const file of files) {
                if (file.startsWith('log-') && file.endsWith('.jsonl')) {
                    const dateStr = file.replace('log-', '').replace('.jsonl', '');
                    const fileDate = new Date(dateStr).getTime();
                    
                    if (fileDate < cutoff) {
                        fs.unlinkSync(path.join(botLogDir, file));
                        cleaned++;
                    }
                }
            }
        }

        return cleaned;
    }
}

module.exports = {
    LogLevel,
    LogColors,
    BotLogger,
    BotLoggerManager
};