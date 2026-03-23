'use strict';

/**
 * MongoDB Setup for LADYBUGNODES V5
 * Handles database connection and graceful fallback
 */

const mongoose = require('mongoose');
const chalk = require('chalk');

const MONGODB_URI = process.env.MONGODB_URI;

let isConnected = false;

async function connectMongoDB() {
    if (!MONGODB_URI) {
        console.log(chalk.yellow('[DB] No MONGODB_URI provided - using file-based storage'));
        return false;
    }

    try {
        const options = {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            family: 4
        };

        await mongoose.connect(MONGODB_URI, options);
        isConnected = true;

        console.log(chalk.green('[DB] Connected to MongoDB successfully'));

        // Handle connection events
        mongoose.connection.on('error', (err) => {
            console.error(chalk.red('[DB] MongoDB connection error:'), err.message);
            isConnected = false;
        });

        mongoose.connection.on('disconnected', () => {
            console.log(chalk.yellow('[DB] MongoDB disconnected'));
            isConnected = false;
        });

        mongoose.connection.on('reconnected', () => {
            console.log(chalk.green('[DB] MongoDB reconnected'));
            isConnected = true;
        });

        return true;
    } catch (error) {
        console.error(chalk.red('[DB] Failed to connect to MongoDB:'), error.message);
        console.log(chalk.yellow('[DB] Falling back to file-based storage'));
        return false;
    }
}

function getMongoStatus() {
    return {
        connected: isConnected,
        readyState: mongoose.connection.readyState,
        host: mongoose.connection.host || 'N/A',
        name: mongoose.connection.name || 'N/A'
    };
}

async function closeMongoDB() {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        console.log(chalk.gray('[DB] MongoDB connection closed'));
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    await closeMongoDB();
});

process.on('SIGTERM', async () => {
    await closeMongoDB();
});

module.exports = {
    connectMongoDB,
    closeMongoDB,
    getMongoStatus,
    mongoose,
    isConnected: () => isConnected
};