/**
 * LADYBUGNODES V7.2 - Server Management API Routes
 */

const express = require('express');
const router = express.Router();
const { serverManager, SERVER_PLANS, REGIONS, OPERATING_SYSTEMS } = require('../utils/serverManager');
const { auth, adminAuth } = require('../middleware/auth');

/**
 * @route   GET /api/servers/plans
 * @desc    Get all available server plans
 * @access  Public
 */
router.get('/plans', (req, res) => {
    const result = serverManager.getPlans();
    res.json(result);
});

/**
 * @route   GET /api/servers/regions
 * @desc    Get all available regions
 * @access  Public
 */
router.get('/regions', (req, res) => {
    res.json({
        success: true,
        regions: REGIONS
    });
});

/**
 * @route   GET /api/servers/os
 * @desc    Get available operating systems
 * @access  Public
 */
router.get('/os', (req, res) => {
    res.json({
        success: true,
        operatingSystems: OPERATING_SYSTEMS
    });
});

/**
 * @route   GET /api/servers
 * @desc    Get user's servers
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
    try {
        const result = await serverManager.getUserServers(req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/servers/stats
 * @desc    Get user's server stats summary
 * @access  Private
 */
router.get('/stats', auth, async (req, res) => {
    try {
        const result = await serverManager.getStatsSummary(req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/servers/create
 * @desc    Create a new server
 * @access  Private
 */
router.post('/create', auth, async (req, res) => {
    try {
        const { name, planId, region, osType, osVersion, hostname, sshKey } = req.body;

        if (!name || !planId || !region) {
            return res.status(400).json({
                success: false,
                error: 'Name, plan, and region are required'
            });
        }

        const result = await serverManager.createServer(req.user.id, {
            name,
            planId,
            region,
            osType,
            osVersion,
            hostname,
            sshKey
        });

        res.status(result.success ? 201 : 400).json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/servers/:serverId
 * @desc    Get server by ID
 * @access  Private
 */
router.get('/:serverId', auth, async (req, res) => {
    try {
        const result = await serverManager.getServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/servers/:serverId/start
 * @desc    Start a server
 * @access  Private
 */
router.post('/:serverId/start', auth, async (req, res) => {
    try {
        const result = await serverManager.startServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/servers/:serverId/stop
 * @desc    Stop a server
 * @access  Private
 */
router.post('/:serverId/stop', auth, async (req, res) => {
    try {
        const result = await serverManager.stopServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/servers/:serverId/restart
 * @desc    Restart a server
 * @access  Private
 */
router.post('/:serverId/restart', auth, async (req, res) => {
    try {
        const result = await serverManager.restartServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   DELETE /api/servers/:serverId
 * @desc    Delete a server
 * @access  Private
 */
router.delete('/:serverId', auth, async (req, res) => {
    try {
        const result = await serverManager.deleteServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   POST /api/servers/:serverId/backup
 * @desc    Create a server backup
 * @access  Private
 */
router.post('/:serverId/backup', auth, async (req, res) => {
    try {
        const { type } = req.body;
        const result = await serverManager.createBackup(req.params.serverId, req.user.id, type);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/servers/:serverId/metrics
 * @desc    Get server metrics history
 * @access  Private
 */
router.get('/:serverId/metrics', auth, async (req, res) => {
    try {
        const result = await serverManager.getServer(req.params.serverId, req.user.id);
        if (!result.success) {
            return res.status(404).json(result);
        }

        res.json({
            success: true,
            metrics: result.server.metricsHistory,
            currentStats: result.server.stats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin routes

/**
 * @route   GET /api/servers/admin/all
 * @desc    Get all servers (admin only)
 * @access  Admin
 */
router.get('/admin/all', adminAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const skip = parseInt(req.query.skip) || 0;
        const result = await serverManager.getAllServers(limit, skip);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/servers/admin/overview
 * @desc    Get server overview stats (admin only)
 * @access  Admin
 */
router.get('/admin/overview', adminAuth, async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const Server = mongoose.models.Server;
        
        const totalServers = await Server.countDocuments();
        const runningServers = await Server.countDocuments({ status: 'running' });
        const stoppedServers = await Server.countDocuments({ status: 'stopped' });
        const provisioningServers = await Server.countDocuments({ status: 'provisioning' });

        const serversByRegion = await Server.aggregate([
            { $group: { _id: '$location.region', count: { $sum: 1 } } }
        ]);

        const serversByType = await Server.aggregate([
            { $group: { _id: '$type', count: { $sum: 1 } } }
        ]);

        res.json({
            success: true,
            overview: {
                total: totalServers,
                running: runningServers,
                stopped: stoppedServers,
                provisioning: provisioningServers,
                byRegion: serversByRegion,
                byType: serversByType
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;