'use strict';

/**
 * Enhanced API Routes for LADYBUGNODES V5
 * Uses MongoDB with file-based fallback
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

// Import data layer
const Data = require('../utils/dataLayer');
const { logActivity } = require('../utils/activityLogger');

// Import middleware
const { auth, adminAuth, superAdminAuth, optionalAuth } = require('../middleware/auth');

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'ladybugnodes-secret-change-me';

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

const generateToken = (user) => {
    return jwt.sign(
        { id: user.id || user._id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
};

const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    next();
};

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   POST /api/v2/auth/register
// @desc    Register new user
// @access  Public (or admin-only based on settings)
router.post('/auth/register', [
    body('username').trim().isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 characters'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('email').optional().isEmail().withMessage('Invalid email'),
    body('phone').optional().isMobilePhone().withMessage('Invalid phone number')
], validateRequest, async (req, res) => {
    try {
        const { username, password, email, phone, referralCode } = req.body;

        // Check if user exists
        const existingUser = await Data.User.findByUsername(username);
        if (existingUser) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        // Check email if provided
        if (email) {
            const existingEmail = await Data.User.findByEmail(email);
            if (existingEmail) {
                return res.status(400).json({ error: 'Email already registered' });
            }
        }

        // Check phone if provided
        if (phone) {
            const existingPhone = await Data.User.findByPhone(phone);
            if (existingPhone) {
                return res.status(400).json({ error: 'Phone already registered' });
            }
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Create user
        const userData = {
            username,
            password: hashedPassword,
            email: email || undefined,
            phone: phone || undefined,
            role: 'user',
            coins: 100, // Starting coins
            subscription: {
                plan: 'free',
                status: 'active'
            },
            isVerified: false,
            isActive: true
        };

        // Handle referral
        if (referralCode) {
            const referrer = await Data.User.findById(referralCode);
            if (referrer) {
                userData.referredBy = referralCode;
                userData.coins += 50; // Referral bonus
                // Update referrer's coins
                await Data.User.updateById(referralCode, {
                    $inc: { coins: 50 },
                    $push: { referrals: { userId: null, username, date: new Date() } }
                });
            }
        }

        const user = await Data.User.create(userData);

        // Log activity
        await Data.Activity.log(user.id, 'user_registered', { username });

        // Generate token
        const token = generateToken(user);

        res.status(201).json({
            success: true,
            token,
            user: {
                id: user.id || user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                coins: user.coins,
                subscription: user.subscription
            }
        });
    } catch (error) {
        console.error('[Register Error]', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// @route   POST /api/v2/auth/login
// @desc    Login user
// @access  Public
router.post('/auth/login', [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required')
], validateRequest, async (req, res) => {
    try {
        const { username, password } = req.body;

        // Find user
        const user = await Data.User.findByUsername(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if user is active
        if (user.isActive === false) {
            return res.status(403).json({ error: 'Account is disabled' });
        }

        // Verify password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        await Data.User.updateById(user.id || user._id, {
            lastLogin: new Date(),
            loginCount: (user.loginCount || 0) + 1
        });

        // Log activity
        await Data.Activity.log(user.id || user._id, 'user_login', { username });

        // Generate token
        const token = generateToken(user);

        res.json({
            success: true,
            token,
            user: {
                id: user.id || user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                coins: user.coins,
                subscription: user.subscription,
                settings: user.settings
            }
        });
    } catch (error) {
        console.error('[Login Error]', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// @route   GET /api/v2/auth/me
// @desc    Get current user
// @access  Private
router.get('/auth/me', auth, async (req, res) => {
    try {
        const user = await Data.User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            id: user.id || user._id,
            username: user.username,
            email: user.email,
            phone: user.phone,
            role: user.role,
            coins: user.coins,
            subscription: user.subscription,
            settings: user.settings,
            referralCode: user.referralCode,
            apiKeys: user.apiKeys?.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt })),
            isVerified: user.isVerified,
            twoFactorEnabled: user.twoFactorEnabled,
            createdAt: user.createdAt
        });
    } catch (error) {
        console.error('[Get Me Error]', error);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// @route   PUT /api/v2/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/auth/profile', auth, [
    body('email').optional().isEmail(),
    body('phone').optional().isMobilePhone()
], validateRequest, async (req, res) => {
    try {
        const { email, phone, settings } = req.body;
        const updateData = {};

        if (email) {
            const existing = await Data.User.findByEmail(email);
            if (existing && (existing.id || existing._id) !== req.user.id) {
                return res.status(400).json({ error: 'Email already in use' });
            }
            updateData.email = email;
        }

        if (phone) {
            const existing = await Data.User.findByPhone(phone);
            if (existing && (existing.id || existing._id) !== req.user.id) {
                return res.status(400).json({ error: 'Phone already in use' });
            }
            updateData.phone = phone;
        }

        if (settings) {
            updateData.settings = { ...req.user.settings, ...settings };
        }

        const user = await Data.User.updateById(req.user.id, updateData);
        res.json({ success: true, user });
    } catch (error) {
        console.error('[Update Profile Error]', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// @route   POST /api/v2/auth/change-password
// @desc    Change password
// @access  Private
router.post('/auth/change-password', auth, [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 6 })
], validateRequest, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        const user = await Data.User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await Data.User.updateById(req.user.id, { password: hashedPassword });
        await Data.Activity.log(req.user.id, 'password_changed');

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        console.error('[Change Password Error]', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/users
// @desc    Get all users (admin only)
// @access  Admin
router.get('/users', adminAuth, async (req, res) => {
    try {
        const { page = 1, limit = 20, search, role } = req.query;
        const filter = {};

        if (role) filter.role = role;
        if (search) {
            filter.$or = [
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        const users = await Data.User.findAll({
            filter,
            limit: parseInt(limit),
            skip: (parseInt(page) - 1) * parseInt(limit),
            sort: { createdAt: -1 }
        });

        const total = await Data.User.count(filter);

        res.json({
            users: users.map(u => ({
                id: u.id || u._id,
                username: u.username,
                email: u.email,
                role: u.role,
                coins: u.coins,
                isActive: u.isActive,
                isVerified: u.isVerified,
                subscription: u.subscription,
                createdAt: u.createdAt,
                lastLogin: u.lastLogin
            })),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('[Get Users Error]', error);
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// @route   PUT /api/v2/users/:id
// @desc    Update user (admin only)
// @access  Admin
router.put('/users/:id', adminAuth, async (req, res) => {
    try {
        const { role, coins, isActive, subscription } = req.body;
        const updateData = {};

        if (role) updateData.role = role;
        if (coins !== undefined) updateData.coins = coins;
        if (isActive !== undefined) updateData.isActive = isActive;
        if (subscription) updateData.subscription = subscription;

        const user = await Data.User.updateById(req.params.id, updateData);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        await Data.Activity.log(req.user.id, 'admin_updated_user', {
            targetUser: req.params.id,
            changes: updateData
        });

        res.json({ success: true, user });
    } catch (error) {
        console.error('[Update User Error]', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// @route   DELETE /api/v2/users/:id
// @desc    Delete user (superadmin only)
// @access  SuperAdmin
router.delete('/users/:id', superAdminAuth, async (req, res) => {
    try {
        const success = await Data.User.deleteById(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'User not found' });
        }

        await Data.Activity.log(req.user.id, 'admin_deleted_user', {
            targetUser: req.params.id
        });

        res.json({ success: true, message: 'User deleted' });
    } catch (error) {
        console.error('[Delete User Error]', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// SESSION ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/sessions
// @desc    Get user's sessions
// @access  Private
router.get('/sessions', auth, async (req, res) => {
    try {
        const sessions = await Data.Session.findByOwner(req.user.id);
        res.json(sessions);
    } catch (error) {
        console.error('[Get Sessions Error]', error);
        res.status(500).json({ error: 'Failed to get sessions' });
    }
});

// @route   POST /api/v2/sessions
// @desc    Create new session
// @access  Private
router.post('/sessions', auth, async (req, res) => {
    try {
        const { name, host, description } = req.body;

        const sessionData = {
            sessionId: uuidv4(),
            name: name || `Session-${Date.now()}`,
            host: host || 'default',
            description,
            owner: req.user.id,
            status: 'pending',
            autoRestart: true,
            createdAt: new Date()
        };

        const session = await Data.Session.create(sessionData);

        await Data.Activity.log(req.user.id, 'session_created', {
            sessionId: session.sessionId,
            name: session.name
        });

        res.status(201).json(session);
    } catch (error) {
        console.error('[Create Session Error]', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// @route   PUT /api/v2/sessions/:id
// @desc    Update session
// @access  Private
router.put('/sessions/:id', auth, async (req, res) => {
    try {
        const { name, autoRestart, config } = req.body;
        const updateData = {};

        if (name) updateData.name = name;
        if (autoRestart !== undefined) updateData.autoRestart = autoRestart;
        if (config) updateData.config = config;

        const session = await Data.Session.updateById(req.params.id, updateData);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(session);
    } catch (error) {
        console.error('[Update Session Error]', error);
        res.status(500).json({ error: 'Failed to update session' });
    }
});

// @route   DELETE /api/v2/sessions/:id
// @desc    Delete session
// @access  Private
router.delete('/sessions/:id', auth, async (req, res) => {
    try {
        const success = await Data.Session.deleteById(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'Session not found' });
        }

        await Data.Activity.log(req.user.id, 'session_deleted', {
            sessionId: req.params.id
        });

        res.json({ success: true });
    } catch (error) {
        console.error('[Delete Session Error]', error);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// BOT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/bots
// @desc    Get user's bots
// @access  Private
router.get('/bots', auth, async (req, res) => {
    try {
        const bots = await Data.Bot.findByOwner(req.user.id);
        res.json(bots);
    } catch (error) {
        console.error('[Get Bots Error]', error);
        res.status(500).json({ error: 'Failed to get bots' });
    }
});

// @route   POST /api/v2/bots
// @desc    Create new bot
// @access  Private
router.post('/bots', auth, async (req, res) => {
    try {
        const { name, description, entryPoint } = req.body;

        const botData = {
            botId: uuidv4(),
            name,
            description,
            entryPoint: entryPoint || 'index.js',
            owner: req.user.id,
            status: 'stopped',
            createdAt: new Date()
        };

        const bot = await Data.Bot.create(botData);

        await Data.Activity.log(req.user.id, 'bot_created', {
            botId: bot.botId,
            name: bot.name
        });

        res.status(201).json(bot);
    } catch (error) {
        console.error('[Create Bot Error]', error);
        res.status(500).json({ error: 'Failed to create bot' });
    }
});

// @route   PUT /api/v2/bots/:id
// @desc    Update bot
// @access  Private
router.put('/bots/:id', auth, async (req, res) => {
    try {
        const { name, description, autoRestart, webhooks } = req.body;
        const updateData = {};

        if (name) updateData.name = name;
        if (description) updateData.description = description;
        if (autoRestart !== undefined) updateData.autoRestart = autoRestart;
        if (webhooks) updateData.webhooks = webhooks;

        const bot = await Data.Bot.updateById(req.params.id, updateData);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        res.json(bot);
    } catch (error) {
        console.error('[Update Bot Error]', error);
        res.status(500).json({ error: 'Failed to update bot' });
    }
});

// @route   DELETE /api/v2/bots/:id
// @desc    Delete bot
// @access  Private
router.delete('/bots/:id', auth, async (req, res) => {
    try {
        const success = await Data.Bot.deleteById(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        await Data.Activity.log(req.user.id, 'bot_deleted', {
            botId: req.params.id
        });

        res.json({ success: true });
    } catch (error) {
        console.error('[Delete Bot Error]', error);
        res.status(500).json({ error: 'Failed to delete bot' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRANSACTION ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/transactions
// @desc    Get user's transactions
// @access  Private
router.get('/transactions', auth, async (req, res) => {
    try {
        const transactions = await Data.Transaction.findByUser(req.user.id, 50);
        const balance = await Data.Transaction.getBalance(req.user.id);

        res.json({
            balance,
            transactions
        });
    } catch (error) {
        console.error('[Get Transactions Error]', error);
        res.status(500).json({ error: 'Failed to get transactions' });
    }
});

// @route   POST /api/v2/transactions/transfer
// @desc    Transfer coins to another user
// @access  Private
router.post('/transactions/transfer', auth, [
    body('toUser').notEmpty(),
    body('amount').isInt({ min: 1 })
], validateRequest, async (req, res) => {
    try {
        const { toUser, amount, description } = req.body;

        const transaction = await Data.Transaction.transfer(
            req.user.id,
            toUser,
            amount,
            description || 'Transfer'
        );

        await Data.Activity.log(req.user.id, 'coins_transferred', {
            toUser,
            amount
        });

        res.json({ success: true, transaction });
    } catch (error) {
        console.error('[Transfer Error]', error);
        res.status(400).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/notifications
// @desc    Get user's notifications
// @access  Private
router.get('/notifications', auth, async (req, res) => {
    try {
        const notifications = await Data.Notification.findByUser(req.user.id, 20);
        const unreadCount = await Data.Notification.getUnreadCount(req.user.id);

        res.json({
            notifications,
            unreadCount
        });
    } catch (error) {
        console.error('[Get Notifications Error]', error);
        res.status(500).json({ error: 'Failed to get notifications' });
    }
});

// @route   POST /api/v2/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.post('/notifications/:id/read', auth, async (req, res) => {
    try {
        await Data.Notification.markAsRead(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[Mark Notification Error]', error);
        res.status(500).json({ error: 'Failed to mark notification' });
    }
});

// @route   POST /api/v2/notifications/read-all
// @desc    Mark all notifications as read
// @access  Private
router.post('/notifications/read-all', auth, async (req, res) => {
    try {
        await Data.Notification.markAllAsRead(req.user.id);
        res.json({ success: true });
    } catch (error) {
        console.error('[Mark All Notifications Error]', error);
        res.status(500).json({ error: 'Failed to mark notifications' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/webhooks
// @desc    Get user's webhooks
// @access  Private
router.get('/webhooks', auth, async (req, res) => {
    try {
        const webhooks = await Data.Webhook.findByUser(req.user.id);
        res.json(webhooks);
    } catch (error) {
        console.error('[Get Webhooks Error]', error);
        res.status(500).json({ error: 'Failed to get webhooks' });
    }
});

// @route   POST /api/v2/webhooks
// @desc    Create webhook
// @access  Private
router.post('/webhooks', auth, [
    body('url').isURL(),
    body('events').isArray({ min: 1 })
], validateRequest, async (req, res) => {
    try {
        const { url, events, secret } = req.body;

        const webhook = await Data.Webhook.create({
            owner: req.user.id,
            url,
            events,
            secret,
            active: true
        });

        await Data.Activity.log(req.user.id, 'webhook_created', {
            webhookId: webhook.id || webhook._id,
            events
        });

        res.status(201).json(webhook);
    } catch (error) {
        console.error('[Create Webhook Error]', error);
        res.status(500).json({ error: 'Failed to create webhook' });
    }
});

// @route   DELETE /api/v2/webhooks/:id
// @desc    Delete webhook
// @access  Private
router.delete('/webhooks/:id', auth, async (req, res) => {
    try {
        const success = await Data.Webhook.deleteById(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'Webhook not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Delete Webhook Error]', error);
        res.status(500).json({ error: 'Failed to delete webhook' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVITY ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/activity
// @desc    Get user's activity log
// @access  Private
router.get('/activity', auth, async (req, res) => {
    try {
        const activities = await Data.Activity.findByUser(req.user.id, 50);
        res.json(activities);
    } catch (error) {
        console.error('[Get Activity Error]', error);
        res.status(500).json({ error: 'Failed to get activity' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// @route   GET /api/v2/admin/stats
// @desc    Get admin statistics
// @access  Admin
router.get('/admin/stats', adminAuth, async (req, res) => {
    try {
        const stats = {
            users: {
                total: await Data.User.count(),
                active: await Data.User.count({ isActive: true }),
                verified: await Data.User.count({ isVerified: true })
            },
            sessions: {
                total: await Data.Session.count(),
                active: await Data.Session.count({ status: 'connected' })
            },
            bots: {
                total: await Data.Bot.count(),
                running: await Data.Bot.count({ status: 'running' })
            },
            recentActivity: await Data.Activity.getRecent(10)
        };

        res.json(stats);
    } catch (error) {
        console.error('[Get Admin Stats Error]', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// @route   GET /api/v2/admin/activity
// @desc    Get all activity (admin)
// @access  Admin
router.get('/admin/activity', adminAuth, async (req, res) => {
    try {
        const activities = await Data.Activity.getRecent(100);
        res.json(activities);
    } catch (error) {
        console.error('[Get Admin Activity Error]', error);
        res.status(500).json({ error: 'Failed to get activity' });
    }
});

module.exports = router;