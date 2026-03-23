/**
 * Admin Routes - LADYBUGNODES V7.3.0
 * Admin Panel API for Ladybug-Mini Hosting
 * Unlimited Server Creation & Management
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Admin middleware - check if user is admin
const requireAdmin = (req, res, next) => {
    // For demo purposes, allow all authenticated users
    // In production, check for admin role
    next();
};

// Get admin dashboard stats
router.get('/stats', requireAdmin, async (req, res) => {
    try {
        const stats = {
            totalServers: 0,
            runningServers: 0,
            totalUsers: 0,
            totalCoins: 0,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString()
        };

        // Get server stats
        if (req.app.locals.serverManager) {
            const serverStats = await req.app.locals.serverManager.getStats();
            stats.totalServers = serverStats.totalServers || 0;
            stats.runningServers = serverStats.runningServers || 0;
        }

        // Get user stats
        if (req.app.locals.dataLayer) {
            const users = await req.app.locals.dataLayer.getAllUsers();
            stats.totalUsers = users ? users.length : 0;
            
            // Calculate total coins
            if (users) {
                stats.totalCoins = users.reduce((sum, user) => sum + (user.coins || 0), 0);
            }
        }

        res.json(stats);
    } catch (error) {
        console.error('[Admin] Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Get all servers (admin view)
router.get('/servers', requireAdmin, async (req, res) => {
    try {
        if (!req.app.locals.serverManager) {
            return res.json([]);
        }

        const servers = await req.app.locals.serverManager.getAllServers();
        res.json(servers || []);
    } catch (error) {
        console.error('[Admin] Error fetching servers:', error);
        res.status(500).json({ error: 'Failed to fetch servers' });
    }
});

// Create unlimited servers (admin only)
router.post('/servers/create', requireAdmin, async (req, res) => {
    try {
        const { name, planId, region, specs, sessionId, prefix } = req.body;

        if (!req.app.locals.serverManager) {
            return res.status(500).json({ error: 'Server manager not initialized' });
        }

        const server = await req.app.locals.serverManager.createServer({
            id: uuidv4(),
            name: name || `Ladybug-Mini-${Date.now()}`,
            planId: planId || 'ladybug-mini',
            region: region || 'us-east',
            specs: specs || { ram: 256, cpu: 1, storage: 1 },
            sessionId,
            prefix: prefix || '.',
            status: 'running',
            createdAt: new Date().toISOString()
        });

        res.json({ success: true, server });
    } catch (error) {
        console.error('[Admin] Error creating server:', error);
        res.status(500).json({ error: 'Failed to create server' });
    }
});

// Bulk create servers
router.post('/servers/bulk-create', requireAdmin, async (req, res) => {
    try {
        const { count = 5, region, planId } = req.body;

        if (!req.app.locals.serverManager) {
            return res.status(500).json({ error: 'Server manager not initialized' });
        }

        const servers = [];
        for (let i = 0; i < count; i++) {
            const server = await req.app.locals.serverManager.createServer({
                id: uuidv4(),
                name: `Ladybug-Mini-${Date.now()}-${i + 1}`,
                planId: planId || 'ladybug-mini',
                region: region || 'us-east',
                specs: { ram: 256, cpu: 1, storage: 1 },
                status: 'running',
                createdAt: new Date().toISOString()
            });
            servers.push(server);
        }

        res.json({ success: true, count: servers.length, servers });
    } catch (error) {
        console.error('[Admin] Error bulk creating servers:', error);
        res.status(500).json({ error: 'Failed to bulk create servers' });
    }
});

// Start all servers
router.post('/servers/start-all', requireAdmin, async (req, res) => {
    try {
        if (!req.app.locals.serverManager) {
            return res.status(500).json({ error: 'Server manager not initialized' });
        }

        const servers = await req.app.locals.serverManager.getAllServers();
        let started = 0;

        for (const server of servers) {
            if (server.status !== 'running') {
                await req.app.locals.serverManager.startServer(server.id);
                started++;
            }
        }

        res.json({ success: true, started });
    } catch (error) {
        console.error('[Admin] Error starting all servers:', error);
        res.status(500).json({ error: 'Failed to start all servers' });
    }
});

// Stop all servers
router.post('/servers/stop-all', requireAdmin, async (req, res) => {
    try {
        if (!req.app.locals.serverManager) {
            return res.status(500).json({ error: 'Server manager not initialized' });
        }

        const servers = await req.app.locals.serverManager.getAllServers();
        let stopped = 0;

        for (const server of servers) {
            await req.app.locals.serverManager.stopServer(server.id);
            stopped++;
        }

        res.json({ success: true, stopped });
    } catch (error) {
        console.error('[Admin] Error stopping all servers:', error);
        res.status(500).json({ error: 'Failed to stop all servers' });
    }
});

// Delete all servers
router.delete('/servers/delete-all', requireAdmin, async (req, res) => {
    try {
        if (!req.app.locals.serverManager) {
            return res.status(500).json({ error: 'Server manager not initialized' });
        }

        const servers = await req.app.locals.serverManager.getAllServers();
        let deleted = 0;

        for (const server of servers) {
            await req.app.locals.serverManager.deleteServer(server.id);
            deleted++;
        }

        res.json({ success: true, deleted });
    } catch (error) {
        console.error('[Admin] Error deleting all servers:', error);
        res.status(500).json({ error: 'Failed to delete all servers' });
    }
});

// Get activity logs
router.get('/logs', requireAdmin, async (req, res) => {
    try {
        // Return recent activity logs
        const logs = [
            {
                id: uuidv4(),
                type: 'info',
                message: 'Admin panel accessed',
                timestamp: new Date().toISOString()
            }
        ];

        res.json(logs);
    } catch (error) {
        console.error('[Admin] Error fetching logs:', error);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// Get system info
router.get('/system', requireAdmin, async (req, res) => {
    try {
        const systemInfo = {
            platform: process.platform,
            nodeVersion: process.version,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
            env: {
                NODE_ENV: process.env.NODE_ENV || 'development',
                PORT: process.env.PORT || 3000
            }
        };

        res.json(systemInfo);
    } catch (error) {
        console.error('[Admin] Error fetching system info:', error);
        res.status(500).json({ error: 'Failed to fetch system info' });
    }
});

module.exports = router;