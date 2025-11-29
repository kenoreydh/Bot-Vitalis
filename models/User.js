const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    balance: { type: Number, default: 0 },
    rep: { type: Number, default: 0 },
    xp: { type: Number, default: 0 },
    lastDaily: { type: Number, default: 0 },
    lastRep: { type: Number, default: 0 },
    joinDate: { type: Number, default: Date.now },
    exploreCount: { type: Number, default: 0 },
    lastExploreReset: { type: Number, default: 0 },
    tempRoles: [{
        roleId: String,
        expiresAt: Number
    }],
    inventory: { type: Array, default: [] }
});

module.exports = mongoose.model('User', userSchema);
