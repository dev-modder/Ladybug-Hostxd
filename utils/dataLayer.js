'use strict';

/**
 * Hybrid Data Layer - Works with MongoDB (preferred) or file-based storage (fallback)
 * This ensures the application works even without MongoDB configured
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Import models
const User = require('../models/User');
const Session = require('../models/Session');
const Bot = require('../models/Bot');
const Activity = require('../models/Activity');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');
const Webhook = require('../models/Webhook');

// File paths for fallback
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BOT_CONFIGS_FILE = path.join(DATA_DIR, 'bot-configs.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Check if MongoDB is connected
const isMongoConnected = () => mongoose.connection.readyState === 1;

// ═══════════════════════════════════════════════════════════════════════════
// USER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const UserOperations = {
    async findAll(options = {}) {
        if (isMongoConnected()) {
            const { limit, skip, sort, filter } = options;
            let query = User.find(filter || {});
            if (sort) query = query.sort(sort);
            if (skip) query = query.skip(skip);
            if (limit) query = query.limit(limit);
            return await query.lean();
        }
        // File fallback
        return loadUsers();
    },

    async findById(id) {
        if (isMongoConnected()) {
            return await User.findById(id).lean();
        }
        const users = loadUsers();
        return users.find(u => u.id === id || u._id === id) || null;
    },

    async findByUsername(username) {
        if (isMongoConnected()) {
            return await User.findOne({ username }).lean();
        }
        const users = loadUsers();
        return users.find(u => u.username === username) || null;
    },

    async findByEmail(email) {
        if (isMongoConnected()) {
            return await User.findOne({ email }).lean();
        }
        const users = loadUsers();
        return users.find(u => u.email === email) || null;
    },

    async findByPhone(phone) {
        if (isMongoConnected()) {
            return await User.findOne({ phone }).lean();
        }
        const users = loadUsers();
        return users.find(u => u.phone === phone) || null;
    },

    async create(userData) {
        if (isMongoConnected()) {
            const user = new User(userData);
            await user.save();
            return user.toObject();
        }
        // File fallback
        const users = loadUsers();
        const newUser = {
            id: uuidv4(),
            ...userData,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        users.push(newUser);
        saveUsers(users);
        return newUser;
    },

    async updateById(id, updateData) {
        if (isMongoConnected()) {
            const user = await User.findByIdAndUpdate(
                id,
                { ...updateData, updatedAt: new Date() },
                { new: true }
            ).lean();
            return user;
        }
        // File fallback
        const users = loadUsers();
        const index = users.findIndex(u => u.id === id || u._id === id);
        if (index === -1) return null;
        users[index] = { ...users[index], ...updateData, updatedAt: new Date().toISOString() };
        saveUsers(users);
        return users[index];
    },

    async deleteById(id) {
        if (isMongoConnected()) {
            await User.findByIdAndDelete(id);
            return true;
        }
        // File fallback
        let users = loadUsers();
        const initialLength = users.length;
        users = users.filter(u => u.id !== id && u._id !== id);
        saveUsers(users);
        return users.length < initialLength;
    },

    async count(filter = {}) {
        if (isMongoConnected()) {
            return await User.countDocuments(filter);
        }
        const users = loadUsers();
        if (Object.keys(filter).length === 0) return users.length;
        return users.filter(u => {
            return Object.entries(filter).every(([key, value]) => u[key] === value);
        }).length;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// SESSION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const SessionOperations = {
    async findAll(options = {}) {
        if (isMongoConnected()) {
            const { limit, skip, sort, filter } = options;
            let query = Session.find(filter || {});
            if (sort) query = query.sort(sort);
            if (skip) query = query.skip(skip);
            if (limit) query = query.limit(limit);
            return await query.lean();
        }
        return loadSessions();
    },

    async findById(id) {
        if (isMongoConnected()) {
            return await Session.findById(id).lean();
        }
        const sessions = loadSessions();
        return sessions.find(s => s.id === id || s._id === id) || null;
    },

    async findBySessionId(sessionId) {
        if (isMongoConnected()) {
            return await Session.findOne({ sessionId }).lean();
        }
        const sessions = loadSessions();
        return sessions.find(s => s.sessionId === sessionId) || null;
    },

    async findByOwner(ownerId) {
        if (isMongoConnected()) {
            return await Session.find({ owner: ownerId }).lean();
        }
        const sessions = loadSessions();
        return sessions.filter(s => s.owner === ownerId);
    },

    async create(sessionData) {
        if (isMongoConnected()) {
            const session = new Session(sessionData);
            await session.save();
            return session.toObject();
        }
        const sessions = loadSessions();
        const newSession = {
            id: uuidv4(),
            ...sessionData,
            createdAt: new Date().toISOString()
        };
        sessions.push(newSession);
        saveSessions(sessions);
        return newSession;
    },

    async updateById(id, updateData) {
        if (isMongoConnected()) {
            return await Session.findByIdAndUpdate(
                id,
                { ...updateData, updatedAt: new Date() },
                { new: true }
            ).lean();
        }
        const sessions = loadSessions();
        const index = sessions.findIndex(s => s.id === id || s._id === id);
        if (index === -1) return null;
        sessions[index] = { ...sessions[index], ...updateData, updatedAt: new Date().toISOString() };
        saveSessions(sessions);
        return sessions[index];
    },

    async deleteById(id) {
        if (isMongoConnected()) {
            await Session.findByIdAndDelete(id);
            return true;
        }
        let sessions = loadSessions();
        const initialLength = sessions.length;
        sessions = sessions.filter(s => s.id !== id && s._id !== id);
        saveSessions(sessions);
        return sessions.length < initialLength;
    },

    async count(filter = {}) {
        if (isMongoConnected()) {
            return await Session.countDocuments(filter);
        }
        const sessions = loadSessions();
        return sessions.length;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// BOT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const BotOperations = {
    async findAll(options = {}) {
        if (isMongoConnected()) {
            const { limit, skip, sort, filter } = options;
            let query = Bot.find(filter || {});
            if (sort) query = query.sort(sort);
            if (skip) query = query.skip(skip);
            if (limit) query = query.limit(limit);
            return await query.lean();
        }
        return loadBotConfigs();
    },

    async findById(id) {
        if (isMongoConnected()) {
            return await Bot.findById(id).lean();
        }
        const bots = loadBotConfigs();
        return bots.find(b => b.id === id || b._id === id) || null;
    },

    async findByOwner(ownerId) {
        if (isMongoConnected()) {
            return await Bot.find({ owner: ownerId }).lean();
        }
        const bots = loadBotConfigs();
        return bots.filter(b => b.owner === ownerId);
    },

    async create(botData) {
        if (isMongoConnected()) {
            const bot = new Bot(botData);
            await bot.save();
            return bot.toObject();
        }
        const bots = loadBotConfigs();
        const newBot = {
            id: uuidv4(),
            ...botData,
            createdAt: new Date().toISOString()
        };
        bots.push(newBot);
        saveBotConfigs(bots);
        return newBot;
    },

    async updateById(id, updateData) {
        if (isMongoConnected()) {
            return await Bot.findByIdAndUpdate(
                id,
                { ...updateData, updatedAt: new Date() },
                { new: true }
            ).lean();
        }
        const bots = loadBotConfigs();
        const index = bots.findIndex(b => b.id === id || b._id === id);
        if (index === -1) return null;
        bots[index] = { ...bots[index], ...updateData, updatedAt: new Date().toISOString() };
        saveBotConfigs(bots);
        return bots[index];
    },

    async deleteById(id) {
        if (isMongoConnected()) {
            await Bot.findByIdAndDelete(id);
            return true;
        }
        let bots = loadBotConfigs();
        const initialLength = bots.length;
        bots = bots.filter(b => b.id !== id && b._id !== id);
        saveBotConfigs(bots);
        return bots.length < initialLength;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVITY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const ActivityOperations = {
    async log(userId, action, details = {}, metadata = {}) {
        if (isMongoConnected()) {
            const activity = new Activity({
                user: userId,
                action,
                details,
                metadata,
                timestamp: new Date()
            });
            await activity.save();
            return activity.toObject();
        }
        // No file fallback for activities - they're transient
        console.log(`[Activity] ${userId}: ${action}`, details);
        return null;
    },

    async findByUser(userId, limit = 50) {
        if (isMongoConnected()) {
            return await Activity.find({ user: userId })
                .sort({ timestamp: -1 })
                .limit(limit)
                .lean();
        }
        return [];
    },

    async getRecent(limit = 100) {
        if (isMongoConnected()) {
            return await Activity.find()
                .sort({ timestamp: -1 })
                .limit(limit)
                .lean();
        }
        return [];
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// TRANSACTION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const TransactionOperations = {
    async create(transactionData) {
        if (isMongoConnected()) {
            const transaction = new Transaction(transactionData);
            await transaction.save();
            return transaction.toObject();
        }
        return null;
    },

    async findByUser(userId, limit = 50) {
        if (isMongoConnected()) {
            return await Transaction.find({
                $or: [{ fromUser: userId }, { toUser: userId }]
            })
                .sort({ timestamp: -1 })
                .limit(limit)
                .lean();
        }
        return [];
    },

    async getBalance(userId) {
        if (isMongoConnected()) {
            const user = await User.findById(userId).select('coins');
            return user ? user.coins : 0;
        }
        const users = loadUsers();
        const user = users.find(u => u.id === userId || u._id === userId);
        return user ? user.coins || 0 : 0;
    },

    async transfer(fromUserId, toUserId, amount, description = '') {
        if (isMongoConnected()) {
            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                const fromUser = await User.findById(fromUserId).session(session);
                const toUser = await User.findById(toUserId).session(session);

                if (!fromUser || !toUser) throw new Error('User not found');
                if (fromUser.coins < amount) throw new Error('Insufficient balance');

                fromUser.coins -= amount;
                toUser.coins += amount;

                await fromUser.save({ session });
                await toUser.save({ session });

                const transaction = new Transaction({
                    fromUser: fromUserId,
                    toUser: toUserId,
                    amount,
                    type: 'transfer',
                    description,
                    status: 'completed'
                });
                await transaction.save({ session });

                await session.commitTransaction();
                return transaction.toObject();
            } catch (error) {
                await session.abortTransaction();
                throw error;
            } finally {
                session.endSession();
        }
        }
        // File fallback
        const users = loadUsers();
        const fromIndex = users.findIndex(u => u.id === fromUserId);
        const toIndex = users.findIndex(u => u.id === toUserId);

        if (fromIndex === -1 || toIndex === -1) throw new Error('User not found');
        if (users[fromIndex].coins < amount) throw new Error('Insufficient balance');

        users[fromIndex].coins -= amount;
        users[toIndex].coins += amount;
        saveUsers(users);
        return { fromUser: fromUserId, toUser: toUserId, amount, status: 'completed' };
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const NotificationOperations = {
    async create(notificationData) {
        if (isMongoConnected()) {
            const notification = new Notification(notificationData);
            await notification.save();
            return notification.toObject();
        }
        return null;
    },

    async findByUser(userId, limit = 20) {
        if (isMongoConnected()) {
            return await Notification.find({ user: userId })
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean();
        }
        return [];
    },

    async markAsRead(notificationId) {
        if (isMongoConnected()) {
            return await Notification.findByIdAndUpdate(
                notificationId,
                { read: true, readAt: new Date() },
                { new: true }
            ).lean();
        }
        return null;
    },

    async markAllAsRead(userId) {
        if (isMongoConnected()) {
            await Notification.updateMany(
                { user: userId, read: false },
                { read: true, readAt: new Date() }
            );
            return true;
        }
        return false;
    },

    async getUnreadCount(userId) {
        if (isMongoConnected()) {
            return await Notification.countDocuments({ user: userId, read: false });
        }
        return 0;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const WebhookOperations = {
    async create(webhookData) {
        if (isMongoConnected()) {
            const webhook = new Webhook(webhookData);
            await webhook.save();
            return webhook.toObject();
        }
        return null;
    },

    async findByUser(userId) {
        if (isMongoConnected()) {
            return await Webhook.find({ owner: userId }).lean();
        }
        return [];
    },

    async findByEvent(event) {
        if (isMongoConnected()) {
            return await Webhook.find({ events: event, active: true }).lean();
        }
        return [];
    },

    async updateById(id, updateData) {
        if (isMongoConnected()) {
            return await Webhook.findByIdAndUpdate(id, updateData, { new: true }).lean();
        }
        return null;
    },

    async deleteById(id) {
        if (isMongoConnected()) {
            await Webhook.findByIdAndDelete(id);
            return true;
        }
        return false;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// FILE HELPERS (Fallback)
// ═══════════════════════════════════════════════════════════════════════════

function loadUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadSessions() {
    try {
        return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveSessions(sessions) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function loadBotConfigs() {
    try {
        return JSON.parse(fs.readFileSync(BOT_CONFIGS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveBotConfigs(bots) {
    fs.writeFileSync(BOT_CONFIGS_FILE, JSON.stringify(bots, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    isMongoConnected,
    User: UserOperations,
    Session: SessionOperations,
    Bot: BotOperations,
    Activity: ActivityOperations,
    Transaction: TransactionOperations,
    Notification: NotificationOperations,
    Webhook: WebhookOperations,
    // Direct model access for advanced use
    Models: {
        User,
        Session,
        Bot,
        Activity,
        Transaction,
        Notification,
        Webhook
    }
};