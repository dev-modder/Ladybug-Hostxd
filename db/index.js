const mongoose = require('mongoose');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let isConnected = false;

async function connectDB() {
  const MONGODB_URI = process.env.MONGODB_URI;
  
  if (!MONGODB_URI) {
    console.log(chalk.yellow('[DB] No MONGODB_URI provided, using file-based storage'));
    return false;
  }
  
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    isConnected = true;
    console.log(chalk.green('[DB] Connected to MongoDB'));
    return true;
  } catch (err) {
    console.log(chalk.red(`[DB] MongoDB connection failed: ${err.message}`));
    console.log(chalk.yellow('[DB] Falling back to file-based storage'));
    return false;
  }
}

function isMongoConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

// File-based storage fallback
const fileStorage = {
  load: (filename) => {
    const filePath = path.join(DATA_DIR, filename);
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
      return [];
    } catch (err) {
      console.log(chalk.yellow(`[DB] Error loading ${filename}: ${err.message}`));
      return [];
    }
  },
  save: (filename, data) => {
    const filePath = path.join(DATA_DIR, filename);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.log(chalk.red(`[DB] Error saving ${filename}: ${err.message}`));
      return false;
    }
  }
};

module.exports = {
  connectDB,
  isMongoConnected,
  fileStorage,
  mongoose
};
