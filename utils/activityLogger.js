'use strict';

/**
 * Activity Logger Utility
 * Logs user activities to MongoDB or console
 */

const Data = require('./dataLayer');

/**
 * Log an activity
 * @param {string} userId - User ID
 * @param {string} action - Action type
 * @param {object} details - Additional details
 * @param {object} metadata - Request metadata
 */
async function logActivity(userId, action, details = {}, metadata = {}) {
    try {
        await Data.Activity.log(userId, action, details, metadata);
    } catch (error) {
        console.error('[ActivityLogger] Failed to log activity:', error.message);
    }
}

/**
 * Log with request context
 */
function logWithRequest(req, action, details = {}) {
    const metadata = {
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('user-agent'),
        path: req.path
    };

    return logActivity(req.user?.id, action, details, metadata);
}

/**
 * Common activity types
 */
const ActivityTypes = {
    // Auth
    USER_REGISTERED: 'user_registered',
    USER_LOGIN: 'user_login',
    USER_LOGOUT: 'user_logout',
    PASSWORD_CHANGED: 'password_changed',
    PASSWORD_RESET: 'password_reset',
    TWOFA_ENABLED: 'twofa_enabled',
    TWOFA_DISABLED: 'twofa_disabled',

    // Profile
    PROFILE_UPDATED: 'profile_updated',
    SETTINGS_UPDATED: 'settings_updated',
    API_KEY_CREATED: 'api_key_created',
    API_KEY_REVOKED: 'api_key_revoked',

    // Sessions
    SESSION_CREATED: 'session_created',
    SESSION_STARTED: 'session_started',
    SESSION_STOPPED: 'session_stopped',
    SESSION_DELETED: 'session_deleted',
    SESSION_CONNECTED: 'session_connected',
    SESSION_DISCONNECTED: 'session_disconnected',

    // Bots
    BOT_CREATED: 'bot_created',
    BOT_STARTED: 'bot_started',
    BOT_STOPPED: 'bot_stopped',
    BOT_DELETED: 'bot_deleted',
    BOT_UPDATED: 'bot_updated',
    BOT_DEPLOYED: 'bot_deployed',

    // Transactions
    COINS_EARNED: 'coins_earned',
    COINS_SPENT: 'coins_spent',
    COINS_TRANSFERRED: 'coins_transferred',
    COINS_ADDED_ADMIN: 'coins_added_admin',

    // Admin
    ADMIN_USER_UPDATED: 'admin_updated_user',
    ADMIN_USER_DELETED: 'admin_deleted_user',
    ADMIN_USER_BANNED: 'admin_banned_user',
    ADMIN_CONFIG_CHANGED: 'admin_config_changed',

    // Webhooks
    WEBHOOK_CREATED: 'webhook_created',
    WEBHOOK_DELETED: 'webhook_deleted',
    WEBHOOK_TRIGGERED: 'webhook_triggered',

    // Notifications
    NOTIFICATION_SENT: 'notification_sent',
    NOTIFICATION_READ: 'notification_read',

    // System
    SYSTEM_ERROR: 'system_error',
    SYSTEM_WARNING: 'system_warning',
    SYSTEM_BACKUP: 'system_backup'
};

module.exports = {
    logActivity,
    logWithRequest,
    ActivityTypes
};