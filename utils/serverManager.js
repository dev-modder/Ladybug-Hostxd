/**
 * LADYBUGNODES V7.2 - Server Management System
 * VPS, Dedicated, and Cloud Server Management
 */

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// Server Schema
const serverSchema = new mongoose.Schema({
    serverId: { type: String, unique: true, default: () => uuidv4() },
    name: { type: String, required: true },
    type: {
        type: String,
        enum: ['vps', 'dedicated', 'cloud', 'shared'],
        default: 'vps'
    },
    status: {
        type: String,
        enum: ['pending', 'provisioning', 'running', 'stopped', 'error', 'maintenance'],
        default: 'pending'
    },
    
    // Owner info
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ownerUsername: { type: String },
    
    // Server specifications
    specs: {
        cpu: { type: String, default: '2 vCPU' },
        cores: { type: Number, default: 2 },
        ram: { type: String, default: '4 GB' },
        ramMB: { type: Number, default: 4096 },
        storage: { type: String, default: '50 GB SSD' },
        storageGB: { type: Number, default: 50 },
        bandwidth: { type: String, default: '2 TB' },
        bandwidthTB: { type: Number, default: 2 }
    },
    
    // Network configuration
    network: {
        ip: { type: String },
        ipv6: { type: String },
        hostname: { type: String },
        domain: { type: String },
        ports: [{ port: Number, protocol: String, description: String }],
        firewall: {
            enabled: { type: Boolean, default: true },
            rules: [{
                type: String,
                port: Number,
                source: String,
                action: { type: String, default: 'allow' }
            }]
        }
    },
    
    // Location
    location: {
        region: { type: String, default: 'us-east' },
        country: { type: String, default: 'United States' },
        city: { type: String, default: 'New York' },
        datacenter: { type: String, default: 'NYC-1' }
    },
    
    // Operating System
    os: {
        type: { type: String, default: 'ubuntu' },
        version: { type: String, default: '22.04 LTS' },
        arch: { type: String, default: 'x86_64' }
    },
    
    // Resource usage (real-time stats)
    stats: {
        cpuUsage: { type: Number, default: 0 },
        ramUsage: { type: Number, default: 0 },
        ramUsedMB: { type: Number, default: 0 },
        diskUsage: { type: Number, default: 0 },
        diskUsedGB: { type: Number, default: 0 },
        networkIn: { type: Number, default: 0 },
        networkOut: { type: Number, default: 0 },
        uptime: { type: Number, default: 0 },
        lastUpdated: { type: Date, default: Date.now }
    },
    
    // Pricing
    pricing: {
        plan: { type: String, default: 'starter' },
        pricePerHour: { type: Number, default: 0.007 },
        pricePerMonth: { type: Number, default: 5 },
        currency: { type: String, default: 'USD' },
        billingCycle: { type: String, enum: ['hourly', 'monthly'], default: 'hourly' }
    },
    
    // SSH Access
    ssh: {
        user: { type: String, default: 'root' },
        port: { type: Number, default: 22 },
        publicKey: { type: String },
        lastAccess: { type: Date }
    },
    
    // Installed services
    services: [{
        name: String,
        status: { type: String, enum: ['running', 'stopped', 'error'], default: 'running' },
        port: Number,
        autoStart: { type: Boolean, default: true }
    }],
    
    // Backups
    backups: {
        enabled: { type: Boolean, default: true },
        frequency: { type: String, default: 'daily' },
        retention: { type: Number, default: 7 },
        lastBackup: { type: Date },
        backups: [{
            id: String,
            createdAt: Date,
            size: Number,
            type: { type: String, enum: ['auto', 'manual'] }
        }]
    },
    
    // Metrics history
    metricsHistory: [{
        timestamp: { type: Date, default: Date.now },
        cpu: Number,
        ram: Number,
        disk: Number,
        networkIn: Number,
        networkOut: Number
    }],
    
    // Timestamps
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    provisionedAt: { type: Date },
    expiresAt: { type: Date }
});

// Indexes
serverSchema.index({ ownerId: 1 });
serverSchema.index({ status: 1 });
serverSchema.index({ 'location.region': 1 });

const Server = mongoose.models.Server || mongoose.model('Server', serverSchema);

// Server Plans
const SERVER_PLANS = {
    // VPS Plans
    VPS_STARTER: {
        id: 'vps-starter',
        name: 'VPS Starter',
        type: 'vps',
        specs: {
            cpu: '1 vCPU',
            cores: 1,
            ram: '1 GB',
            ramMB: 1024,
            storage: '25 GB SSD',
            storageGB: 25,
            bandwidth: '1 TB',
            bandwidthTB: 1
        },
        pricing: {
            pricePerHour: 0.004,
            pricePerMonth: 3,
            pricePerMonthZiG: 96.75,
            currency: 'USD'
        },
        features: ['Basic Support', '1 IPv4', 'DDoS Protection']
    },
    VPS_BASIC: {
        id: 'vps-basic',
        name: 'VPS Basic',
        type: 'vps',
        specs: {
            cpu: '2 vCPU',
            cores: 2,
            ram: '2 GB',
            ramMB: 2048,
            storage: '50 GB SSD',
            storageGB: 50,
            bandwidth: '2 TB',
            bandwidthTB: 2
        },
        pricing: {
            pricePerHour: 0.007,
            pricePerMonth: 5,
            pricePerMonthZiG: 161.25,
            currency: 'USD'
        },
        features: ['Standard Support', '1 IPv4', 'DDoS Protection', 'Backups']
    },
    VPS_STANDARD: {
        id: 'vps-standard',
        name: 'VPS Standard',
        type: 'vps',
        specs: {
            cpu: '4 vCPU',
            cores: 4,
            ram: '4 GB',
            ramMB: 4096,
            storage: '80 GB SSD',
            storageGB: 80,
            bandwidth: '4 TB',
            bandwidthTB: 4
        },
        pricing: {
            pricePerHour: 0.015,
            pricePerMonth: 10,
            pricePerMonthZiG: 322.50,
            currency: 'USD'
        },
        features: ['Priority Support', '1 IPv4 + 1 IPv6', 'DDoS Protection', 'Daily Backups']
    },
    VPS_PREMIUM: {
        id: 'vps-premium',
        name: 'VPS Premium',
        type: 'vps',
        specs: {
            cpu: '8 vCPU',
            cores: 8,
            ram: '16 GB',
            ramMB: 16384,
            storage: '200 GB SSD',
            storageGB: 200,
            bandwidth: '8 TB',
            bandwidthTB: 8
        },
        pricing: {
            pricePerHour: 0.030,
            pricePerMonth: 25,
            pricePerMonthZiG: 806.25,
            currency: 'USD'
        },
        features: ['24/7 Support', '2 IPv4 + IPv6', 'Advanced DDoS', 'Hourly Backups', 'Load Balancer']
    },
    
    // Dedicated Plans
    DEDICATED_ENTRY: {
        id: 'dedicated-entry',
        name: 'Dedicated Entry',
        type: 'dedicated',
        specs: {
            cpu: 'Intel Xeon E3-1230',
            cores: 4,
            ram: '16 GB ECC',
            ramMB: 16384,
            storage: '500 GB SSD',
            storageGB: 500,
            bandwidth: '10 TB',
            bandwidthTB: 10
        },
        pricing: {
            pricePerHour: 0.10,
            pricePerMonth: 75,
            pricePerMonthZiG: 2418.75,
            currency: 'USD'
        },
        features: ['Dedicated Resources', 'Full Root Access', 'IPMI Access', '24/7 Support']
    },
    DEDICATED_PRO: {
        id: 'dedicated-pro',
        name: 'Dedicated Pro',
        type: 'dedicated',
        specs: {
            cpu: 'Intel Xeon E5-2650',
            cores: 12,
            ram: '64 GB ECC',
            ramMB: 65536,
            storage: '1 TB NVMe',
            storageGB: 1000,
            bandwidth: 'Unlimited',
            bandwidthTB: -1
        },
        pricing: {
            pricePerHour: 0.20,
            pricePerMonth: 150,
            pricePerMonthZiG: 4837.50,
            currency: 'USD'
        },
        features: ['Dedicated Resources', 'Full Root Access', 'IPMI Access', 'RAID Configuration', '24/7 Priority Support']
    },
    
    // Cloud Plans
    CLOUD_INSTANCE: {
        id: 'cloud-instance',
        name: 'Cloud Instance',
        type: 'cloud',
        specs: {
            cpu: '2 vCPU',
            cores: 2,
            ram: '4 GB',
            ramMB: 4096,
            storage: '50 GB SSD',
            storageGB: 50,
            bandwidth: 'Pay as you go',
            bandwidthTB: 0
        },
        pricing: {
            pricePerHour: 0.01,
            pricePerMonth: 7,
            pricePerMonthZiG: 225.75,
            currency: 'USD'
        },
        features: ['Auto-scaling', 'Load Balancing', 'Snapshots', 'API Access', 'High Availability']
    }
};

// Regions
const REGIONS = {
    'us-east': { name: 'US East', city: 'New York', country: 'United States', datacenters: ['NYC-1', 'NYC-2'] },
    'us-west': { name: 'US West', city: 'San Francisco', country: 'United States', datacenters: ['SFO-1', 'LAX-1'] },
    'eu-west': { name: 'EU West', city: 'London', country: 'United Kingdom', datacenters: ['LON-1', 'LON-2'] },
    'eu-central': { name: 'EU Central', city: 'Frankfurt', country: 'Germany', datacenters: ['FRA-1', 'FRA-2'] },
    'asia-sg': { name: 'Asia Pacific', city: 'Singapore', country: 'Singapore', datacenters: ['SGP-1'] },
    'asia-tokyo': { name: 'Asia Tokyo', city: 'Tokyo', country: 'Japan', datacenters: ['TYO-1', 'TYO-2'] },
    'af-sa': { name: 'Africa South', city: 'Johannesburg', country: 'South Africa', datacenters: ['JNB-1'] },
    'zw-harare': { name: 'Zimbabwe', city: 'Harare', country: 'Zimbabwe', datacenters: ['HRE-1'] }
};

// Operating Systems
const OPERATING_SYSTEMS = {
    ubuntu: { name: 'Ubuntu', versions: ['22.04 LTS', '24.04 LTS'], logo: 'ubuntu' },
    debian: { name: 'Debian', versions: ['11', '12'], logo: 'debian' },
    centos: { name: 'CentOS', versions: ['Stream 9', 'Stream 8'], logo: 'centos' },
    fedora: { name: 'Fedora', versions: ['39', '40'], logo: 'fedora' },
    alpine: { name: 'Alpine Linux', versions: ['3.19', '3.20'], logo: 'alpine' },
    rocky: { name: 'Rocky Linux', versions: ['8', '9'], logo: 'rocky' },
    windows: { name: 'Windows Server', versions: ['2022', '2019'], logo: 'windows' }
};

class ServerManager {
    constructor() {
        this.initialized = false;
        this.monitoringIntervals = new Map();
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        console.log('[ServerManager] System initialized');
    }

    /**
     * Create a new server
     */
    async createServer(ownerId, options) {
        try {
            const {
                name,
                planId,
                region,
                osType = 'ubuntu',
                osVersion = '22.04 LTS',
                hostname,
                sshKey
            } = options;

            // Validate plan
            const plan = Object.values(SERVER_PLANS).find(p => p.id === planId);
            if (!plan) {
                return { success: false, error: 'Invalid plan selected' };
            }

            // Validate region
            const regionData = REGIONS[region];
            if (!regionData) {
                return { success: false, error: 'Invalid region selected' };
            }

            // Generate server details
            const serverId = uuidv4();
            const serverIP = this.generateIP();
            const generatedHostname = hostname || `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${serverId.substring(0, 8)}`;

            // Create server record
            const server = await Server.create({
                serverId,
                name,
                type: plan.type,
                status: 'provisioning',
                ownerId,
                specs: plan.specs,
                network: {
                    ip: serverIP,
                    hostname: generatedHostname,
                    ports: [
                        { port: 22, protocol: 'tcp', description: 'SSH' },
                        { port: 80, protocol: 'tcp', description: 'HTTP' },
                        { port: 443, protocol: 'tcp', description: 'HTTPS' }
                    ]
                },
                location: {
                    region,
                    country: regionData.country,
                    city: regionData.city,
                    datacenter: regionData.datacenters[0]
                },
                os: {
                    type: osType,
                    version: osVersion,
                    arch: 'x86_64'
                },
                pricing: {
                    plan: planId,
                    ...plan.pricing
                },
                ssh: {
                    user: 'root',
                    port: 22,
                    publicKey: sshKey
                },
                services: [],
                backups: {
                    enabled: true,
                    frequency: 'daily',
                    retention: 7
                }
            });

            // Simulate provisioning
            setTimeout(() => this.provisionServer(server.serverId), 5000);

            return {
                success: true,
                server: server.toObject(),
                message: 'Server provisioning started'
            };
        } catch (error) {
            console.error('[ServerManager] Create server error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Provision server (simulate)
     */
    async provisionServer(serverId) {
        try {
            const server = await Server.findOne({ serverId });
            if (!server) return;

            // Update status to running
            server.status = 'running';
            server.provisionedAt = new Date();
            server.updatedAt = new Date();
            await server.save();

            console.log(`[ServerManager] Server ${serverId} provisioned successfully`);

            // Start monitoring
            this.startMonitoring(serverId);

            return { success: true };
        } catch (error) {
            console.error('[ServerManager] Provision error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Start server monitoring
     */
    startMonitoring(serverId) {
        if (this.monitoringIntervals.has(serverId)) return;

        const interval = setInterval(async () => {
            await this.updateServerStats(serverId);
        }, 30000); // Every 30 seconds

        this.monitoringIntervals.set(serverId, interval);
    }

    /**
     * Stop server monitoring
     */
    stopMonitoring(serverId) {
        const interval = this.monitoringIntervals.get(serverId);
        if (interval) {
            clearInterval(interval);
            this.monitoringIntervals.delete(serverId);
        }
    }

    /**
     * Update server stats (simulate real-time monitoring)
     */
    async updateServerStats(serverId) {
        try {
            const server = await Server.findOne({ serverId });
            if (!server || server.status !== 'running') return;

            // Simulate real-time stats
            const cpuUsage = Math.random() * 100;
            const ramUsage = 30 + Math.random() * 50;
            const diskUsage = 20 + Math.random() * 30;

            server.stats = {
                cpuUsage: Math.round(cpuUsage * 10) / 10,
                ramUsage: Math.round(ramUsage * 10) / 10,
                ramUsedMB: Math.round(server.specs.ramMB * (ramUsage / 100)),
                diskUsage: Math.round(diskUsage * 10) / 10,
                diskUsedGB: Math.round(server.specs.storageGB * (diskUsage / 100)),
                networkIn: Math.round(Math.random() * 1000000),
                networkOut: Math.round(Math.random() * 1000000),
                uptime: server.stats.uptime + 30,
                lastUpdated: new Date()
            };

            // Add to metrics history (keep last 24 hours)
            server.metricsHistory.push({
                timestamp: new Date(),
                cpu: cpuUsage,
                ram: ramUsage,
                disk: diskUsage,
                networkIn: server.stats.networkIn,
                networkOut: server.stats.networkOut
            });

            // Keep only last 288 entries (24 hours at 30s intervals)
            if (server.metricsHistory.length > 288) {
                server.metricsHistory = server.metricsHistory.slice(-288);
            }

            await server.save();

            return { success: true, stats: server.stats };
        } catch (error) {
            console.error('[ServerManager] Update stats error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get user's servers
     */
    async getUserServers(ownerId) {
        try {
            const servers = await Server.find({ ownerId }).sort({ createdAt: -1 });
            return { success: true, servers };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get server by ID
     */
    async getServer(serverId, ownerId) {
        try {
            const query = { serverId };
            if (ownerId) query.ownerId = ownerId;

            const server = await Server.findOne(query);
            if (!server) {
                return { success: false, error: 'Server not found' };
            }

            return { success: true, server };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Start server
     */
    async startServer(serverId, ownerId) {
        try {
            const server = await Server.findOne({ serverId, ownerId });
            if (!server) {
                return { success: false, error: 'Server not found' };
            }

            if (server.status === 'running') {
                return { success: true, message: 'Server already running' };
            }

            server.status = 'running';
            server.updatedAt = new Date();
            await server.save();

            this.startMonitoring(serverId);

            return { success: true, message: 'Server started' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Stop server
     */
    async stopServer(serverId, ownerId) {
        try {
            const server = await Server.findOne({ serverId, ownerId });
            if (!server) {
                return { success: false, error: 'Server not found' };
            }

            if (server.status === 'stopped') {
                return { success: true, message: 'Server already stopped' };
            }

            server.status = 'stopped';
            server.updatedAt = new Date();
            await server.save();

            this.stopMonitoring(serverId);

            return { success: true, message: 'Server stopped' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Restart server
     */
    async restartServer(serverId, ownerId) {
        try {
            const result = await this.stopServer(serverId, ownerId);
            if (!result.success) return result;

            await new Promise(resolve => setTimeout(resolve, 3000));

            return await this.startServer(serverId, ownerId);
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete server
     */
    async deleteServer(serverId, ownerId) {
        try {
            const server = await Server.findOne({ serverId, ownerId });
            if (!server) {
                return { success: false, error: 'Server not found' };
            }

            this.stopMonitoring(serverId);
            await Server.deleteOne({ serverId });

            return { success: true, message: 'Server deleted' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Create backup
     */
    async createBackup(serverId, ownerId, type = 'manual') {
        try {
            const server = await Server.findOne({ serverId, ownerId });
            if (!server) {
                return { success: false, error: 'Server not found' };
            }

            const backupId = uuidv4();
            const backup = {
                id: backupId,
                createdAt: new Date(),
                size: Math.round(server.specs.storageGB * 0.3 * 1024), // Approx 30% of storage
                type
            };

            server.backups.backups.push(backup);
            server.backups.lastBackup = new Date();
            await server.save();

            return {
                success: true,
                backup,
                message: 'Backup created successfully'
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get all plans
     */
    getPlans() {
        return {
            success: true,
            plans: SERVER_PLANS,
            regions: REGIONS,
            operatingSystems: OPERATING_SYSTEMS
        };
    }

    /**
     * Generate random IP (simulation)
     */
    generateIP() {
        const segments = [];
        for (let i = 0; i < 4; i++) {
            segments.push(Math.floor(Math.random() * 256));
        }
        return segments.join('.');
    }

    /**
     * Get all servers (admin)
     */
    async getAllServers(limit = 50, skip = 0) {
        try {
            const servers = await Server.find()
                .sort({ createdAt: -1 })
                .limit(limit)
                .skip(skip);

            const total = await Server.countDocuments();

            return { success: true, servers, total };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get server stats summary
     */
    async getStatsSummary(ownerId) {
        try {
            const servers = await Server.find({ ownerId });

            const summary = {
                total: servers.length,
                running: servers.filter(s => s.status === 'running').length,
                stopped: servers.filter(s => s.status === 'stopped').length,
                totalCpuCores: servers.reduce((sum, s) => sum + s.specs.cores, 0),
                totalRamMB: servers.reduce((sum, s) => sum + s.specs.ramMB, 0),
                totalStorageGB: servers.reduce((sum, s) => sum + s.specs.storageGB, 0),
                monthlyCost: servers.reduce((sum, s) => sum + s.pricing.pricePerMonth, 0)
            };

            return { success: true, summary };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

// Export
const serverManager = new ServerManager();

module.exports = {
    ServerManager,
    serverManager,
    Server,
    SERVER_PLANS,
    REGIONS,
    OPERATING_SYSTEMS
};