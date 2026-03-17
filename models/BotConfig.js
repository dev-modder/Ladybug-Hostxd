const mongoose = require('mongoose');

const botConfigSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  entryPoint: { type: String, default: 'index.js' },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerUsername: { type: String, required: true },
  sourceType: { type: String, enum: ['upload', 'github'], default: 'upload' },
  githubUrl: { type: String, default: '' },
  status: { type: String, enum: ['stopped', 'running', 'starting', 'crashed'], default: 'stopped' },
  path: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('BotConfig', botConfigSchema);
