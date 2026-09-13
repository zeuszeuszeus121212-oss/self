'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { isTextChannel, isUserRuntime } = require('./discordAdapter');
const { runAgent } = require('./tools');
const { buildBotContext, db_load_channel_session, db_save_channel_session, getAccessLevel } = require('./utils');

const DEFAULT_ACCOUNT_SETTINGS = Object.freeze({
    dm_channel_id: null,
    mention_channel_id: null,
    event_channel_id: null,
    deliveries_channel_id: '1302635629108269177',
    event_role_id: '1339697461878456381',
    mode: 'manual',
    manual_default_count: 1,
    manual_default_minutes: 0,
    auto_min_messages_10m: 3,
    auto_inactivity_minutes: 20,
    auto_run_count: 3,
    auto_run_minutes: 0,
    schedule_config: {
        frequency: null,         // 'once', 'daily', 'days'
        days_count: 1,
        start_date: null,
        executed_once: false,
        slots: []               // [{ type:'range'|'count', start:{h,m}, end?:{h,m}, count?:number }]
    },
    event_wait_ms: 10000,
    first_event_announces_everyone: true,
    games: [
        { name: 'مافيا', command: '.مافيا', bot_id: '1508592252220477651', first_reward: '.', reward: '.' },
        { name: 'روليت', command: '.روليت', bot_id: '1006332825571692544', first_reward: '.', reward: '.' },
        { name: 'لغم', command: '.لغم', bot_id: '1006332825571692544', first_reward: '.', reward: '.' },
        { name: 'غميضه', command: '.غميضه', bot_id: '1006332825571692544', first_reward: '.', reward: '.' },
        { name: 'حجرة', command: '.حجرة', bot_id: '1006332825571692544', first_reward: '.', reward: '.' },
        { name: 'سباق', command: '.سباق', bot_id: '1006332825571692544', first_reward: '.', reward: '.' },
        { name: 'كراسي', command: '.كراسي', bot_id: '1006332825571692544', first_reward: '.', reward: '.' },
    ],
});

const WIN_RE = /(فاز|فوز|فوزي|فائزة|فائز|الفائز|الفائزة|ربح|نتيجة|انتهت|انتهى)/i;
const bridge = new Map();
const memory = new Map();
const activity = new Map();
const autoLocks = new Map();
const scheduledLoops = new Map();
const manualRunNoCredits = new Map(); // agentId:guildId -> true

// ---------------------- مفتاح موحد لسلاسل الفعاليات ----------------------
function seriesLockKey(agentId, guildId, channelId) {
    return `${agentId}:${guildId}:${channelId}:event_series`;
}

// ---------------------- دالة كشف الفوز المحسّنة ----------------------
function isWinMessage(message) {
    let fullText = message.content || '';
    if (message.embeds && message.embeds.length > 0) {
        for (const embed of message.embeds) {
            if (embed.description) fullText += ' ' + embed.description;
            if (embed.title) fullText += ' ' + embed.title;
            if (embed.fields) {
                for (const field of embed.fields) {
                    fullText += ' ' + (field.name || '') + ' ' + (field.value || '');
                }
            }
        }
    }
    const text = fullText.replace(/\s+/g, ' ').trim();

    if (text.includes('🏆 | تبقى لاعبين فقط ، من تختاره العجلة في الجولة التالية هو الفائز ، فهمت؟')) return false;

    if (/\*\*🏆 \| مبروك <@\d+>، انت الفائز في اللعبة!\*\*/.test(text)) return true;
    if (/^# :z22: فوز المافيا!/.test(text)) return true;
    if (/^# :z22: فوز المواطنين!/.test(text)) return true;
    if (/^# 👑 - <@\d+> فاز باللعبة!/.test(text)) return true;
    if (text.includes('أعضاء الفريق الفائز')) return true;

    return false;
}

// ---------------------- دوال مساعدة للجدولة الذكية ----------------------
function nowInMinutes() {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function slotStartMinutes(slot) {
    return (slot.start.hour || 0) * 60 + (slot.start.minute || 0);
}

function slotEndMinutes(slot) {
    if (slot.type === 'range') {
        return (slot.end.hour || 0) * 60 + (slot.end.minute || 0);
    }
    return slotStartMinutes(slot);
}

function isSlotActive(slot, nowMins) {
    if (slot.type === 'range') {
        return nowMins >= slotStartMinutes(slot) && nowMins <= slotEndMinutes(slot);
    } else if (slot.type === 'count') {
        return nowMins >= slotStartMinutes(slot);
    }
    return false;
}

async function runScheduleSession(client, guild, channel, runtime, slot) {
    const settings = await getAccountSettings(runtime.agentId, guild.id);
    const waitMs = Number(settings.event_wait_ms || 10000);
    const key = seriesLockKey(runtime.agentId, guild.id, channel.id);

    // منع البدء إذا كانت هناك سلسلة نشطة بالفعل
    if (autoLocks.get(key)) return;
    autoLocks.set(key, true);

    try {
        let started = false;

        if (slot.type === 'range') {
            const endMins = slotEndMinutes(slot);
            while (nowInMinutes() <= endMins) {
                const game = await startEvent(client, guild, channel, runtime, null, !started, false);
                started = true;
                // انتظار رسالة فوز من نفس البوت الذي بدأ اللعبة، بدون مهلة زمنية
                await channel.awaitMessages({
                    filter: m => m.author.id === game.bot_id && isWinMessage(m),
                    max: 1
                });
                await new Promise(r => setTimeout(r, waitMs));
            }
        } else if (slot.type === 'count') {
            let remaining = slot.count || 1;
            while (remaining-- > 0) {
                const game = await startEvent(client, guild, channel, runtime, null, !started, false);
                started = true;
                // انتظار رسالة فوز من نفس البوت، بدون مهلة
                await channel.awaitMessages({
                    filter: m => m.author.id === game.bot_id && isWinMessage(m),
                    max: 1
                });
                await new Promise(r => setTimeout(r, waitMs));
            }
        }
    } finally {
        autoLocks.delete(key);
    }
}

async function maybeScheduledRun(client, guild, channel, runtime) {
    const settings = await getAccountSettings(runtime.agentId, guild.id);
    if (settings.mode !== 'schedule' || !settings.schedule_config?.slots?.length) return;
    const config = settings.schedule_config;
    const today = new Date();

    if (config.frequency === 'once') {
        if (config.executed_once) return;
    } else if (config.frequency === 'days') {
        if (!config.start_date) {
            const { updateAccountSettings } = require('./accountAgent');
            await updateAccountSettings(runtime.agentId, guild.id, { schedule_config: { ...config, start_date: today.toISOString() } });
            config.start_date = today.toISOString();
        }
        const start = new Date(config.start_date);
        const diffDays = Math.floor((today - start) / 86400000);
        if (diffDays >= (config.days_count || 1)) return;
    }

    const nowMins = nowInMinutes();
    for (const slot of config.slots) {
        if (isSlotActive(slot, nowMins)) {
            const key = seriesLockKey(runtime.agentId, guild.id, channel.id);
            // إذا كانت هناك أي سلسلة فعاليات (يدوية/تلقائية/جدولة) تعمل بالفعل، لا تبدأ
            if (autoLocks.get(key)) continue;

            if (config.frequency === 'once') {
                const { updateAccountSettings } = require('./accountAgent');
                await updateAccountSettings(runtime.agentId, guild.id, { schedule_config: { ...config, executed_once: true } });
            }

            // runScheduleSession ستتولى إدارة القفل بنفسها
            runScheduleSession(client, guild, channel, runtime, slot)
                .catch(() => {});
            break;
        }
    }
}

// ---------- الدورة الذكية الجديدة (تعمل بمؤقت واحد فقط) ----------
let mainScheduleTimer = null;

async function scheduleNextRun(manager) {
    if (mainScheduleTimer) clearTimeout(mainScheduleTimer);
    if (!manager || !manager.runtimes) return;

    let nearestTimeout = Infinity;
    const now = new Date();
    const nowMins = nowInMinutes();

    for (const [agentId, runtime] of manager.runtimes.entries()) {
        if (!runtime.client || !runtime.client.guilds) continue;
        for (const guild of runtime.client.guilds.cache.values()) {
            try {
                const settings = await getAccountSettings(agentId, guild.id);
                if (!settings || settings.mode !== 'schedule' || !settings.schedule_config?.slots?.length) continue;
                
                const config = settings.schedule_config;
                if (config.frequency === 'once' && config.executed_once) continue;
                if (config.frequency === 'days' && config.start_date) {
                    const start = new Date(config.start_date);
                    const diffDays = Math.floor((now - start) / 86400000);
                    if (diffDays >= (config.days_count || 1)) continue;
                }

                for (const slot of config.slots) {
                    const startMins = slotStartMinutes(slot);
                    if (startMins <= nowMins) continue;
                    
                    const diffMins = startMins - nowMins;
                    const timeoutMs = diffMins * 60 * 1000;
                    if (timeoutMs < nearestTimeout) {
                        nearestTimeout = timeoutMs;
                    }
                }
            } catch (_) {}
        }
    }

    if (nearestTimeout !== Infinity && nearestTimeout > 0) {
        console.log(`⏳ أقرب جلسة جدولة بعد ${Math.round(nearestTimeout / 60000)} دقيقة`);
        mainScheduleTimer = setTimeout(async () => {
            for (const [agentId, runtime] of manager.runtimes.entries()) {
                if (!runtime.client || !runtime.client.guilds) continue;
                for (const guild of runtime.client.guilds.cache.values()) {
                    try {
                        const settings = await getAccountSettings(agentId, guild.id);
                        if (!settings || settings.mode !== 'schedule') continue;
                        const channelId = settings.event_channel_id;
                        if (!channelId) continue;
                        const channel = await runtime.client.channels.fetch(channelId).catch(() => null);
                        if (!channel || !isTextChannel(channel)) continue;
                        maybeScheduledRun(runtime.client, guild, channel, runtime).catch(() => {});
                    } catch (_) {}
                }
            }
            scheduleNextRun(manager);
        }, nearestTimeout);
    }
}

function startScheduleTimers(manager) {
    if (!manager || !manager.runtimes) return;
    console.log('⏳ بدء نظام الجدولة الذكي (مؤقت دقيق)...');
    scheduleNextRun(manager);
    setInterval(() => scheduleNextRun(manager), 600000);
}

// ---------------------- باقي الدوال ----------------------

function humanizeDisplayName(name) {
    const raw = String(name || '').trim();
    const compact = raw
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[._~`^*|\[\]{}()<>،,؛:;!?\-_=+]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (/^s\s*u\s*k\s*u\s*n\s*a$/i.test(compact)) return 'سوكونا';
    return compact || raw || 'صاحب الحساب';
}

function mergeSettings(doc) {
    const merged = { ...DEFAULT_ACCOUNT_SETTINGS, ...(doc?.account || {}) };
    if (!merged.schedule_config || typeof merged.schedule_config !== 'object') {
        merged.schedule_config = { frequency: null, days_count: 1, start_date: null, executed_once: false, slots: [] };
    }
    return merged;
}

async function getAccountSettings(agentId, guildId) {
    const cfg = require('./config');
    const doc = await cfg.settings_col.findOne({ agent_id: String(agentId), guild_id: String(guildId) }).catch(() => null);
    return mergeSettings(doc);
}

async function updateAccountSettings(agentId, guildId, patch) {
    const cfg = require('./config');
    await cfg.settings_col.updateOne(
        { agent_id: String(agentId), guild_id: String(guildId) },
        { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`account.${k}`, v])), $setOnInsert: { created_at: new Date() } },
        { upsert: true },
    );
}

// ℹ️ مؤشر «يكتب...» البشري أُزيل بناءً على طلب المالك — الرد يتم مباشرة.

async function forwardMessage(client, message, targetChannelId, kind) {
    const target = await client.channels.fetch(String(targetChannelId)).catch(() => null);
    if (!target || !isTextChannel(target)) return false;
    // 🎨 Components V2 — بطاقة توجيه الحساب داخل حاوية موحدة مع أزرار التحكم
    const ui = require('./ui');
    const emb = ui.container({
        accent: kind === 'dm' ? ui.ACCENTS.live : ui.ACCENTS.info,
        title: kind === 'dm' ? '📩 رسالة خاصة للحساب' : '🔔 منشن/رد على الحساب',
        body: [
            (message.content || '—').slice(0, 1800),
            '',
            `**المرسل:** ${message.author.tag || message.author.username} (${message.author.id})`,
            `**الأصل:** ${message.url || `${message.channel?.id || 'DM'} / ${message.id}`}`,
            `**المرفقات:** ${message.attachments?.size ? message.attachments.map(a => `[${a.name}](${a.url})`).join('\n').slice(0, 900) : 'لا يوجد'}`,
            '',
            '> **طريقة التحكم:** رد على هذه الرسالة لإرسال رد مباشر. ابدأ بـ `!noreply` للإرسال بدون Reply، أو `!ai` للرد بالذكاء، أو `!ai !noreply` للذكاء بدون Reply.',
        ].join('\n'),
        rows: safeRows(kind),
    });
    const sent = await target.send(ui.v2Payload(emb)).catch(() => null);
    if (!sent) return false;
    bridge.set(sent.id, { kind, source_channel_id: message.channel.id, source_message_id: message.id, guild_id: message.guild?.id || null, author_id: message.author.id, created_at: Date.now() });
    return true;
}

function safeRows(kind) {
    try {
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`acct:${kind}:ai_reply`).setLabel('AI Reply').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`acct:${kind}:ai_noreply`).setLabel('AI No Reply').setStyle(ButtonStyle.Secondary),
        )];
    } catch (_) { return []; }
}

async function generateAiReply({ client, runtime, sourceMessage, controlMessage, replyMode }) {
    const guild = sourceMessage.guild || controlMessage.guild;
    const channel = sourceMessage.channel;
    const userInfo = `[معلومات المستخدم]\n  الاسم: ${sourceMessage.author.username}\n  الـ ID: ${sourceMessage.author.id}\n  المصدر: ${sourceMessage.guild ? '#' + sourceMessage.channel.name : 'DM'}\n`;
    const botContext = guild ? await buildBotContext(client, guild, channel, runtime.agentId, runtime.allowed_channels_cache) : '[DM Context]';
    const key = `${runtime.agentId}:${guild?.id || 'dm'}:${channel.id}`;
    let cs = memory.get(key) || await db_load_channel_session(guild?.id || 'dm', channel.id, runtime.agentId) || { session_id: null, parent_message_id: null, mode: 'account', thinking: false };
    const result = await runAgent(guild, channel, sourceMessage.content || '', userInfo, botContext, humanizeDisplayName(client.user.displayName || client.user.username), cs.session_id, cs.parent_message_id, guild?.id || 'dm', 'account', false, 'owner', client, runtime, { userId: sourceMessage.author.id, username: sourceMessage.author.username, channelId: channel.id });
    cs = { ...cs, session_id: result.newSid, parent_message_id: result.newPmid };
    memory.set(key, cs);
    if (result.newSid) await db_save_channel_session(guild?.id || 'dm', channel.id, result.newSid, result.newPmid, 'account', false, runtime.agentId).catch(() => {});
    const text = result.reply || 'تمام';
    return replyMode === 'reply' ? sourceMessage.reply(text.slice(0, 2000)) : channel.send(text.slice(0, 2000));
}

async function handleAccountInteraction(client, interaction, runtime) {
    const meta = bridge.get(interaction.message?.id);
    if (!meta || !interaction.customId?.startsWith('acct:')) return false;
    const sourceChannel = await client.channels.fetch(meta.source_channel_id).catch(() => null);
    const sourceMessage = await sourceChannel?.messages?.fetch?.(meta.source_message_id).catch(() => null);
    if (!sourceMessage) {
        await interaction.reply({ content: '❌ لم أجد الرسالة الأصلية.', ephemeral: true }).catch(() => {});
        return true;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const replyMode = interaction.customId.endsWith('ai_noreply') ? 'send' : 'reply';
    await generateAiReply({ client, runtime, sourceMessage, controlMessage: interaction.message, replyMode });
    await interaction.editReply({ content: '✅ تم إرسال رد الذكاء الاصطناعي.' }).catch(() => {});
    return true;
}

async function handleControlReply(client, message, runtime) {
    if (!message.reference?.messageId || message.author.id === client.user.id) return false;
    const ref = await message.fetchReference().catch(() => null);
    const meta = ref ? bridge.get(ref.id) : null;
    if (!meta) return false;
    const sourceChannel = await client.channels.fetch(meta.source_channel_id).catch(() => null);
    const sourceMessage = await sourceChannel?.messages?.fetch?.(meta.source_message_id).catch(() => null);
    if (!sourceMessage) return false;
    const raw = String(message.content || '').trim();
    const noReply = /^!ai\s+!noreply|^!noreply/i.test(raw);
    const ai = raw.startsWith('!ai');
    if (ai) await generateAiReply({ client, runtime, sourceMessage, controlMessage: message, replyMode: noReply ? 'send' : 'reply' });
    else {
        const text = raw.replace(/^!ai\s+!noreply\s*/i, '').replace(/^!noreply\s*/i, '').trim();
        if (!text) return true;
        if (noReply) await sourceMessage.channel.send(text.slice(0, 2000));
        else await sourceMessage.reply(text.slice(0, 2000));
    }
    await message.react('☑️').catch(() => {});
    return true;
}

async function trackGameMessage(client, message, runtime) {
    if (!message.guild || !message.author?.bot) return false;
    const settings = await getAccountSettings(runtime.agentId, message.guild.id);

    // إذا كانت هناك جلسة تشغيل يدوي بدون كردت، لا يتم التوجيه
    const noCreditsKey = `${runtime.agentId}:${message.guild.id}`;
    if (manualRunNoCredits.get(noCreditsKey)) return false;

    // في وضع no_credits الدائم لا نرسل أي نتيجة إلى قناة التسليمات
    if (settings.mode === 'no_credits') return false;

    if (!settings.games.some(g => String(g.bot_id) === String(message.author.id))) return false;
    if (message.channel.id !== settings.event_channel_id) return false;
    if (!isWinMessage(message)) return false;

    const deliveries = await client.channels.fetch(settings.deliveries_channel_id).catch(() => null);
    if (!deliveries || !isTextChannel(deliveries)) return false;
    const forwarded = await message.forward(deliveries).catch(() => null);
    await remember(runtime.agentId, message.guild.id, { type: 'game_result', bot_id: message.author.id, message_id: message.id, forwarded_id: forwarded?.id || null, content: (message.content || '').slice(0, 500) });
    return true;
}

async function remember(agentId, guildId, event) {
    const cfg = require('./config');
    await cfg.logs_col.insertOne({ agent_id: String(agentId), guild_id: String(guildId), type: 'account_memory', message: event.type, extra: event, created_at: new Date() }).catch(() => {});
}

/**
 * بدء فعالية عشوائية مع توزيع عادل.
 * @param {boolean} noCredits - إذا كان true، الفعالية الأولى فقط بمكافأة، والباقي بدون (بغض النظر عن الإعدادات)
 */
async function startEvent(client, guild, channel, runtime, gameName = null, first = false, noCredits = false) {
    const settings = await getAccountSettings(runtime.agentId, guild.id);
    const games = settings.games;

    const last = await require('./config').logs_col.find({
        agent_id: String(runtime.agentId),
        guild_id: String(guild.id),
        type: 'account_memory',
        message: 'event_start'
    }).sort({ created_at: -1 }).limit(3).toArray().catch(() => []);
    const recentNames = new Set(last.map(x => x.extra?.game));

    let candidates;
    if (gameName) {
        candidates = games.filter(g => g.name.includes(gameName));
        if (candidates.length === 0) candidates = games;
    } else if (first) {
        candidates = games.filter(g => g.first_reward === '.' && ['مافيا', 'روليت', 'غميضه'].includes(g.name));
        if (candidates.length === 0) candidates = games;
    } else {
        candidates = games;
    }

    let pool = candidates.filter(g => !recentNames.has(g.name));
    if (pool.length === 0) pool = candidates;

    const game = pool[Math.floor(Math.random() * pool.length)];

    let reward;
    if (noCredits) {
        reward = first ? game.first_reward : '';
    } else if (settings.mode === 'no_credits') {
        reward = first ? game.first_reward : '';
    } else {
        reward = first ? game.first_reward : game.reward;
    }

    const mention = first && settings.first_event_announces_everyone ? '@everyone' : `<@&${settings.event_role_id}>`;
    const allowedMentions = first && settings.first_event_announces_everyone
        ? { parse: ['everyone'] }
        : { roles: [settings.event_role_id], parse: [] };

    const contentLine = reward ? `# ${game.name} ${reward}` : `# ${game.name}`;
    await channel.send({ content: `${contentLine}\n${mention}`, allowedMentions });

    await new Promise(r => setTimeout(r, Number(settings.event_wait_ms || 40000)));
    await channel.send(game.command);
    await remember(runtime.agentId, guild.id, {
        type: 'event_start',
        game: game.name,
        command: game.command,
        bot_id: game.bot_id,
        channel_id: channel.id,
        by: client.user.id
    });
    return game;
}

async function runEventSeries(client, guild, channel, runtime, options = {}) {
    const settings = await getAccountSettings(runtime.agentId, guild.id);
    const minutesLimit = Math.max(0, Number(options.minutes || settings.manual_default_minutes || 0));
    const fallbackCount = minutesLimit ? 50 : (settings.manual_default_count || 1);
    const countLimit = Math.max(1, Math.min(Number(options.count || fallbackCount), 50));
    const startedAt = Date.now();
    const results = [];
    const key = seriesLockKey(runtime.agentId, guild.id, channel.id);
    if (autoLocks.get(key)) return { ok: false, msg: 'هناك سلسلة فعاليات تعمل بالفعل لهذه القناة.', results };
    autoLocks.set(key, true);
    try {
        for (let i = 0; i < countLimit; i++) {
            if (minutesLimit && Date.now() - startedAt >= minutesLimit * 60 * 1000) break;
            const game = await startEvent(client, guild, channel, runtime, options.gameName || null, i === 0 && Boolean(options.first), false);
            results.push(game);
            if (i < countLimit - 1) {
                // انتظار رسالة فوز من بوت اللعبة الذي شغّلناه في نفس القناة، بدون مهلة زمنية
                await channel.awaitMessages({
                    filter: m => m.author.id === game.bot_id && isWinMessage(m),
                    max: 1
                });
            }
        }
        return { ok: true, msg: `تم تشغيل ${results.length} فعالية.`, results };
    } finally {
        autoLocks.delete(key);
    }
}

function parseScheduleSlot(slot) {
    const m = String(slot || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})(?:#(\d+))?$/);
    if (!m) return null;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    return { start, end, count: Number(m[5] || 0) };
}

async function maybeScheduledEvent(client, message, runtime) {
    return false;
}

function rememberActivity(agentId, message) {
    if (!message.guild || message.author?.bot) return;
    const key = `${agentId}:${message.guild.id}:${message.channel.id}`;
    const now = Date.now();
    const list = (activity.get(key) || []).filter(ts => now - ts < 10 * 60 * 1000);
    list.push(now);
    activity.set(key, list);
}

async function maybeAutoEvent(client, message, runtime) {
    if (!message.guild || message.author?.bot) return false;
    const settings = await getAccountSettings(runtime.agentId, message.guild.id);
    if (settings.mode !== 'auto') return false;
    const channelId = settings.event_channel_id || message.channel.id;
    const key = seriesLockKey(runtime.agentId, message.guild.id, channelId);

    // إذا كانت هناك سلسلة نشطة بالفعل، لا تبدأ
    if (autoLocks.get(key)) return false;

    const last = await require('./config').logs_col.findOne({
        agent_id: String(runtime.agentId),
        guild_id: String(message.guild.id),
        type: 'account_memory',
        message: 'event_start'
    }, { sort: { created_at: -1 } }).catch(() => null);
    const inactiveMs = Number(settings.auto_inactivity_minutes || 20) * 60 * 1000;
    if (last?.created_at && Date.now() - new Date(last.created_at).getTime() < inactiveMs) return false;
    const recentCount = (activity.get(key) || []).filter(ts => Date.now() - ts < 10 * 60 * 1000).length;
    if (recentCount > Number(settings.auto_min_messages_10m || 3)) return false;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !isTextChannel(channel)) return false;

    // runEventSeries ستتولى إدارة القفل بنفسها
    runEventSeries(client, message.guild, channel, runtime, {
        count: settings.auto_run_count || 3,
        minutes: settings.auto_run_minutes || 0,
        first: !last
    }).catch(() => {});
    return true;
}

async function summarizeMemory(agentId, guildId, limit = 10) {
    const cfg = require('./config');
    const rows = await cfg.logs_col.find({
        agent_id: String(agentId),
        guild_id: String(guildId),
        type: 'account_memory'
    }).sort({ created_at: -1 }).limit(limit).toArray().catch(() => []);
    return rows.map(r => ({ at: r.created_at, kind: r.message, ...r.extra }));
}

module.exports = {
    humanizeDisplayName,
    getAccountSettings,
    updateAccountSettings,
    forwardMessage,
    handleAccountInteraction,
    handleControlReply,
    trackGameMessage,
    startEvent,
    runEventSeries,
    rememberActivity,
    maybeAutoEvent,
    maybeScheduledEvent,
    maybeScheduledRun,
    startScheduleTimers,
    summarizeMemory,
    DEFAULT_ACCOUNT_SETTINGS,
    WIN_RE,
    isWinMessage,
    manualRunNoCredits   // تصدير الـ Map لاستخدامه من dashboard
};