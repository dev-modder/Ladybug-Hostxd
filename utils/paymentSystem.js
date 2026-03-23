'use strict';

/**
 * Payment System for LADYBUGNODES V(7)
 * Supports ZiG (Zimbabwe Gold) and USD payments
 * Bot hosting is paid only
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Currency types
const Currency = {
    ZIG: 'ZiG',
    USD: 'USD'
};

// Exchange rates (update these based on current rates)
const ExchangeRates = {
    ZIG_TO_USD: 0.031,  // 1 ZiG = 0.031 USD (approximate)
    USD_TO_ZIG: 32.25   // 1 USD = 32.25 ZiG (approximate)
};

// Payment plans
const PaymentPlans = {
    STARTER: {
        id: 'starter',
        name: 'Starter Plan',
        description: 'Perfect for beginners',
        priceUSD: 5.00,
        priceZiG: 161.25,
        features: {
            maxBots: 2,
            maxUptime: 24, // hours per day
            storage: 100, // MB
            support: 'email',
            autoRestart: true,
            logs: true,
            sessionImport: true
        },
        duration: 30 // days
    },
    PRO: {
        id: 'pro',
        name: 'Pro Plan',
        description: 'For serious bot developers',
        priceUSD: 15.00,
        priceZiG: 483.75,
        features: {
            maxBots: 10,
            maxUptime: 24, // hours per day
            storage: 500, // MB
            support: 'priority',
            autoRestart: true,
            logs: true,
            sessionImport: true,
            advancedLogs: true,
            bulkOperations: true,
            apiAccess: true
        },
        duration: 30 // days
    },
    ENTERPRISE: {
        id: 'enterprise',
        name: 'Enterprise Plan',
        description: 'For businesses and teams',
        priceUSD: 50.00,
        priceZiG: 1612.50,
        features: {
            maxBots: 50,
            maxUptime: 24, // hours per day
            storage: 5000, // MB
            support: 'dedicated',
            autoRestart: true,
            logs: true,
            sessionImport: true,
            advancedLogs: true,
            bulkOperations: true,
            apiAccess: true,
            customBot: true,
            whiteLabel: true,
            priorityProcessing: true
        },
        duration: 30 // days
    },
    UNLIMITED: {
        id: 'unlimited',
        name: 'Unlimited Plan',
        description: 'No limits, maximum power',
        priceUSD: 100.00,
        priceZiG: 3225.00,
        features: {
            maxBots: -1, // unlimited
            maxUptime: 24, // hours per day
            storage: -1, // unlimited
            support: 'vip',
            autoRestart: true,
            logs: true,
            sessionImport: true,
            advancedLogs: true,
            bulkOperations: true,
            apiAccess: true,
            customBot: true,
            whiteLabel: true,
            priorityProcessing: true,
            dedicatedServer: true
        },
        duration: 30 // days
    }
};

// Payment status
const PaymentStatus = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    REFUNDED: 'refunded',
    CANCELLED: 'cancelled'
};

// Payment methods
const PaymentMethods = {
    ZIG_MOBILE: 'zig_mobile',
    ZIG_BANK: 'zig_bank',
    USD_PAYPAL: 'usd_paypal',
    USD_STRIPE: 'usd_stripe',
    USD_BANK: 'usd_bank',
    MANUAL: 'manual'
};

/**
 * Payment Manager Class
 */
class PaymentManager {
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
        this.paymentsFile = path.join(this.dataDir, 'payments.json');
        this.subscriptionsFile = path.join(this.dataDir, 'subscriptions.json');
        this.plans = PaymentPlans;
        
        this._ensureDataDir();
    }

    _ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Get all available plans
     */
    getPlans() {
        return Object.values(this.plans).map(plan => ({
            id: plan.id,
            name: plan.name,
            description: plan.description,
            pricing: {
                usd: plan.priceUSD,
                zig: plan.priceZiG
            },
            features: plan.features,
            duration: plan.duration
        }));
    }

    /**
     * Get a specific plan
     */
    getPlan(planId) {
        return this.plans[planId.toUpperCase()] || null;
    }

    /**
     * Convert currency
     */
    convertCurrency(amount, fromCurrency, toCurrency) {
        fromCurrency = fromCurrency.toUpperCase();
        toCurrency = toCurrency.toUpperCase();

        if (fromCurrency === toCurrency) return amount;

        if (fromCurrency === 'ZIG' && toCurrency === 'USD') {
            return amount * ExchangeRates.ZIG_TO_USD;
        } else if (fromCurrency === 'USD' && toCurrency === 'ZIG') {
            return amount * ExchangeRates.USD_TO_ZIG;
        }

        throw new Error(`Unsupported currency conversion: ${fromCurrency} to ${toCurrency}`);
    }

    /**
     * Create a payment record
     */
    createPayment(options) {
        const payments = this._loadPayments();
        
        const payment = {
            id: uuidv4(),
            userId: options.userId,
            planId: options.planId,
            amount: options.amount,
            currency: options.currency,
            paymentMethod: options.paymentMethod,
            status: PaymentStatus.PENDING,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: options.metadata || {},
            transactionId: null,
            receiptUrl: null
        };

        payments.push(payment);
        this._savePayments(payments);

        return payment;
    }

    /**
     * Update payment status
     */
    updatePaymentStatus(paymentId, status, metadata = {}) {
        const payments = this._loadPayments();
        const payment = payments.find(p => p.id === paymentId);

        if (!payment) {
            throw new Error('Payment not found');
        }

        payment.status = status;
        payment.updatedAt = new Date().toISOString();
        Object.assign(payment.metadata, metadata);

        this._savePayments(payments);

        // If payment completed, create subscription
        if (status === PaymentStatus.COMPLETED) {
            this._createSubscriptionFromPayment(payment);
        }

        return payment;
    }

    /**
     * Create subscription from completed payment
     */
    _createSubscriptionFromPayment(payment) {
        const subscriptions = this._loadSubscriptions();
        const plan = this.getPlan(payment.planId);

        if (!plan) return null;

        const now = new Date();
        const endDate = new Date(now.getTime() + plan.duration * 24 * 60 * 60 * 1000);

        // Check for existing active subscription
        const existingSub = subscriptions.find(s => 
            s.userId === payment.userId && s.status === 'active'
        );

        if (existingSub) {
            // Extend existing subscription
            existingSub.endDate = new Date(new Date(existingSub.endDate).getTime() + plan.duration * 24 * 60 * 60 * 1000).toISOString();
            existingSub.planId = plan.id; // Upgrade plan
            existingSub.updatedAt = new Date().toISOString();
        } else {
            // Create new subscription
            const subscription = {
                id: uuidv4(),
                userId: payment.userId,
                planId: plan.id,
                startDate: now.toISOString(),
                endDate: endDate.toISOString(),
                status: 'active',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
                paymentId: payment.id
            };
            subscriptions.push(subscription);
        }

        this._saveSubscriptions(subscriptions);
        return subscriptions.find(s => s.userId === payment.userId && s.status === 'active');
    }

    /**
     * Get user's active subscription
     */
    getUserSubscription(userId) {
        const subscriptions = this._loadSubscriptions();
        const now = new Date();

        const subscription = subscriptions.find(s => 
            s.userId === userId && 
            s.status === 'active' && 
            new Date(s.endDate) > now
        );

        if (subscription) {
            const plan = this.getPlan(subscription.planId);
            return {
                ...subscription,
                plan,
                daysRemaining: Math.ceil((new Date(subscription.endDate) - now) / (24 * 60 * 60 * 1000))
            };
        }

        return null;
    }

    /**
     * Check if user can host bots
     */
    canUserHostBots(userId) {
        const subscription = this.getUserSubscription(userId);
        return subscription !== null;
    }

    /**
     * Get user's plan limits
     */
    getUserPlanLimits(userId) {
        const subscription = this.getUserSubscription(userId);
        
        if (!subscription) {
            return {
                canHost: false,
                maxBots: 0,
                maxUptime: 0,
                storage: 0,
                features: {}
            };
        }

        return {
            canHost: true,
            maxBots: subscription.plan.features.maxBots,
            maxUptime: subscription.plan.features.maxUptime,
            storage: subscription.plan.features.storage,
            features: subscription.plan.features,
            subscription
        };
    }

    /**
     * Get payment history for user
     */
    getUserPaymentHistory(userId) {
        const payments = this._loadPayments();
        return payments
            .filter(p => p.userId === userId)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    /**
     * Get all payments (admin)
     */
    getAllPayments() {
        const payments = this._loadPayments();
        return payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    /**
     * Get payment statistics
     */
    getPaymentStats() {
        const payments = this._loadPayments();
        
        const stats = {
            totalPayments: payments.length,
            totalRevenueUSD: 0,
            totalRevenueZiG: 0,
            byStatus: {},
            byPlan: {},
            recentPayments: payments.slice(0, 10)
        };

        for (const payment of payments) {
            if (payment.status === PaymentStatus.COMPLETED) {
                if (payment.currency === 'USD') {
                    stats.totalRevenueUSD += payment.amount;
                } else if (payment.currency === 'ZiG') {
                    stats.totalRevenueZiG += payment.amount;
                }
            }

            stats.byStatus[payment.status] = (stats.byStatus[payment.status] || 0) + 1;
            stats.byPlan[payment.planId] = (stats.byPlan[payment.planId] || 0) + 1;
        }

        return stats;
    }

    /**
     * Verify payment (for manual payments)
     */
    verifyPayment(paymentId, adminUserId, notes = '') {
        const payments = this._loadPayments();
        const payment = payments.find(p => p.id === paymentId);

        if (!payment) {
            throw new Error('Payment not found');
        }

        payment.status = PaymentStatus.COMPLETED;
        payment.updatedAt = new Date().toISOString();
        payment.verifiedBy = adminUserId;
        payment.verificationNotes = notes;

        this._savePayments(payments);
        this._createSubscriptionFromPayment(payment);

        return payment;
    }

    /**
     * Cancel subscription
     */
    cancelSubscription(userId) {
        const subscriptions = this._loadSubscriptions();
        const subscription = subscriptions.find(s => 
            s.userId === userId && s.status === 'active'
        );

        if (subscription) {
            subscription.status = 'cancelled';
            subscription.updatedAt = new Date().toISOString();
            this._saveSubscriptions(subscriptions);
        }

        return subscription;
    }

    // Data persistence methods
    _loadPayments() {
        try {
            return JSON.parse(fs.readFileSync(this.paymentsFile, 'utf8'));
        } catch {
            return [];
        }
    }

    _savePayments(payments) {
        fs.writeFileSync(this.paymentsFile, JSON.stringify(payments, null, 2));
    }

    _loadSubscriptions() {
        try {
            return JSON.parse(fs.readFileSync(this.subscriptionsFile, 'utf8'));
        } catch {
            return [];
        }
    }

    _saveSubscriptions(subscriptions) {
        fs.writeFileSync(this.subscriptionsFile, JSON.stringify(subscriptions, null, 2));
    }
}

/**
 * Check subscription middleware
 */
function requireActiveSubscription(paymentManager) {
    return async (req, res, next) => {
        try {
            const userId = req.user?.id;
            
            if (!userId) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            // Admins bypass subscription check
            if (req.user?.role === 'admin') {
                return next();
            }

            const subscription = paymentManager.getUserSubscription(userId);
            
            if (!subscription) {
                return res.status(403).json({ 
                    error: 'Active subscription required',
                    message: 'Please subscribe to a plan to host bots',
                    plans: paymentManager.getPlans()
                });
            }

            req.subscription = subscription;
            next();
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };
}

/**
 * Check plan limits middleware
 */
function checkPlanLimit(paymentManager, limitType) {
    return async (req, res, next) => {
        try {
            const userId = req.user?.id;
            
            if (req.user?.role === 'admin') {
                return next();
            }

            const limits = paymentManager.getUserPlanLimits(userId);
            
            if (!limits.canHost) {
                return res.status(403).json({ 
                    error: 'Active subscription required' 
                });
            }

            // Check specific limit
            if (limitType === 'maxBots') {
                // This would need access to bot count - implement based on your bot manager
                req.planLimits = limits;
            }

            next();
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };
}

module.exports = {
    Currency,
    ExchangeRates,
    PaymentPlans,
    PaymentStatus,
    PaymentMethods,
    PaymentManager,
    requireActiveSubscription,
    checkPlanLimit
};