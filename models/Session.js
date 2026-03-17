const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerName: { type: String, required: true },
  ownerNumber: { type: String, default: '' },
  sessionIdString: { type: String, required: true },
  botName: { type: String, default: 'LadybugBot' },
  prefix: { type: String, default: '.' },
  timezone: { type: String, default: 'Africa/Harare' },
  botId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotConfig', default: null },
  status: { type: String, enum: ['stopped', 'running', 'starting', 'crashed'], default: 'stopped' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Session', sessionSchema);
