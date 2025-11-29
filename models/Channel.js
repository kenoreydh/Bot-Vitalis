const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    lastScan: { type: Number, default: 0 }
});

module.exports = mongoose.model('Channel', channelSchema);
