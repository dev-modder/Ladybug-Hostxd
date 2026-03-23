'use strict';

/**
 * Multi-Auth Session System for LADYBUGNODES V5.2
 * Supports multiple session types:
 * - creds.json (Baileys-style credentials)
 * - session_id (Pairing code / string session)
 * - auth_state folder (Multi-file credentials)
 * - QR Code scanning
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Session types
const SessionType = {
    CREDS_JSON: 'creds.json',
    SESSION_ID: 'session_id',
    AUTH_STATE: 'auth_state',
    QR_CODE: 'qr_code'
};

/**
 * Detect session type from directory
 */
function detectSessionType(sessionDir) {
    if (!fs.existsSync(sessionDir)) {
        return null;
    }

    // Check for creds.json
    const credsPath = path.join(sessionDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
        try {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            if (creds.account && creds.me) {
                return SessionType.CREDS_JSON;
            }
        } catch (e) {}
    }

    // Check for session_id file
    const sessionIdPath = path.join(sessionDir, 'session_id');
    if (fs.existsSync(sessionIdPath)) {
        const sessionId = fs.readFileSync(sessionIdPath, 'utf8').trim();
        if (sessionId.length > 20) {
            return SessionType.SESSION_ID;
        }
    }

    // Check for auth_state folder (Baileys multi-file)
    const authStatePath = path.join(sessionDir, 'auth_state');
    if (fs.existsSync(authStatePath)) {
        const files = fs.readdirSync(authStatePath);
        if (files.some(f => f.startsWith('key-') || f === 'creds.json')) {
            return SessionType.AUTH_STATE;
        }
    }

    // Check for pairing.json (pairing code auth)
    const pairingPath = path.join(sessionDir, 'pairing.json');
    if (fs.existsSync(pairingPath)) {
        return SessionType.SESSION_ID;
    }

    return null;
}

/**
 * Session Authentication Adapter
 * Handles different session authentication methods
 */
class SessionAuthAdapter {
    constructor(sessionDir, options = {}) {
        this.sessionDir = sessionDir;
        this.options = options;
        this.type = null;
        this.data = null;
    }

    /**
     * Initialize and detect session type
     */
    async init() {
        this.type = detectSessionType(this.sessionDir);
        
        if (!this.type) {
            // Create default auth structure
            await this.createDefaultAuth();
            this.type = SessionType.AUTH_STATE;
        }

        await this.loadSessionData();
        return this.type;
    }

    /**
     * Create default authentication structure
     */
    async createDefaultAuth() {
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }

        const authStateDir = path.join(this.sessionDir, 'auth_state');
        if (!fs.existsSync(authStateDir)) {
            fs.mkdirSync(authStateDir, { recursive: true });
        }

        // Create initial creds.json placeholder
        const credsPath = path.join(authStateDir, 'creds.json');
        if (!fs.existsSync(credsPath)) {
            fs.writeFileSync(credsPath, JSON.stringify({
                noiseKey: this.generateKeyPair(),
                signedIdentityKey: this.generateKeyPair(),
                signedPreKey: this.generateKeyPair(),
                registrationId: Math.floor(Math.random() * 16384) + 1,
                advSecretKey: this.generateRandomString(64),
                processedHistoryMessages: [],
                nextPreKeyId: 1,
                firstUnuploadedPreKeyId: 1,
                accountSettings: {
                    unarchiveChats: false
                }
            }, null, 2));
        }
    }

    /**
     * Load session data based on type
     */
    async loadSessionData() {
        switch (this.type) {
            case SessionType.CREDS_JSON:
                await this.loadCredsJson();
                break;
            case SessionType.SESSION_ID:
                await this.loadSessionId();
                break;
            case SessionType.AUTH_STATE:
                await this.loadAuthState();
                break;
            default:
                throw new Error(`Unknown session type: ${this.type}`);
        }
    }

    /**
     * Load creds.json format
     */
    async loadCredsJson() {
        const credsPath = path.join(this.sessionDir, 'creds.json');
        if (fs.existsSync(credsPath)) {
            this.data = {
                type: SessionType.CREDS_JSON,
                creds: JSON.parse(fs.readFileSync(credsPath, 'utf8')),
                path: credsPath
            };
        }
    }

    /**
     * Load session_id format
     */
    async loadSessionId() {
        const sessionIdPath = path.join(this.sessionDir, 'session_id');
        if (fs.existsSync(sessionIdPath)) {
            this.data = {
                type: SessionType.SESSION_ID,
                sessionId: fs.readFileSync(sessionIdPath, 'utf8').trim(),
                path: sessionIdPath
            };
        }
    }

    /**
     * Load auth_state format (multi-file)
     */
    async loadAuthState() {
        const authStateDir = path.join(this.sessionDir, 'auth_state');
        const credsPath = path.join(authStateDir, 'creds.json');
        
        const keys = {};
        if (fs.existsSync(authStateDir)) {
            const files = fs.readdirSync(authStateDir);
            for (const file of files) {
                if (file.startsWith('key-')) {
                    const keyName = file.replace('key-', '').replace('.json', '');
                    keys[keyName] = JSON.parse(fs.readFileSync(path.join(authStateDir, file), 'utf8'));
                }
            }
        }

        this.data = {
            type: SessionType.AUTH_STATE,
            creds: fs.existsSync(credsPath) ? JSON.parse(fs.readFileSync(credsPath, 'utf8')) : null,
            keys,
            path: authStateDir
        };
    }

    /**
     * Save session data
     */
    async save() {
        if (!this.data) return;

        switch (this.type) {
            case SessionType.CREDS_JSON:
                fs.writeFileSync(this.data.path, JSON.stringify(this.data.creds, null, 2));
                break;
            case SessionType.SESSION_ID:
                fs.writeFileSync(this.data.path, this.data.sessionId);
                break;
            case SessionType.AUTH_STATE:
                const credsPath = path.join(this.data.path, 'creds.json');
                fs.writeFileSync(credsPath, JSON.stringify(this.data.creds, null, 2));
                for (const [keyName, keyData] of Object.entries(this.data.keys || {})) {
                    const keyPath = path.join(this.data.path, `key-${keyName}.json`);
                    fs.writeFileSync(keyPath, JSON.stringify(keyData, null, 2));
                }
                break;
        }
    }

    /**
     * Import session from various formats
     */
    async importSession(source, type) {
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }

        switch (type) {
            case 'creds_json':
            case 'creds.json':
                // Source is JSON string or object
                const creds = typeof source === 'string' ? JSON.parse(source) : source;
                fs.writeFileSync(path.join(this.sessionDir, 'creds.json'), JSON.stringify(creds, null, 2));
                this.type = SessionType.CREDS_JSON;
                break;

            case 'session_id':
            case 'string':
                // Source is session string
                fs.writeFileSync(path.join(this.sessionDir, 'session_id'), source.trim());
                this.type = SessionType.SESSION_ID;
                break;

            case 'folder':
                // Source is folder path - copy all files
                const sourceDir = source;
                if (fs.existsSync(sourceDir)) {
                    const files = fs.readdirSync(sourceDir);
                    for (const file of files) {
                        fs.copyFileSync(
                            path.join(sourceDir, file),
                            path.join(this.sessionDir, file)
                        );
                    }
                }
                this.type = detectSessionType(this.sessionDir);
                break;

            default:
                // Try to auto-detect format
                if (typeof source === 'string') {
                    try {
                        const parsed = JSON.parse(source);
                        if (parsed.account || parsed.me || parsed.noiseKey) {
                            await this.importSession(parsed, 'creds_json');
                        }
                    } catch {
                        // Not JSON, treat as session string
                        await this.importSession(source, 'session_id');
                    }
                }
        }

        await this.loadSessionData();
        return this.type;
    }

    /**
     * Export session in specified format
     */
    async exportSession(format = 'auto') {
        if (!this.data) return null;

        switch (format) {
            case 'creds_json':
            case 'creds.json':
                if (this.type === SessionType.CREDS_JSON) {
                    return JSON.stringify(this.data.creds, null, 2);
                } else if (this.type === SessionType.AUTH_STATE) {
                    return JSON.stringify(this.data.creds, null, 2);
                }
                break;

            case 'session_id':
            case 'string':
                if (this.type === SessionType.SESSION_ID) {
                    return this.data.sessionId;
                }
                break;

            case 'folder':
                return this.sessionDir;

            case 'auto':
            default:
                // Return in current format
                return this.type === SessionType.SESSION_ID 
                    ? this.data.sessionId 
                    : JSON.stringify(this.data.creds, null, 2);
        }

        return null;
    }

    /**
     * Check if session is valid/connected
     */
    isValid() {
        if (!this.data) return false;

        switch (this.type) {
            case SessionType.CREDS_JSON:
                return !!(this.data.creds?.me?.id);
            case SessionType.SESSION_ID:
                return !!(this.data.sessionId && this.data.sessionId.length > 20);
            case SessionType.AUTH_STATE:
                return !!(this.data.creds?.me?.id);
            default:
                return false;
        }
    }

    /**
     * Get session info
     */
    getInfo() {
        if (!this.data) return null;

        const info = {
            type: this.type,
            valid: this.isValid(),
            path: this.sessionDir
        };

        if (this.data.creds?.me) {
            info.user = {
                id: this.data.creds.me.id,
                name: this.data.creds.me.name,
                jid: this.data.creds.me.id
            };
        }

        if (this.data.sessionId) {
            info.sessionIdPreview = this.data.sessionId.substring(0, 20) + '...';
        }

        return info;
    }

    // Helper methods
    generateKeyPair() {
        const crypto = require('crypto');
        return {
            private: crypto.randomBytes(32).toString('base64'),
            public: crypto.randomBytes(32).toString('base64')
        };
    }

    generateRandomString(length) {
        return require('crypto').randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    }
}

/**
 * Session Manager - Manages multiple sessions
 */
class SessionManager {
    constructor(baseDir = './data/sessions') {
        this.baseDir = baseDir;
        this.sessions = new Map();
        this._ensureBaseDir();
    }

    _ensureBaseDir() {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    /**
     * Create a new session
     */
    async createSession(sessionId, options = {}) {
        const sessionDir = path.join(this.baseDir, sessionId);
        const adapter = new SessionAuthAdapter(sessionDir, options);
        
        await adapter.init();
        this.sessions.set(sessionId, adapter);
        
        return adapter;
    }

    /**
     * Get existing session
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    /**
     * Load all existing sessions
     */
    async loadAllSessions() {
        const dirs = fs.readdirSync(this.baseDir);
        for (const sessionId of dirs) {
            const sessionDir = path.join(this.baseDir, sessionId);
            if (fs.statSync(sessionDir).isDirectory()) {
                const adapter = new SessionAuthAdapter(sessionDir);
                await adapter.init();
                this.sessions.set(sessionId, adapter);
            }
        }
        return Array.from(this.sessions.keys());
    }

    /**
     * Delete session
     */
    async deleteSession(sessionId) {
        const adapter = this.sessions.get(sessionId);
        if (adapter) {
            // Delete folder
            if (fs.existsSync(adapter.sessionDir)) {
                fs.rmSync(adapter.sessionDir, { recursive: true, force: true });
            }
            this.sessions.delete(sessionId);
        }
    }

    /**
     * List all sessions with info
     */
    listSessions() {
        const list = [];
        for (const [sessionId, adapter] of this.sessions) {
            list.push({
                sessionId,
                ...adapter.getInfo()
            });
        }
        return list;
    }
}

module.exports = {
    SessionType,
    SessionAuthAdapter,
    SessionManager,
    detectSessionType
};