/**
 * LADYBUGNODES V7.1 - Coin Reward System
 * 2 coins per day with WhatsApp channel follow verification
 */

const mongoose = require('mongoose');

// Coin Transaction Schema
const coinTransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
        type: String,
        enum: ['daily_reward', 'referral_bonus', 'purchase', 'bot_hosting', 'admin_grant', 'penalty'],
        required: true
    },
    amount: { type: Number, required: true },
    balance: { type: Number, required: true }, // Balance after transaction
    description: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now }
});

// WhatsApp Follow Verification Schema
const whatsappFollowSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    phoneNumber: { type: String, required: true },
    verifiedAt: { type: Date },
    verificationCode: { type: String },
    codeExpires: { type: Date },
    status: {
        type: String,
        enum: ['pending', 'verified', 'expired'],
        default: 'pending'
    },
    followedAt: { type: Date }
});

// Daily Reward Claim Schema
const dailyRewardSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    claimedAt: { type: Date, default: Date.now },
    coinsAwarded: { type: Number, default: 2 },
    streak: { type: Number, default: 1 }
});

// Create indexes
coinTransactionSchema.index({ userId: 1, createdAt: -1 });
whatsappFollowSchema.index({ userId: 1 });
dailyRewardSchema.index({ userId: 1, claimedAt: -1 });

const CoinTransaction = mongoose.models.CoinTransaction || mongoose.model('CoinTransaction', coinTransactionSchema);
const WhatsAppFollow = mongoose.models.WhatsAppFollow || mongoose.model('WhatsAppFollow', whatsappFollowSchema);
const DailyReward = mongoose.models.DailyReward || mongoose.model('DailyReward', dailyRewardSchema);

// WhatsApp Channel Configuration
const WHATSAPP_CHANNEL = {
    name: 'LADYBUGNODES Official',
    link: 'https://whatsapp.com/channel/0029VaYRbeAJ3jaHqQrJir3O',
    inviteLink: 'https://whatsapp.com/channel/0029VaYRbeAJ3jaHqQrJir3O',
    verificationPrefix: 'LADYBUG'
};

// Coin Reward Configuration
const COIN_CONFIG = {
    dailyReward: 2,
    referralBonus: 5,
    streakBonus: {
        7: 3,   // 7 day streak: +3 bonus
        14: 5,  // 14 day streak: +5 bonus
        30: 10  // 30 day streak: +10 bonus
    },
    hostingCost: {
        whatsapp: 1,    // coins per day
        telegram: 0.5,
        discord: 0.5,
        slack: 0.5
    }
};

class CoinRewardSystem {
    constructor() {
        this.initialized = false;
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        console.log('[CoinRewards] System initialized (2 coins/day)');
    }

    /**
     * Initiate WhatsApp channel follow verification
     */
    async initiateFollowVerification(userId, phoneNumber) {
        try {
            // Check if already verified
            const existing = await WhatsAppFollow.findOne({ userId });
            if (existing && existing.status === 'verified') {
                return { success: true, alreadyVerified: true, message: 'Already verified!' };
            }

            // Generate verification code
            const verificationCode = `${WHATSAPP_CHANNEL.verificationPrefix}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
            const codeExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

            // Create or update verification record
            await WhatsAppFollow.findOneAndUpdate(
                { userId },
                {
                    userId,
                    phoneNumber,
                    verificationCode,
                    codeExpires,
                    status: 'pending'
                },
                { upsert: true, new: true }
            );

            return {
                success: true,
                verificationCode,
                channelLink: WHATSAPP_CHANNEL.inviteLink,
                channelName: WHATSAPP_CHANNEL.name,
                instructions: [
                    `1. Join our WhatsApp channel: ${WHATSAPP_CHANNEL.inviteLink}`,
                    `2. Send the code "${verificationCode}" to the channel`,
                    `3. Click "Verify" below to claim your verification`,
                    `Note: Code expires in 30 minutes`
                ],
                expiresIn: 30 * 60 * 1000
            };
        } catch (error) {
            console.error('[CoinRewards] Verification initiation error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Complete WhatsApp channel follow verification
     */
    async completeFollowVerification(userId) {
        try {
            const follow = await WhatsAppFollow.findOne({ userId });
            
            if (!follow) {
                return { success: false, error: 'No verification pending' };
            }

            if (follow.status === 'verified') {
                return { success: true, alreadyVerified: true };
            }

            if (follow.codeExpires < new Date()) {
                follow.status = 'expired';
                await follow.save();
                return { success: false, error: 'Verification code expired', expired: true };
            }

            // Mark as verified
            follow.status = 'verified';
            follow.verifiedAt = new Date();
            await follow.save();

            // Award welcome bonus
            const user = await mongoose.models.User.findById(userId);
            if (user) {
                user.coins = (user.coins || 0) + 5; // Welcome bonus
                await user.save();

                await this.recordTransaction(userId, 'daily_reward', 5, 'Welcome bonus for following WhatsApp channel');
            }

            return {
                success: true,
                message: 'WhatsApp channel verified! You received 5 bonus coins!',
                welcomeBonus: 5
            };
        } catch (error) {
            console.error('[CoinRewards] Verification completion error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if user has verified WhatsApp channel follow
     */
    async isFollowVerified(userId) {
        try {
            const follow = await WhatsAppFollow.findOne({ userId });
            return follow && follow.status === 'verified';
        } catch (error) {
            return false;
        }
    }

    /**
     * Claim daily coin reward (requires WhatsApp follow verification)
     */
    async claimDailyReward(userId) {
        try {
            // Check WhatsApp follow verification
            const isVerified = await this.isFollowVerified(userId);
            if (!isVerified) {
                return {
                    success: false,
                    requiresVerification: true,
                    message: 'Please follow our WhatsApp channel first to claim daily rewards',
                    channelLink: WHATSAPP_CHANNEL.inviteLink
                };
            }

            // Check if already claimed today
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const existingClaim = await DailyReward.findOne({
                userId,
                claimedAt: { $gte: today }
            });

            if (existingClaim) {
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                return {
                    success: false,
                    alreadyClaimed: true,
                    message: 'Daily reward already claimed',
                    nextClaimAt: tomorrow
                };
            }

            // Calculate streak
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            const lastReward = await DailyReward.findOne({
                userId,
                claimedAt: { $lt: today, $gte: yesterday }
            }).sort({ claimedAt: -1 });

            const streak = lastReward ? lastReward.streak + 1 : 1;

            // Calculate bonus
            let bonus = 0;
            let bonusReason = '';
            if (streak >= 30) {
                bonus = COIN_CONFIG.streakBonus[30];
                bonusReason = '30-day streak bonus!';
            } else if (streak >= 14) {
                bonus = COIN_CONFIG.streakBonus[14];
                bonusReason = '14-day streak bonus!';
            } else if (streak >= 7) {
                bonus = COIN_CONFIG.streakBonus[7];
                bonusReason = '7-day streak bonus!';
            }

            const totalCoins = COIN_CONFIG.dailyReward + bonus;

            // Record claim
            await DailyReward.create({
                userId,
                coinsAwarded: totalCoins,
                streak
            });

            // Update user balance
            const user = await mongoose.models.User.findById(userId);
            if (user) {
                user.coins = (user.coins || 0) + totalCoins;
                await user.save();

                await this.recordTransaction(userId, 'daily_reward', totalCoins, 
                    `Daily reward${bonus > 0 ? ` + ${bonusReason}` : ''}`);
            }

            return {
                success: true,
                coinsAwarded: totalCoins,
                baseReward: COIN_CONFIG.dailyReward,
                bonus,
                bonusReason,
                streak,
                newBalance: user?.coins || 0,
                message: `You received ${totalCoins} coins!${bonus > 0 ? ` (${bonusReason})` : ''}`
            };
        } catch (error) {
            console.error('[CoinRewards] Daily claim error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get user's coin balance
     */
    async getBalance(userId) {
        try {
            const user = await mongoose.models.User.findById(userId);
            return {
                success: true,
                balance: user?.coins || 0,
                canClaimDaily: await this.canClaimDaily(userId)
            };
        } catch (error) {
            return { success: false, error: error.message, balance: 0 };
        }
    }

    /**
     * Check if user can claim daily reward
     */
    async canClaimDaily(userId) {
        try {
            const isVerified = await this.isFollowVerified(userId);
            if (!isVerified) return { canClaim: false, reason: 'not_verified' };

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const existingClaim = await DailyReward.findOne({
                userId,
                claimedAt: { $gte: today }
            });

            if (existingClaim) {
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                return {
                    canClaim: false,
                    reason: 'already_claimed',
                    nextClaimAt: tomorrow
                };
            }

            // Get streak info
            const lastReward = await DailyReward.findOne({ userId }).sort({ claimedAt: -1 });
            const currentStreak = lastReward?.streak || 0;

            return {
                canClaim: true,
                currentStreak,
                dailyReward: COIN_CONFIG.dailyReward
            };
        } catch (error) {
            return { canClaim: false, reason: 'error', error: error.message };
        }
    }

    /**
     * Record a coin transaction
     */
    async recordTransaction(userId, type, amount, description = '', metadata = {}) {
        try {
            const user = await mongoose.models.User.findById(userId);
            const balance = user?.coins || 0;

            await CoinTransaction.create({
                userId,
                type,
                amount,
                balance,
                description,
                metadata
            });

            return { success: true };
        } catch (error) {
            console.error('[CoinRewards] Transaction record error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get transaction history
     */
    async getTransactionHistory(userId, limit = 50) {
        try {
            const transactions = await CoinTransaction.find({ userId })
                .sort({ createdAt: -1 })
                .limit(limit);

            return {
                success: true,
                transactions
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Spend coins
     */
    async spendCoins(userId, amount, description = '') {
        try {
            const user = await mongoose.models.User.findById(userId);
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            if ((user.coins || 0) < amount) {
                return {
                    success: false,
                    error: 'Insufficient coins',
                    required: amount,
                    available: user.coins || 0
                };
            }

            user.coins -= amount;
            await user.save();

            await this.recordTransaction(userId, 'bot_hosting', -amount, description);

            return {
                success: true,
                newBalance: user.coins,
                spent: amount
            };
        } catch (error) {
            console.error('[CoinRewards] Spend error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Add coins (admin or bonus)
     */
    async addCoins(userId, amount, description = '', type = 'admin_grant') {
        try {
            const user = await mongoose.models.User.findById(userId);
            if (!user) {
                return { success: false, error: 'User not found' };
            }

            user.coins = (user.coins || 0) + amount;
            await user.save();

            await this.recordTransaction(userId, type, amount, description);

            return {
                success: true,
                newBalance: user.coins,
                added: amount
            };
        } catch (error) {
            console.error('[CoinRewards] Add coins error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get streak information
     */
    async getStreakInfo(userId) {
        try {
            const lastReward = await DailyReward.findOne({ userId }).sort({ claimedAt: -1 });
            
            if (!lastReward) {
                return { streak: 0, nextBonus: 7, nextBonusAmount: COIN_CONFIG.streakBonus[7] };
            }

            // Check if streak is broken (missed a day)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            const lastClaimDate = new Date(lastReward.claimedAt);
            lastClaimDate.setHours(0, 0, 0, 0);

            let currentStreak = lastReward.streak;

            // If last claim was before yesterday, streak is broken
            if (lastClaimDate < yesterday) {
                currentStreak = 0;
            }

            // Find next bonus milestone
            let nextBonus = 7;
            if (currentStreak >= 30) nextBonus = 60;
            else if (currentStreak >= 14) nextBonus = 30;
            else if (currentStreak >= 7) nextBonus = 14;

            return {
                streak: currentStreak,
                nextBonus,
                nextBonusAmount: COIN_CONFIG.streakBonus[nextBonus] || 0,
                milestones: COIN_CONFIG.streakBonus
            };
        } catch (error) {
            return { streak: 0, error: error.message };
        }
    }

    /**
     * Get leaderboard
     */
    async getLeaderboard(type = 'coins', limit = 10) {
        try {
            if (type === 'coins') {
                const users = await mongoose.models.User.find({ coins: { $gt: 0 } })
                    .sort({ coins: -1 })
                    .limit(limit)
                    .select('username coins avatar');

                return { success: true, leaderboard: users };
            } else if (type === 'streak') {
                const streaks = await DailyReward.aggregate([
                    { $sort: { streak: -1, claimedAt: -1 } },
                    { $group: { _id: '$userId', maxStreak: { $max: '$streak' }, lastClaim: { $first: '$claimedAt' } } },
                    { $sort: { maxStreak: -1 } },
                    { $limit: limit }
                ]);

                // Populate user data
                const userIds = streaks.map(s => s._id);
                const users = await mongoose.models.User.find({ _id: { $in: userIds } })
                    .select('username avatar');

                const leaderboard = streaks.map(s => ({
                    ...s,
                    user: users.find(u => u._id.toString() === s._id.toString())
                }));

                return { success: true, leaderboard };
            }

            return { success: false, error: 'Invalid leaderboard type' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
const coinRewardSystem = new CoinRewardSystem();

module.exports = {
    CoinRewardSystem,
    coinRewardSystem,
    CoinTransaction,
    WhatsAppFollow,
    DailyReward,
    COIN_CONFIG,
    WHATSAPP_CHANNEL
};