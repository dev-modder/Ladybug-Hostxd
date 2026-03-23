/**
 * LADYBUGNODES V7.1 - Coin Rewards API Routes
 */

const express = require('express');
const router = express.Router();
const { coinRewardSystem, WHATSAPP_CHANNEL, COIN_CONFIG } = require('../utils/coinRewards');
const { auth } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(auth);

/**
 * @route   GET /api/coins/balance
 * @desc    Get user's coin balance
 * @access  Private
 */
router.get('/balance', async (req, res) => {
    try {
        const result = await coinRewardSystem.getBalance(req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/coins/config
 * @desc    Get coin system configuration
 * @access  Public
 */
router.get('/config', (req, res) => {
    res.json({
        success: true,
        config: {
            dailyReward: COIN_CONFIG.dailyReward,
            referralBonus: COIN_CONFIG.referralBonus,
            streakBonus: COIN_CONFIG.streakBonus,
            hostingCost: COIN_CONFIG.hostingCost
        },
        whatsappChannel: {
            name: WHATSAPP_CHANNEL.name,
            link: WHATSAPP_CHANNEL.link
        }
    });
});

/**
 * @route   POST /api/coins/verify/initiate
 * @desc    Initiate WhatsApp channel follow verification
 * @access  Private
 */
router.post('/verify/initiate', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                error: 'Phone number required' 
            });
        }

        const result = await coinRewardSystem.initiateFollowVerification(
            req.user.id, 
            phoneNumber
        );
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/coins/verify/complete
 * @desc    Complete WhatsApp channel follow verification
 * @access  Private
 */
router.post('/verify/complete', async (req, res) => {
    try {
        const result = await coinRewardSystem.completeFollowVerification(req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/coins/verify/status
 * @desc    Check WhatsApp verification status
 * @access  Private
 */
router.get('/verify/status', async (req, res) => {
    try {
        const isVerified = await coinRewardSystem.isFollowVerified(req.user.id);
        res.json({
            success: true,
            isVerified,
            channelLink: WHATSAPP_CHANNEL.link,
            channelName: WHATSAPP_CHANNEL.name
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/coins/claim
 * @desc    Claim daily coin reward
 * @access  Private
 */
router.post('/claim', async (req, res) => {
    try {
        const result = await coinRewardSystem.claimDailyReward(req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/coins/can-claim
 * @desc    Check if user can claim daily reward
 * @access  Private
 */
router.get('/can-claim', async (req, res) => {
    try {
        const result = await coinRewardSystem.canClaimDaily(req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/coins/streak
 * @desc    Get user's streak information
 * @access  Private
 */
router.get('/streak', async (req, res) => {
    try {
        const result = await coinRewardSystem.getStreakInfo(req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/coins/history
 * @desc    Get transaction history
 * @access  Private
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const result = await coinRewardSystem.getTransactionHistory(req.user.id, limit);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/coins/leaderboard
 * @desc    Get coin leaderboard
 * @access  Public
 */
router.get('/leaderboard', async (req, res) => {
    try {
        const type = req.query.type || 'coins';
        const limit = parseInt(req.query.limit) || 10;
        const result = await coinRewardSystem.getLeaderboard(type, limit);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/coins/spend
 * @desc    Spend coins
 * @access  Private
 */
router.post('/spend', async (req, res) => {
    try {
        const { amount, description } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Valid amount required' 
            });
        }

        const result = await coinRewardSystem.spendCoins(
            req.user.id, 
            amount, 
            description || 'Spent coins'
        );
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin routes
const adminCheck = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
};

/**
 * @route   POST /api/coins/admin/grant
 * @desc    Grant coins to user (admin only)
 * @access  Admin
 */
router.post('/admin/grant', adminCheck, async (req, res) => {
    try {
        const { userId, amount, description } = req.body;
        
        if (!userId || !amount || amount <= 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'User ID and valid amount required' 
            });
        }

        const result = await coinRewardSystem.addCoins(
            userId, 
            amount, 
            description || 'Admin grant',
            'admin_grant'
        );
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/coins/admin/stats
 * @desc    Get coin system statistics (admin only)
 * @access  Admin
 */
router.get('/admin/stats', adminCheck, async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const { CoinTransaction, DailyReward, WhatsAppFollow } = require('../utils/coinRewards');
        
        const totalTransactions = await CoinTransaction.countDocuments();
        const totalDailyClaims = await DailyReward.countDocuments();
        const totalVerified = await WhatsAppFollow.countDocuments({ status: 'verified' });
        
        const totalCoinsInCirculation = await mongoose.models.User.aggregate([
            { $group: { _id: null, total: { $sum: '$coins' } } }
        ]);

        res.json({
            success: true,
            stats: {
                totalTransactions,
                totalDailyClaims,
                totalVerifiedFollows: totalVerified,
                totalCoinsInCirculation: totalCoinsInCirculation[0]?.total || 0
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;