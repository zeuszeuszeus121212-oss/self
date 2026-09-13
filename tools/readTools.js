/**
 * tools/readTools.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * جميع أدوات القراءة (القديمة + الجديدة)
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { ChannelType } = require('discord.js');
const { isTextChannel, isVoiceChannel, isCategoryChannel } = require('../discordAdapter');

const {
    _err,
    findChannel, findRole, findMember, findGuild,
} = require('../utils');

// ══════════════════════════════════════════════════════════════
//  READ TOOLS — أدوات القراءة
// ══════════════════════════════════════════════════════════════

/**
 * يجيب قائمة القنوات في السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolGetChannels(guild) {
    const rows = [];
    for (const ch of guild.channels.cache.values()) {
        if (isCategoryChannel(ch)) continue;
        rows.push({
            id      : ch.id,
            name    : ch.name,
            type    : isTextChannel(ch) ? 'text' : 'voice',
            category: ch.parent ? ch.parent.name : null,
        });
    }
    return { channels: rows };
}

/**
 * يجيب قائمة الكاتيجوريات في السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolGetCategories(guild) {
    const cats = guild.channels.cache
        .filter(ch => isCategoryChannel(ch))
        .map(c => ({ id: c.id, name: c.name, position: c.position }));
    return { categories: [...cats] };
}

/**
 * يجيب قائمة الرتب في السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolGetRoles(guild) {
    const roles = guild.roles.cache.map(r => ({
        id      : r.id,
        name    : r.name,
        color   : r.hexColor,
        position: r.position,
        perms   : r.permissions.toArray(),
    }));
    return { roles };
}

/**
 * يجيب قائمة الأعضاء (مع خيار بحث)
 * @param {import('discord.js').Guild} guild
 * @param {string|null} query
 * @returns {object}
 */
async function toolGetMembers(guild, query = null, options = {}) {
    if (guild.members?.fetch) {
        await guild.members.fetch().catch(() => null);
    }
    let members = [...guild.members.cache.values()];
    if (query) {
        const ql = query.toLowerCase();
        members  = members.filter(m =>
            m.user.username.toLowerCase().includes(ql) ||
            (m.nickname && m.nickname.toLowerCase().includes(ql)) ||
            (m.user.globalName && m.user.globalName.toLowerCase().includes(ql)),
        );
    }
    const includeBots = options.include_bots !== false;
    const onlyBots = options.type === 'bots';
    const onlyHumans = options.type === 'humans' || options.include_bots === false;
    if (onlyBots) members = members.filter(m => m.user.bot);
    else if (onlyHumans) members = members.filter(m => !m.user.bot);
    const page = Math.max(1, Number(options.page || 1));
    const pageSize = Math.max(1, Math.min(Number(options.page_size || 100), 500));
    const start = (page - 1) * pageSize;
    const pageRows = members.slice(start, start + pageSize);
    return {
        page,
        page_size: pageSize,
        total: members.length,
        humans: members.filter(m => !m.user.bot).length,
        bots: members.filter(m => m.user.bot).length,
        has_more: start + pageSize < members.length,
        members: pageRows.map(m => ({
            id         : m.id,
            username   : m.user.username,
            global_name: m.user.globalName || null,
            nickname   : m.nickname || null,
            display    : m.displayName,
            roles      : m.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
            bot        : m.user.bot,
        })),
    };
}

/**
 * يجيب معلومات السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolServerInfo(guild) {
    const nonCatChannels = guild.channels.cache.filter(c => !isCategoryChannel(c));
    return {
        name        : guild.name,
        id          : guild.id,
        member_count: guild.memberCount,
        owner_id    : guild.ownerId,
        created_at  : guild.createdAt.toISOString().slice(0, 10),
        boost_level : guild.premiumTier,
        boosts      : guild.premiumSubscriptionCount,
        channels    : nonCatChannels.size,
        categories  : guild.channels.cache.filter(c => isCategoryChannel(c)).size,
        roles       : guild.roles.cache.size,
        icon_url    : guild.iconURL() || null,
        description : guild.description || null,
    };
}

/**
 * يجيب قائمة جميع السيرفرات التي البوت فيها — owner only
 * @param {import('discord.js').Client} client
 * @returns {object}
 */
function toolListAllGuilds(client) {
    const rows = [];
    for (const g of client.guilds.cache.values()) {
        const botMember = g.members.cache.get(client.user.id);
        const isAdmin   = Boolean(botMember && botMember.permissions.has('Administrator'));
        rows.push({
            id          : g.id,
            name        : g.name,
            member_count: g.memberCount,
            owner_id    : g.ownerId,
            bot_is_admin: isAdmin,
            channels    : g.channels.cache.filter(c => !isCategoryChannel(c)).size,
            roles       : g.roles.cache.size,
        });
    }
    return { guilds: rows, total: rows.length };
}

/**
 * يجيب رسائل القناة
 * @param {import('discord.js').TextChannel} channel
 * @param {number} limit
 * @param {string|null} memberId
 * @returns {Promise<object>}
 */
async function toolGetMessages(channel, limit = 100, memberId = null) {
    const msgs    = [];
    const fetched = await channel.messages.fetch({ limit: Math.min(limit, 500) });
    for (const msg of fetched.values()) {
        if (memberId && msg.author.id !== String(memberId)) continue;
        msgs.push({
            id        : msg.id,
            author    : msg.author.displayName || msg.author.username,
            author_id : msg.author.id,
            content   : msg.content.slice(0, 500),
            time      : msg.createdAt.toISOString().slice(0, 16).replace('T', ' '),
        });
    }
    return { messages: msgs, count: msgs.length };
}

/**
 * يجيب سجل التدقيق
 * @param {import('discord.js').Guild} guild
 * @param {number} limit
 * @param {string|null} action
 * @returns {Promise<object>}
 */
async function toolGetAuditLog(guild, limit = 20, action = null) {
    const entries = [];
    try {
        const kwargs = { limit: Math.min(Number(limit), 100) };
        if (action) {
            // محاولة تحويل الـ action string إلى enum value
            const { AuditLogEvent } = require('discord.js');
            const actionKey = Object.keys(AuditLogEvent).find(
                k => k.toLowerCase() === action.toLowerCase().trim(),
            );
            if (actionKey) kwargs.type = AuditLogEvent[actionKey];
        }
        const logs = await guild.fetchAuditLogs(kwargs);
        for (const entry of logs.entries.values()) {
            entries.push({
                id        : entry.id,
                action    : String(entry.action),
                user      : entry.executor?.displayName || null,
                user_id   : entry.executor?.id || null,
                target    : entry.target ? String(entry.target.id || entry.target) : null,
                reason    : entry.reason || null,
                created_at: entry.createdAt.toISOString().slice(0, 16).replace('T', ' '),
            });
        }
    } catch (e) {
        if (e.code === 50013) return _err("⛔ البوت لا يملك صلاحية 'عرض سجل التدقيق'.");
        return _err(`❌ فشل جلب سجل التدقيق: ${e.message}`);
    }
    return { audit_log: entries, count: entries.length };
}

/**
 * يجيب دعوات السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<object>}
 */
async function toolGetInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        return {
            invites: invites.map(inv => ({
                code      : inv.code,
                url       : inv.url,
                channel   : inv.channel?.name || null,
                inviter   : inv.inviter?.displayName || null,
                uses      : inv.uses,
                max_uses  : inv.maxUses,
                expires_at: inv.expiresAt ? inv.expiresAt.toISOString().slice(0, 16).replace('T', ' ') : null,
            })).slice(0, 100),
            count: invites.size,
        };
    } catch (e) {
        return _err("⛔ البوت لا يملك صلاحية 'إدارة السيرفر' لعرض الدعوات.");
    }
}

/** يجيب الإيموجيات */
function toolGetEmojis(guild) {
    // المالك طلب: عرض الإيموجيات المتاحة فعلاً فقط (غير المقفلة/المحذوفة) —
    // الإيموجي بـ available=false سيفشل إرساله بسبب مستوى التعزيز، فلا يظهر أصلاً.
    const emojis = guild.emojis.cache
        .filter(e => e.available !== false && !e.deleted)
        .map(e => ({
            id       : e.id,
            name     : e.name,
            animated : e.animated,
            available: e.available,
            url      : e.url,
        }));
    const lockedCount = guild.emojis.cache.size - emojis.length;
    return { emojis, count: emojis.length, locked_excluded: lockedCount > 0 ? lockedCount : undefined };
}

/** يجيب الملصقات */
function toolGetStickers(guild) {
    const stickers = guild.stickers.cache.map(s => ({
        id         : s.id,
        name       : s.name,
        description: s.description || null,
        emoji      : s.tags || null,
        url        : s.url,
    }));
    return { stickers, count: stickers.length };
}

/** يجيب قائمة المحظورين */
async function toolGetBans(guild, limit = 100) {
    const bans = [];
    try {
        const fetched = await guild.bans.fetch({ limit: Math.min(Number(limit), 1000) });
        for (const ban of fetched.values()) {
            bans.push({
                user_id : ban.user.id,
                username: ban.user.username,
                display : ban.user.displayName || ban.user.username,
                reason  : ban.reason || null,
            });
        }
    } catch (e) {
        return _err("⛔ البوت لا يملك صلاحية 'حظر الأعضاء' لعرض البانات.");
    }
    return { bans, count: bans.length };
}

/** يجيب الرسائل المثبتة في القناة */
async function toolGetPinnedMessages(channel) {
    const pins = await channel.messages.fetchPinned();
    return {
        pinned_messages: [...pins.values()].slice(0, 50).map(msg => ({
            id        : msg.id,
            author    : msg.author.displayName || msg.author.username,
            author_id : msg.author.id,
            content   : msg.content.slice(0, 500),
            created_at: msg.createdAt.toISOString().slice(0, 16).replace('T', ' '),
            jump_url  : msg.url,
        })),
        count: pins.size,
    };
}

/** يجيب حالات الفويس في السيرفر */
function toolGetVoiceStates(guild) {
    const rows = [];
    for (const vc of guild.channels.cache.values()) {
        if (!isVoiceChannel(vc)) continue;
        for (const member of vc.members.values()) {
            const vs = member.voice;
            rows.push({
                member_id : member.id,
                display   : member.displayName,
                channel_id: vc.id,
                channel   : vc.name,
                muted     : Boolean(vs && (vs.mute || vs.selfMute)),
                deafened  : Boolean(vs && (vs.deaf || vs.selfDeaf)),
                streaming : Boolean(vs && vs.streaming),
            });
        }
    }
    return { voice_states: rows, count: rows.length };
}

/** يبحث في رسائل القناة */
async function toolSearchMessages(channel, query, limit = 200) {
    const ql      = String(query).toLowerCase().trim();
    const matches = [];
    const fetched = await channel.messages.fetch({ limit: Math.min(Number(limit), 1000) });
    for (const msg of fetched.values()) {
        if (ql && msg.content.toLowerCase().includes(ql)) {
            matches.push({
                id        : msg.id,
                author    : msg.author.displayName || msg.author.username,
                author_id : msg.author.id,
                content   : msg.content.slice(0, 500),
                time      : msg.createdAt.toISOString().slice(0, 16).replace('T', ' '),
                jump_url  : msg.url,
            });
        }
        if (matches.length >= 50) break;
    }
    return { matches, count: matches.length };
}

/** يجيب نظرة عامة على إدارة السيرفر */
function toolModerationOverview(guild, client) {
    const botMember = guild.members.cache.get(client.user.id);
    return {
        server                  : guild.name,
        members                 : guild.memberCount,
        roles                   : guild.roles.cache.size,
        text_channels           : guild.channels.cache.filter(c => isTextChannel(c)).size,
        voice_channels          : guild.channels.cache.filter(c => isVoiceChannel(c)).size,
        categories              : guild.channels.cache.filter(c => isCategoryChannel(c)).size,
        boost_level             : guild.premiumTier,
        bot_top_role            : botMember?.roles.highest.name || null,
        bot_permissions         : botMember?.permissions.toArray() || [],
        verification_level      : String(guild.verificationLevel),
        explicit_content_filter : String(guild.explicitContentFilter),
    };
}

/** يجيب أحدث الأعضاء انضماماً */
function toolRecentJoins(guild, limit = 20) {
    const members = [...guild.members.cache.values()]
        .filter(m => m.joinedAt)
        .sort((a, b) => b.joinedAt - a.joinedAt)
        .slice(0, Math.min(Number(limit), 100));
    return {
        recent_joins: members.map(m => ({
            id       : m.id,
            display  : m.displayName,
            username : m.user.username,
            joined_at: m.joinedAt.toISOString().slice(0, 16).replace('T', ' '),
        })),
        count: members.length,
    };
}

/** يجيب الأعضاء غير النشطين (حسب تاريخ الانضمام) */
function toolInactiveMembers(guild, days = 30, limit = 50) {
    const cutoff = new Date(Date.now() - Math.max(1, Number(days)) * 86400000);
    const rows   = [];
    for (const m of guild.members.cache.values()) {
        if (m.user.bot) continue;
        if (m.joinedAt && m.joinedAt < cutoff) {
            rows.push({
                id       : m.id,
                display  : m.displayName,
                username : m.user.username,
                joined_at: m.joinedAt.toISOString().slice(0, 16).replace('T', ' '),
                roles    : m.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
            });
        }
        if (rows.length >= Math.min(Number(limit), 100)) break;
    }
    return { inactive_members: rows, count: rows.length, days };
}

/** يجيب أعضاء رتبة محددة */
async function toolRoleMembers(guild, role, limit = 100) {
    await guild.members.fetch().catch(() => null);
    const roleObj = findRole(guild, String(role));
    if (!roleObj) return _err(`ما لقيت رتبة: ${role}`);
    const members = [...roleObj.members.values()].slice(0, Math.min(Number(limit), 500));
    return {
        role   : roleObj.name,
        members: members.map(m => ({ id: m.id, display: m.displayName, username: m.user.username })),
        count  : members.length,
    };
}

/** يجيب صلاحيات القنوات */
function toolChannelPermissions(guild, channelName = null) {
    const ch = channelName ? findChannel(guild, String(channelName)) : null;
    if (channelName && !ch) return _err(`ما لقيت قناة: ${channelName}`);
    const channels = ch ? [ch] : [...guild.channels.cache.values()].slice(0, 50);
    const rows     = channels.map(channel => {
        const overwrites = [];
        for (const [targetId, ow] of channel.permissionOverwrites.cache) {
            const target = guild.roles.cache.get(targetId) || guild.members.cache.get(targetId);
            overwrites.push({
                target: target?.name || target?.displayName || String(targetId),
                type  : guild.roles.cache.has(targetId) ? 'role' : 'member',
                allow : ow.allow.toArray(),
                deny  : ow.deny.toArray(),
            });
        }
        return { id: channel.id, name: channel.name, type: String(channel.type), overwrites };
    });
    return { channel_permissions: rows, count: rows.length };
}

// ══════════════════════════════════════════════════════════════
//  NEW READ TOOLS — 10 أدوات جديدة
// ══════════════════════════════════════════════════════════════

/** يجيب كل webhooks في السيرفر */
async function toolGetWebhooks(guild) {
    try {
        const webhooks = await guild.fetchWebhooks();
        return {
            webhooks: webhooks.map(wh => ({
                id        : wh.id,
                name      : wh.name,
                channel   : wh.channel?.name || null,
                url       : wh.url,
                created_by: wh.owner?.displayName || null,
            })),
            count: webhooks.size,
        };
    } catch (e) {
        return _err("⛔ البوت لا يملك صلاحية 'إدارة الويبهوكس'.");
    }
}

/** يجيب الفعاليات المجدولة في السيرفر */
async function toolGetScheduledEvents(guild) {
    try {
        const events = await guild.scheduledEvents.fetch();
        return {
            events: events.map(ev => ({
                id         : ev.id,
                name       : ev.name,
                description: ev.description || null,
                status     : String(ev.status),
                start_time : ev.scheduledStartAt?.toISOString().slice(0, 16).replace('T', ' ') || null,
                end_time   : ev.scheduledEndAt?.toISOString().slice(0, 16).replace('T', ' ') || null,
                subscribers: ev.userCount || 0,
                creator    : ev.creator?.displayName || null,
            })),
            count: events.size,
        };
    } catch (e) {
        return _err(`❌ فشل جلب الفعاليات: ${e.message}`);
    }
}

/** يجيب الثريدات النشطة في السيرفر أو في قناة محددة */
async function toolGetThreads(guild, channelName = null) {
    try {
        let threads = [];
        if (channelName) {
            const ch = findChannel(guild, channelName);
            if (!ch || !isTextChannel(ch)) {
                return _err(`ما لقيت قناة نصية: ${channelName}`);
            }
            threads = [...ch.threads.cache.values()];
        } else {
            for (const ch of guild.channels.cache.values()) {
                if (isTextChannel(ch) && ch.threads) {
                    threads.push(...ch.threads.cache.values());
                }
            }
        }
        return {
            threads: threads.slice(0, 100).map(t => ({
                id      : t.id,
                name    : t.name,
                parent  : t.parent?.name || null,
                archived: t.archived,
                locked  : t.locked,
                messages: t.messageCount || 0,
                members : t.memberCount || 0,
            })),
            count: threads.length,
        };
    } catch (e) {
        return _err(`❌ خطأ في جلب الثريدات: ${e.message}`);
    }
}

/** يجيب قائمة الأعضاء الذين يبوستون السيرفر */
function toolGetNitroBoosters(guild) {
    const boosters = guild.members.cache.filter(m => m.premiumSince).values();
    const rows     = [];
    for (const m of boosters) {
        rows.push({
            id            : m.id,
            display       : m.displayName,
            username      : m.user.username,
            boosting_since: m.premiumSince ? m.premiumSince.toISOString().slice(0, 10) : null,
        });
    }
    return {
        boosters    : rows,
        count       : rows.length,
        boost_level : guild.premiumTier,
        total_boosts: guild.premiumSubscriptionCount,
    };
}

/** يجيب قائمة البوتات الموجودة في السيرفر — owner only */
function toolGetBotList(guild) {
    const bots = guild.members.cache.filter(m => m.user.bot).map(b => ({
        id      : b.id,
        username: b.user.username,
        display : b.displayName,
        roles   : b.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
        joined  : b.joinedAt ? b.joinedAt.toISOString().slice(0, 10) : null,
    }));
    return { bots, count: bots.length };
}

/** يجيب معلومات تفصيلية عن عضو واحد */
async function toolGetMemberInfo(guild, memberQuery) {
    let member = await findMember(guild, memberQuery);
    if (!member) {
        try {
            member = await guild.members.fetch(String(memberQuery).trim());
        } catch (_) {
            return _err(`ما لقيت العضو: ${memberQuery}`);
        }
    }
    const perms = member.permissions;
    return {
        id             : member.id,
        username       : member.user.username,
        global_name    : member.user.globalName || null,
        nickname       : member.nickname || null,
        display        : member.displayName,
        bot            : member.user.bot,
        joined_at      : member.joinedAt ? member.joinedAt.toISOString().slice(0, 16).replace('T', ' ') : null,
        created_at     : member.user.createdAt.toISOString().slice(0, 16).replace('T', ' '),
        premium_since  : member.premiumSince ? member.premiumSince.toISOString().slice(0, 10) : null,
        roles          : member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
        top_role       : member.roles.highest.name,
        is_admin       : perms.has('Administrator'),
        key_permissions: perms.toArray().slice(0, 20),
        avatar         : member.displayAvatarURL() || null,
        timed_out_until: member.communicationDisabledUntil
            ? member.communicationDisabledUntil.toISOString().slice(0, 16).replace('T', ' ')
            : null,
    };
}


/** يستكشف أوامر بوت من الرسائل الحديثة والبريفكسات والألعاب المعروفة */
async function toolGetBotCommands(guild, botQuery, channel = null, limit = 300) {
    let bot = await findMember(guild, String(botQuery || '')).catch(() => null);
    if (!bot && botQuery) {
        try { bot = await guild.members.fetch(String(botQuery).trim()); } catch (_) {}
    }
    if (!bot || !bot.user?.bot) return _err(`ما لقيت بوت بهذا المعرف/الاسم: ${botQuery}`);
    const prefixes = ['+', '.', '!', '-', '$', '?', '/'];
    const commandHits = new Map();
    const channels = channel && isTextChannel(channel)
        ? [channel]
        : [...guild.channels.cache.values()].filter(isTextChannel).slice(0, 8);
    for (const ch of channels) {
        const fetched = await ch.messages.fetch({ limit: Math.min(Number(limit), 100) }).catch(() => null);
        if (!fetched) continue;
        for (const msg of fetched.values()) {
            const text = String(msg.content || '').trim();
            if (!text) continue;
            const authorIsBot = msg.author?.id === bot.id;
            const mentionsBot = msg.mentions?.users?.has?.(bot.id);
            const looksCommand = prefixes.some(p => text.startsWith(p));
            if (!authorIsBot && !mentionsBot && !looksCommand) continue;
            const first = text.split(/\s+/)[0].slice(0, 80);
            if (!first) continue;
            const row = commandHits.get(first) || { command: first, count: 0, samples: [] };
            row.count += 1;
            if (row.samples.length < 3) row.samples.push({ channel: ch.name, author_id: msg.author?.id, content: text.slice(0, 160) });
            commandHits.set(first, row);
        }
    }
    const knownGames = [
        { name: 'مافيا', command: '+مافيا', bot_id: '1508592252220477651' },
        { name: 'الجاسوس', command: '+الجاسوس', bot_id: '1508592252220477651' },
        { name: 'محبس', command: '+محبس', bot_id: '1508592252220477651' },
        { name: 'روليت', command: '.روليت', bot_id: '1006332825571692544' },
        { name: 'لغم', command: '.لغم', bot_id: '1006332825571692544' },
        { name: 'غميضه', command: '.غميضه', bot_id: '1006332825571692544' },
        { name: 'حجرة', command: '.حجرة', bot_id: '1006332825571692544' },
        { name: 'سباق', command: '.سباق', bot_id: '1006332825571692544' },
        { name: 'كراسي', command: '.كراسي', bot_id: '1006332825571692544' },
    ].filter(g => g.bot_id === bot.id);
    return {
        bot: { id: bot.id, username: bot.user.username, display: bot.displayName, roles: bot.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name) },
        inferred_prefixes: [...new Set([...commandHits.keys()].map(c => c[0]).filter(c => prefixes.includes(c)))],
        known_games: knownGames,
        observed_commands: [...commandHits.values()].sort((a, b) => b.count - a.count).slice(0, 40),
        note: 'هذه نتيجة استنتاج من الرسائل الحديثة والخرائط المعروفة؛ للبوتات التي تعتمد Slash قد تظهر أوامر أقل إذا لم توجد رسائل حديثة.'
    };
}

/** يحلل بوت ويقترح طريقة التعامل معه */
async function toolAnalyzeBot(guild, botQuery, channel = null) {
    const commands = await toolGetBotCommands(guild, botQuery, channel, 200);
    if (commands.ok === false) return commands;
    const prefixes = commands.inferred_prefixes?.length ? commands.inferred_prefixes : ['غير واضح'];
    return {
        ...commands,
        strategy: [
            `ابدأ بتجربة أوامر المساعدة الشائعة: ${prefixes.map(p => `${p}help`).join(' / ')}`,
            'راقب رسائل البوت بعد كل أمر ولا تكرر الإرسال بسرعة.',
            'إذا ظهر لوبي أو أزرار تفاعلية، اقرأ نص الرسالة وحدد المطلوب قبل الخطوة التالية.',
            'لألعاب الفعاليات: انتظر كلمات الفوز/النتيجة ثم استخدم forward/التسليمات بدل نسخ النص.'
        ],
    };
}



/** يحلل بنية السيرفر كاملة للاستنساخ أو التدقيق */
function toolServerBlueprint(guild) {
    return {
        server: toolServerInfo(guild),
        roles: toolGetRoles(guild).roles,
        categories: toolGetCategories(guild).categories,
        channels: toolGetChannels(guild).channels,
        permissions: toolChannelPermissions(guild).channel_permissions,
        emojis: toolGetEmojis(guild),
        stickers: toolGetStickers(guild),
    };
}

/** يلخص مخاطر الصلاحيات العالية */
function toolPermissionAudit(guild) {
    const risky = [];
    for (const role of guild.roles.cache.values()) {
        const perms = role.permissions.toArray();
        const hits = perms.filter(p => ['Administrator','ManageGuild','ManageRoles','ManageChannels','BanMembers','KickMembers','MentionEveryone','ManageWebhooks'].includes(p));
        if (hits.length) risky.push({ id: role.id, name: role.name, position: role.position, permissions: hits, members: role.members.size });
    }
    return { risky_roles: risky.sort((a, b) => b.position - a.position), count: risky.length };
}

/** يعرض إحصاءات نشاط القنوات من الرسائل الحديثة */
async function toolChannelActivity(guild, limitPerChannel = 50) {
    const rows = [];
    for (const ch of guild.channels.cache.values()) {
        if (!isTextChannel(ch)) continue;
        const fetched = await ch.messages.fetch({ limit: Math.min(Number(limitPerChannel), 100) }).catch(() => null);
        if (!fetched) continue;
        const users = new Set([...fetched.values()].filter(m => !m.author.bot).map(m => m.author.id));
        rows.push({ id: ch.id, name: ch.name, recent_messages: fetched.size, human_speakers: users.size, last_message_id: ch.lastMessageId || null });
    }
    return { channels: rows.sort((a, b) => b.recent_messages - a.recent_messages), count: rows.length };
}

/** يفحص صحة إعدادات الوكيل في السيرفر */
async function toolAgentConfigAudit(guild, agentId) {
    const { get_allowed_channels, get_control_role } = require('../utils');
    const { getAccountSettings } = require('../accountAgent');
    const allowed = await get_allowed_channels(guild.id, agentId).catch(() => []);
    const account = await getAccountSettings(agentId, guild.id).catch(() => ({}));
    return {
        allowed_channels: allowed.map(id => ({ id, exists: Boolean(guild.channels.cache.get(id)), mention: `<#${id}>` })),
        control_role: await get_control_role(guild.id, agentId).catch(() => null),
        account_channels: ['dm_channel_id','mention_channel_id','event_channel_id','deliveries_channel_id'].map(k => ({ key: k, id: account[k] || null, exists: account[k] ? Boolean(guild.channels.cache.get(account[k])) : false })),
        event_role: { id: account.event_role_id || null, exists: account.event_role_id ? Boolean(guild.roles.cache.get(account.event_role_id)) : false },
        mode: account.mode || 'manual',
    };
}

// ══════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════
module.exports = {
    toolGetChannels,
    toolGetCategories,
    toolGetRoles,
    toolGetMembers,
    toolServerInfo,
    toolListAllGuilds,
    toolGetMessages,
    toolGetAuditLog,
    toolGetInvites,
    toolGetEmojis,
    toolGetStickers,
    toolGetBans,
    toolGetPinnedMessages,
    toolGetVoiceStates,
    toolSearchMessages,
    toolModerationOverview,
    toolRecentJoins,
    toolInactiveMembers,
    toolRoleMembers,
    toolChannelPermissions,
    toolGetWebhooks,
    toolGetScheduledEvents,
    toolGetThreads,
    toolGetNitroBoosters,
    toolGetBotList,
    toolGetMemberInfo,
    toolGetBotCommands,
    toolAnalyzeBot,
    toolServerBlueprint,
    toolPermissionAudit,
    toolChannelActivity,
    toolAgentConfigAudit,
};