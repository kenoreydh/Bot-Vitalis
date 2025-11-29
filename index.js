const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client, GatewayIntentBits, Events, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const User = require('./models/User');
const Channel = require('./models/Channel');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/profile.html';

// --- MONGODB CONNECTION ---
const MONGO_URI = 'mongodb+srv://kenorey19:Q61vKNuzdipiDjDL@cluster0.kv9tydq.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- RPG SYSTEM STATE ---
const activeAdventures = new Map(); // userId -> { step, hp, maxHp, enemy, msgId }

const RPG_LOCATIONS = [
    { name: '🌲 Bosque de Emerald Grove', id: 'forest', emojis: ['🌲', '🍄', '🦌'] },
    { name: '⛰️ Montañas de Borea', id: 'mountain', emojis: ['⛰️', '❄️', '🐐'] },
    { name: '🏜️ Desierto de Howling Sands', id: 'desert', emojis: ['🏜️', '🌵', '🦂'] },
    { name: '💧 Río Sinuoso', id: 'river', emojis: ['💧', '🐟', '🐸'] },
    { name: '🏰 Ruinas Antiguas', id: 'ruins', emojis: ['🏰', '👻', '⚱️'] }
];

const RPG_ENEMIES = {
    forest: [{ name: 'Trork Guerrero', hp: 50, dmg: 5, xp: 20, coin: 10 }, { name: 'Araña Gigante', hp: 30, dmg: 8, xp: 15, coin: 8 }],
    mountain: [{ name: 'Yeti', hp: 80, dmg: 10, xp: 40, coin: 25 }, { name: 'Lobo Invernal', hp: 40, dmg: 6, xp: 20, coin: 12 }],
    desert: [{ name: 'Escorpión de Arena', hp: 45, dmg: 7, xp: 25, coin: 15 }, { name: 'Esqueleto', hp: 35, dmg: 5, xp: 18, coin: 10 }],
    river: [{ name: 'Kweebec Corrupto', hp: 60, dmg: 6, xp: 30, coin: 20 }, { name: 'Cangrejo Pinza', hp: 25, dmg: 4, xp: 10, coin: 5 }],
    ruins: [{ name: 'Guardián de Piedra', hp: 100, dmg: 12, xp: 60, coin: 40 }, { name: 'Fantasma', hp: 40, dmg: 9, xp: 25, coin: 15 }]
};

const RPG_RESOURCES = {
    forest: { name: 'Madera', verb: 'talar', emoji: '🪓' },
    mountain: { name: 'Mineral de Hierro', verb: 'minar', emoji: '⛏️' },
    desert: { name: 'Cactus', verb: 'recolectar', emoji: '🧤' },
    river: { name: 'Pez', verb: 'pescar', emoji: '🎣' },
    ruins: { name: 'Reliquia', verb: 'investigar', emoji: '🔍' }
};

// Ensure user exists in DB
async function ensureUser(userId) {
    let user = await User.findOne({ id: userId });
    if (!user) {
        user = await User.create({ id: userId });
    }
    return user;
}

// --- ROLE MANAGEMENT ---
async function checkExpiredRoles() {
    const now = Date.now();
    // Find users with temp roles
    const users = await User.find({ 'tempRoles.0': { $exists: true } });

    for (const user of users) {
        const activeRoles = [];
        let changed = false;

        for (const roleData of user.tempRoles) {
            if (now > roleData.expiresAt) {
                // Role expired
                const member = await getDiscordMember(user.id);
                if (member) {
                    try {
                        await member.roles.remove(roleData.roleId);
                        console.log(`Removed expired role ${roleData.roleId} from ${member.user.tag}`);
                    } catch (e) {
                        console.error(`Failed to remove role ${roleData.roleId} from ${user.id}`, e);
                    }
                }
                changed = true;
            } else {
                activeRoles.push(roleData);
            }
        }

        if (changed) {
            user.tempRoles = activeRoles;
            await user.save();
        }
    }
}

setInterval(checkExpiredRoles, 60 * 1000);

// --- DISCORD BOT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
});

// Message Handler
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    const userId = message.author.id;
    const user = await ensureUser(userId);

    // Give XP and Coins
    user.xp += 10;
    user.balance += 1;
    await user.save();

    // Commands
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'balance' || command === 'bal') {
        message.reply(`💰 **${message.author.username}**, tienes **${user.balance}** monedas.`);
    }

    if (command === 'daily') {
        const now = Date.now();
        const cooldown = 24 * 60 * 60 * 1000;

        if (now - user.lastDaily < cooldown) {
            const remaining = Math.ceil((user.lastDaily + cooldown - now) / (1000 * 60 * 60));
            return message.reply(`⏳ Espera **${remaining} horas** para reclamar tu recompensa diaria.`);
        }

        user.balance += 100;
        user.lastDaily = now;
        await user.save();
        message.reply(`✅ Has recibido **100 monedas** diarias!`);
    }

    if (command === 'rep' || command === 'unrep') {
        const target = message.mentions.users.first();
        if (!target) return message.reply('❌ Menciona a un usuario.');
        if (target.id === userId) return message.reply('❌ No puedes votarte a ti mismo.');

        const now = Date.now();
        const cooldown = 24 * 60 * 60 * 1000;

        if (now - user.lastRep < cooldown) {
            const remaining = Math.ceil((user.lastRep + cooldown - now) / (1000 * 60 * 60));
            return message.reply(`⏳ Espera **${remaining} horas** para volver a dar reputación.`);
        }

        const targetUser = await ensureUser(target.id);

        if (command === 'rep') {
            targetUser.rep += 1;
            message.reply(`🌟 Has dado **+1 Rep** a **${target.username}**!`);
        } else {
            targetUser.rep -= 1;
            message.reply(`💔 Has dado **-1 Rep** a **${target.username}**.`);
        }

        user.lastRep = now;
        await user.save();
        await targetUser.save();
    }

    if (command === 'profile') {
        const tier = calculateTier(user);
        const level = calculateLevel(user.xp);
        message.reply(`
📊 **Perfil de ${message.author.username}**
💎 Rango: ${tier}
🆙 Nivel: ${level}
💰 Monedas: ${user.balance}
🌟 Reputación: ${user.rep}
✨ XP: ${user.xp}
        `);
    }

    if (command === 'scanxp') {
        const channelId = message.channel.id;
        const now = Date.now();
        const cooldown = 7 * 24 * 60 * 60 * 1000; // 1 Week

        let channel = await Channel.findOne({ id: channelId });
        if (!channel) channel = await Channel.create({ id: channelId });

        if (now - channel.lastScan < cooldown) {
            const remainingDays = Math.ceil((channel.lastScan + cooldown - now) / (1000 * 60 * 60 * 24));
            return message.reply(`⏳ Este canal ya fue escaneado recientemente. Espera **${remainingDays} días** para volver a escanearlo.`);
        }

        const limit = parseInt(args[0]) || 50;
        const fetchLimit = Math.min(limit, 100);

        message.channel.send(`🔄 Escaneando los últimos ${fetchLimit} mensajes para otorgar XP...`);

        try {
            const messages = await message.channel.messages.fetch({ limit: fetchLimit });
            let count = 0;
            let usersUpdated = new Set();

            for (const msg of messages.values()) {
                if (!msg.author.bot) {
                    const u = await ensureUser(msg.author.id);
                    u.xp += 10;
                    u.balance += 1;
                    await u.save();
                    usersUpdated.add(msg.author.username);
                    count++;
                }
            }

            channel.lastScan = now;
            await channel.save();

            message.channel.send(`✅ **Escaneo completado**\nSe procesaron ${count} mensajes.\nUsuarios actualizados: ${Array.from(usersUpdated).join(', ')}`);

        } catch (error) {
            console.error(error);
            message.channel.send('❌ Error al leer el historial de mensajes.');
        }
    }

    if (command === 'leaderboard' || command === 'top') {
        const sortedUsers = await User.find().sort({ xp: -1 }).limit(5);

        let leaderboard = '🏆 **Top 5 Usuarios (XP)**\n';
        for (let i = 0; i < sortedUsers.length; i++) {
            const uData = sortedUsers[i];
            let name = `Usuario ${uData.id.slice(0, 4)}...`;

            try {
                const user = await client.users.fetch(uData.id);
                name = user.username;
            } catch (e) { }

            leaderboard += `${i + 1}. **${name}** - ✨ ${uData.xp} XP | 💰 ${uData.balance}\n`;
        }
        message.reply(leaderboard);
    }

    if (command === 'apostar' || command === 'bet') {
        const amount = parseInt(args[0]);
        const choice = args[1] ? args[1].toLowerCase() : null;

        if (!amount || isNaN(amount) || amount <= 0) return message.reply('❌ Uso: `!apostar <cantidad> <cara/cruz>`');
        if (amount > user.balance) return message.reply('❌ No tienes suficientes monedas.');
        if (!choice || (choice !== 'cara' && choice !== 'cruz' && choice !== 'heads' && choice !== 'tails')) {
            return message.reply('❌ Debes elegir `cara` o `cruz`.');
        }

        const isHeads = Math.random() < 0.5;
        const result = isHeads ? 'cara' : 'cruz';
        const win = (choice === 'cara' || choice === 'heads') === isHeads;

        if (win) {
            user.balance += amount;
            message.reply(`🪙 Salió **${result}**. ¡Ganaste **${amount}** monedas! 🎉`);
        } else {
            user.balance -= amount;
            message.reply(`🪙 Salió **${result}**. Perdiste **${amount}** monedas. 😢`);
        }
        await user.save();
    }

    // --- RPG COMMAND: !explore ---
    if (command === 'explore' || command === 'aventura') {
        const now = Date.now();
        const cooldownTime = 60 * 60 * 1000;

        if (now - (user.lastExploreReset || 0) > cooldownTime) {
            user.exploreCount = 0;
            user.lastExploreReset = now;
        }

        if (user.exploreCount >= 3) {
            const remaining = Math.ceil(((user.lastExploreReset + cooldownTime) - now) / (1000 * 60));
            return message.reply(`⏳ **¡Estás agotado!** Has usado tus 3 aventuras por hora.\nDescansa **${remaining} minutos** antes de volver a explorar.`);
        }

        if (activeAdventures.has(userId)) {
            return message.reply('⚠️ Ya tienes una aventura en curso. ¡Termínala primero!');
        }

        user.exploreCount = (user.exploreCount || 0) + 1;
        await user.save();

        const choices = [];
        while (choices.length < 3) {
            const loc = RPG_LOCATIONS[Math.floor(Math.random() * RPG_LOCATIONS.length)];
            if (!choices.includes(loc)) choices.push(loc);
        }

        const row = new ActionRowBuilder()
            .addComponents(
                choices.map(loc =>
                    new ButtonBuilder()
                        .setCustomId(`explore_${loc.id}`)
                        .setLabel(loc.name)
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji(loc.emojis[0])
                )
            );

        const embedMsg = await message.reply({
            content: '🗺️ **¡Comienza tu aventura en Hytale!**\nElige tu camino:',
            components: [row]
        });

        activeAdventures.set(userId, {
            step: 'CHOICE',
            hp: 100,
            maxHp: 100,
            msgId: embedMsg.id
        });
    }
});

// --- INTERACTION HANDLER (BUTTONS) ---
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton()) return;

    const userId = interaction.user.id;
    const user = await ensureUser(userId);
    const adventure = activeAdventures.get(userId);

    if (!adventure) {
        return interaction.reply({ content: '❌ Esta aventura ha expirado o no es tuya.', ephemeral: true });
    }

    if (interaction.customId.startsWith('explore_')) {
        const locId = interaction.customId.split('_')[1];
        const location = RPG_LOCATIONS.find(l => l.id === locId);
        const roll = Math.random();

        if (roll < 0.4) {
            // COMBAT
            const enemies = RPG_ENEMIES[locId];
            const enemy = enemies[Math.floor(Math.random() * enemies.length)];

            adventure.step = 'COMBAT';
            adventure.enemy = { ...enemy, maxHp: enemy.hp };
            adventure.healsRemaining = 3;

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('combat_attack').setLabel('Atacar').setStyle(ButtonStyle.Danger).setEmoji('⚔️'),
                    new ButtonBuilder().setCustomId('combat_heal').setLabel(`Curar (${adventure.healsRemaining})`).setStyle(ButtonStyle.Success).setEmoji('🧪'),
                    new ButtonBuilder().setCustomId('combat_run').setLabel('Huir').setStyle(ButtonStyle.Secondary).setEmoji('🏃')
                );

            await interaction.update({
                content: `⚔️ **¡Has encontrado un ${enemy.name}!**\n\n❤️ Tu HP: ${adventure.hp}/${adventure.maxHp}\n👹 Enemigo HP: ${enemy.hp}/${enemy.maxHp}`,
                components: [row]
            });

        } else if (roll < 0.7) {
            // GATHERING
            const resource = RPG_RESOURCES[locId];
            const amount = Math.floor(Math.random() * 5) + 1;
            const xpGain = amount * 2;

            user.balance += amount;
            user.xp += xpGain;
            await user.save();
            activeAdventures.delete(userId);

            await interaction.update({
                content: `🌿 **${resource.verb.toUpperCase()}**\nHas encontrado **${amount}x ${resource.name}** ${resource.emoji}.\nGanaste **${amount} monedas** y **${xpGain} XP**.`,
                components: []
            });

        } else if (roll < 0.9) {
            // CHEST
            const coins = Math.floor(Math.random() * 50) + 20;
            const xp = 30;

            user.balance += coins;
            user.xp += xp;
            await user.save();
            activeAdventures.delete(userId);

            await interaction.update({
                content: `💎 **¡Un Cofre Oculto!**\nDentro encuentras **${coins} monedas** y ganas **${xp} XP**.`,
                components: []
            });

        } else {
            // NOTHING
            activeAdventures.delete(userId);
            await interaction.update({
                content: `🍃 Caminas por **${location.name}** pero no encuentras nada interesante esta vez...`,
                components: []
            });
        }
    }

    if (interaction.customId.startsWith('combat_')) {
        if (adventure.step !== 'COMBAT') return;

        const action = interaction.customId.split('_')[1];
        const enemy = adventure.enemy;
        let msg = '';
        let gameOver = false;

        if (action === 'attack') {
            const dmg = Math.floor(Math.random() * 10) + 5;
            enemy.hp -= dmg;
            msg += `⚔️ Atacas a **${enemy.name}** y le haces **${dmg}** de daño.\n`;

            if (enemy.hp <= 0) {
                user.balance += enemy.coin;
                user.xp += enemy.xp;
                await user.save();
                msg += `🎉 **¡Victoria!** Has derrotado al enemigo.\nGanaste **${enemy.coin} monedas** y **${enemy.xp} XP**.`;
                gameOver = true;
            }
        } else if (action === 'heal') {
            if (adventure.healsRemaining > 0) {
                const heal = Math.floor(Math.random() * 15) + 5;
                adventure.hp = Math.min(adventure.maxHp, adventure.hp + heal);
                adventure.healsRemaining--;
                msg += `🧪 Tomas una poción y recuperas **${heal} HP**. (Quedan: ${adventure.healsRemaining})\n`;
            } else {
                msg += `🚫 **¡No te quedan pociones!** No has podido curarte.\n`;
            }
        } else if (action === 'run') {
            if (Math.random() > 0.5) {
                msg += `🏃 **¡Escapaste con éxito!**`;
                gameOver = true;
            } else {
                msg += `🚫 Intentaste huir pero tropezaste...\n`;
            }
        }

        if (!gameOver) {
            const enemyDmg = Math.floor(Math.random() * enemy.dmg) + 1;
            adventure.hp -= enemyDmg;
            msg += `👹 **${enemy.name}** te ataca y recibes **${enemyDmg}** de daño.`;

            if (adventure.hp <= 0) {
                msg += `\n💀 **Has sido derrotado...** Te arrastras fuera de la mazmorra.`;
                gameOver = true;
            }
        }

        if (gameOver) {
            activeAdventures.delete(userId);
            await interaction.update({
                content: msg,
                components: []
            });
        } else {
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('combat_attack').setLabel('Atacar').setStyle(ButtonStyle.Danger).setEmoji('⚔️'),
                    new ButtonBuilder()
                        .setCustomId('combat_heal')
                        .setLabel(`Curar (${adventure.healsRemaining})`)
                        .setStyle(adventure.healsRemaining > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
                        .setEmoji('🧪')
                        .setDisabled(adventure.healsRemaining === 0),
                    new ButtonBuilder().setCustomId('combat_run').setLabel('Huir').setStyle(ButtonStyle.Secondary).setEmoji('🏃')
                );

            await interaction.update({
                content: `${msg}\n\n❤️ Tu HP: ${adventure.hp}/${adventure.maxHp}\n👹 Enemigo HP: ${enemy.hp}/${enemy.maxHp}`,
                components: [row]
            });
        }
    }
});

function calculateTier(user) {
    if (user.xp > 1000 && user.rep > 50) return 'Legendario';
    if (user.xp > 500 && user.rep > 20) return 'Maestro';
    if (user.xp > 100) return 'Aventurero';
    return 'Novato';
}

if (TOKEN) {
    client.login(TOKEN).catch(err => console.error("Discord Login Error:", err));
} else {
    console.error("TOKEN is missing in .env");
}

const ACHIEVEMENTS = {
    hablador: [
        { tier: 'I', level: 5, name: 'Hablador I' },
        { tier: 'II', level: 10, name: 'Hablador II' },
        { tier: 'III', level: 20, name: 'Hablador III' },
        { tier: 'IV', level: 50, name: 'Hablador IV' },
        { tier: 'V', level: 100, name: 'Hablador V' }
    ],
    veterano: [
        { tier: 'I', days: 30, name: 'Veterano I' },
        { tier: 'II', days: 180, name: 'Veterano II' },
        { tier: 'III', days: 365, name: 'Veterano III' },
        { tier: 'IV', days: 730, name: 'Veterano IV' }
    ],
    lider: [
        { tier: 'I', rep: 10, name: 'Líder I' },
        { tier: 'II', rep: 50, name: 'Líder II' },
        { tier: 'III', rep: 100, name: 'Líder III' },
        { tier: 'IV', rep: 500, name: 'Líder IV' }
    ],
    otros: [
        { id: 'primeros_pasos', name: 'Primeros Pasos', description: 'Únete a nuestra comunidad de Discord' },
        { id: 'donador', name: 'Donador', description: 'Apoya al servidor para obtener este rol exclusivo' }
    ]
};

function calculateLevel(xp) {
    return Math.floor(Math.sqrt(xp / 100));
}

async function getDiscordMember(userId) {
    for (const [id, guild] of client.guilds.cache) {
        try {
            const member = await guild.members.fetch(userId);
            if (member) return member;
        } catch (e) { }
    }
    return null;
}

async function calculateAchievements(user, userId) {
    const allAchievements = [];

    const level = calculateLevel(user.xp);
    ACHIEVEMENTS.hablador.forEach(ach => {
        const unlocked = level >= ach.level;
        allAchievements.push({
            ...ach,
            type: 'hablador',
            status: unlocked ? 'unlocked' : 'locked',
            description: `Alcanza el Nivel ${ach.level}`
        });
    });

    ACHIEVEMENTS.lider.forEach(ach => {
        const unlocked = user.rep >= ach.rep;
        allAchievements.push({
            ...ach,
            type: 'lider',
            status: unlocked ? 'unlocked' : 'locked',
            description: `Consigue ${ach.rep} puntos de Reputación`
        });
    });

    const member = await getDiscordMember(userId);
    let daysInServer = 0;
    if (member && member.joinedAt) {
        daysInServer = (Date.now() - member.joinedAt.getTime()) / (1000 * 60 * 60 * 24);
    }

    ACHIEVEMENTS.veterano.forEach(ach => {
        const unlocked = daysInServer >= ach.days;
        allAchievements.push({
            ...ach,
            type: 'veterano',
            status: unlocked ? 'unlocked' : 'locked',
            description: `Lleva ${ach.days} días en el servidor`
        });
    });

    allAchievements.push({
        ...ACHIEVEMENTS.otros[0],
        type: 'otros',
        status: 'unlocked'
    });

    let isDonador = false;
    if (member) {
        isDonador = member.roles.cache.some(r => r.name.toLowerCase().includes('donador') || r.name.toLowerCase().includes('booster'));
    }
    allAchievements.push({
        ...ACHIEVEMENTS.otros[1],
        type: 'otros',
        status: isDonador ? 'unlocked' : 'locked'
    });

    return { allAchievements, level };
}

// --- EXPRESS API ---
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/api/auth/discord', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI,
                scope: 'identify',
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenResponse.json();
        if (tokenData.error) return res.status(400).json(tokenData);

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();
        if (!userResponse.ok) return res.status(400).json({ error: 'Failed to fetch user data', details: userData });

        const botStats = await ensureUser(userData.id);
        const achievements = await calculateAchievements(botStats, userData.id);
        const tier = calculateTier(botStats);

        res.json({
            discord: userData,
            stats: { ...botStats.toObject(), tier, level: achievements.level },
            achievements
        });

    } catch (error) {
        console.error('OAuth Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/store/buy', async (req, res) => {
    const { userId, itemId } = req.body;
    const user = await ensureUser(userId);

    if (itemId === 'vip_week') {
        const COST = 5000;
        const ROLE_ID = '1444463438498893974';
        const DURATION = 7 * 24 * 60 * 60 * 1000;

        if (user.balance < COST) {
            return res.status(400).json({ error: 'No tienes suficientes monedas.' });
        }

        const member = await getDiscordMember(userId);
        if (member) {
            try {
                await member.roles.add(ROLE_ID);
            } catch (e) {
                console.error("Error adding role:", e);
                return res.status(500).json({ error: 'Error: El bot no tiene permisos para dar este rol.' });
            }
        } else {
            return res.status(404).json({ error: 'Usuario no encontrado en el servidor de Discord.' });
        }

        user.balance -= COST;
        if (!user.tempRoles) user.tempRoles = [];
        user.tempRoles.push({ roleId: ROLE_ID, expiresAt: Date.now() + DURATION });
        await user.save();

        res.json({ success: true, newBalance: user.balance, message: '¡Compra exitosa! Rol VIP asignado por 7 días.' });
    } else {
        res.status(400).json({ error: 'Item no válido.' });
    }
});

app.get('/api/user/:id', async (req, res) => {
    const userId = req.params.id;
    const user = await User.findOne({ id: userId });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const achievements = await calculateAchievements(user, userId);

    res.json({
        id: userId,
        balance: user.balance,
        rep: user.rep,
        xp: user.xp,
        tier: calculateTier(user),
        level: achievements.level,
        achievements
    });
});

app.listen(PORT, () => {
    console.log(`API Server running on port ${PORT}`);
});
