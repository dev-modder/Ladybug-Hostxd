'use strict';

/**
 * Payment Routes for LADYBUGNODES V(7)
 * Handles subscriptions, payments in ZiG and USD
 */

const express = require('express');
const router = express.Router();
const { 
    PaymentManager, 
    PaymentPlans, 
    PaymentStatus, 
    PaymentMethods,
    requireActiveSubscription 
} = require('../utils/paymentSystem');

// Initialize payment manager
let paymentManager = null;

function initPaymentRoutes(app, config = {}) {
    paymentManager = new PaymentManager(config);
    app.use('/api/payments', router);
    console.log('[Payments] Routes initialized');
    return paymentManager;
}

// Middleware to check authentication
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    // This should integrate with your existing auth middleware
    // For now, we'll assume req.user is set by a previous middleware
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

/**
 * Get all available plans
 */
router.get('/plans', (req, res) => {
    try {
        const plans = paymentManager.getPlans();
        res.json({
            success: true,
            plans,
            currencies: ['ZiG', 'USD'],
            exchangeRates: {
                zigToUsd: 0.031,
                usdToZig: 32.25
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get a specific plan
 */
router.get('/plans/:planId', (req, res) => {
    try {
        const plan = paymentManager.getPlan(req.params.planId);
        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }
        res.json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get user's current subscription
 */
router.get('/subscription', requireAuth, (req, res) => {
    try {
        const subscription = paymentManager.getUserSubscription(req.user.id);
        res.json({
            success: true,
            subscription,
            hasActiveSubscription: subscription !== null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get user's plan limits
 */
router.get('/limits', requireAuth, (req, res) => {
    try {
        const limits = paymentManager.getUserPlanLimits(req.user.id);
        res.json({
            success: true,
            ...limits
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Create a new payment
 */
router.post('/create', requireAuth, async (req, res) => {
    try {
        const { planId, currency, paymentMethod } = req.body;

        if (!planId || !currency || !paymentMethod) {
            return res.status(400).json({ 
                error: 'planId, currency, and paymentMethod are required' 
            });
        }

        const plan = paymentManager.getPlan(planId);
        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }

        // Validate currency
        if (!['ZiG', 'USD'].includes(currency)) {
            return res.status(400).json({ 
                error: 'Invalid currency. Use ZiG or USD' 
            });
        }

        // Validate payment method
        const validMethods = Object.values(PaymentMethods);
        if (!validMethods.includes(paymentMethod)) {
            return res.status(400).json({ 
                error: 'Invalid payment method',
                validMethods 
            });
        }

        // Calculate amount based on currency
        const amount = currency === 'USD' ? plan.priceUSD : plan.priceZiG;

        const payment = paymentManager.createPayment({
            userId: req.user.id,
            planId: plan.id,
            amount,
            currency,
            paymentMethod,
            metadata: {
                planName: plan.name,
                duration: plan.duration
            }
        });

        res.status(201).json({
            success: true,
            payment,
            message: 'Payment created. Please complete the payment to activate your subscription.',
            paymentInstructions: getPaymentInstructions(paymentMethod, currency, amount)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get payment instructions based on method
 */
function getPaymentInstructions(method, currency, amount) {
    const instructions = {
        zig_mobile: {
            title: 'ZiG Mobile Money Payment',
            steps: [
                'Dial *123# on your mobile phone',
                'Select "Send Money"',
                'Enter merchant number: XXXXXX',
                `Enter amount: ${amount} ZiG`,
                'Enter your PIN',
                'Save the transaction ID'
            ],
            accountDetails: {
                merchantNumber: 'XXXXXX',
                accountName: 'LADYBUGNODES'
            }
        },
        zig_bank: {
            title: 'ZiG Bank Transfer',
            steps: [
                'Log into your bank app or visit your branch',
                'Select "Transfer" or "Send Money"',
                'Enter the account details below',
                `Enter amount: ${amount} ZiG`,
                'Include your User ID in the reference'
            ],
            accountDetails: {
                bank: 'Reserve Bank of Zimbabwe',
                accountNumber: 'XXXXXXXXXX',
                accountName: 'LADYBUGNODES',
                branch: 'Harare'
            }
        },
        usd_paypal: {
            title: 'PayPal Payment',
            steps: [
                'Log into your PayPal account or create one',
                'Click "Send & Request"',
                'Enter the email below',
                `Enter amount: $${amount} USD`,
                'Complete the payment'
            ],
            accountDetails: {
                email: 'payments@ladybugnodes.com',
                note: 'Include your username in the note'
            }
        },
        usd_stripe: {
            title: 'Credit/Debit Card (Stripe)',
            steps: [
                'Click the payment link sent to your email',
                'Enter your card details',
                'Complete the secure payment',
                'You will receive confirmation instantly'
            ],
            note: 'A payment link will be sent to your registered email'
        },
        usd_bank: {
            title: 'USD Bank Transfer',
            steps: [
                'Log into your bank app or visit your branch',
                'Select "International Transfer"',
                'Enter the account details below',
                `Enter amount: $${amount} USD`,
                'Include your User ID in the reference'
            ],
            accountDetails: {
                bank: 'Standard Chartered',
                accountNumber: 'XXXXXXXXXX',
                accountName: 'LADYBUGNODES',
                swiftCode: 'SCHLZWHXXXX',
                branch: 'Harare'
            }
        },
        manual: {
            title: 'Manual Payment',
            steps: [
                'Contact support for manual payment arrangement',
                'Provide your username and plan choice',
                'Follow the instructions given by support'
            ],
            contact: 'support@ladybugnodes.com'
        }
    };

    return instructions[method] || instructions.manual;
}

/**
 * Confirm payment (upload proof)
 */
router.post('/:paymentId/confirm', requireAuth, async (req, res) => {
    try {
        const { paymentId } = req.params;
        const { transactionId, receiptUrl, notes } = req.body;

        const payments = paymentManager._loadPayments();
        const payment = payments.find(p => p.id === paymentId);

        if (!payment) {
            return res.status(404).json({ error: 'Payment not found' });
        }

        if (payment.userId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (payment.status !== PaymentStatus.PENDING) {
            return res.status(400).json({ 
                error: 'Payment is not in pending state',
                currentStatus: payment.status 
            });
        }

        // Update payment with proof
        payment.status = PaymentStatus.PROCESSING;
        payment.transactionId = transactionId || null;
        payment.receiptUrl = receiptUrl || null;
        payment.metadata.notes = notes || '';
        payment.updatedAt = new Date().toISOString();

        paymentManager._savePayments(payments);

        res.json({
            success: true,
            payment,
            message: 'Payment confirmation submitted. Awaiting verification.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get user's payment history
 */
router.get('/history', requireAuth, (req, res) => {
    try {
        const history = paymentManager.getUserPaymentHistory(req.user.id);
        res.json({
            success: true,
            payments: history
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Cancel subscription
 */
router.post('/subscription/cancel', requireAuth, (req, res) => {
    try {
        const subscription = paymentManager.cancelSubscription(req.user.id);
        res.json({
            success: true,
            subscription,
            message: 'Subscription cancelled'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN ROUTES ============

/**
 * Get all payments (admin only)
 */
router.get('/admin/all', requireAuth, (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const payments = paymentManager.getAllPayments();
        res.json({
            success: true,
            payments
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get payment statistics (admin only)
 */
router.get('/admin/stats', requireAuth, (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const stats = paymentManager.getPaymentStats();
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Verify payment (admin only)
 */
router.post('/admin/verify/:paymentId', requireAuth, (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { notes } = req.body;
        const payment = paymentManager.verifyPayment(
            req.params.paymentId, 
            req.user.id, 
            notes || ''
        );

        res.json({
            success: true,
            payment,
            message: 'Payment verified and subscription activated'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Update payment status (admin only)
 */
router.patch('/admin/:paymentId/status', requireAuth, (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { status, notes } = req.body;
        
        if (!Object.values(PaymentStatus).includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const payment = paymentManager.updatePaymentStatus(
            req.params.paymentId, 
            status,
            { notes, updatedBy: req.user.id }
        );

        res.json({
            success: true,
            payment
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = {
    router,
    initPaymentRoutes,
    getPaymentManager: () => paymentManager
};