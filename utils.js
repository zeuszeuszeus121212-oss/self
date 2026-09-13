/**
 * utils.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * جميع الدوال المساعدة: جلسات DB، القنوات المسموحة،
 * البحث المتدرج (async مع تحديث الكاش)، الصلاحيات، DeepSeek API، وبناء سياق البوت
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const path   = require('path');
const axios  = require('axios');
const {
    MONGODB_URI, USER_TOKEN, DEEPSEEK_TOKEN,
    BOT_OWNER_ID, RAILWAY_URL, POW_PROXY_TELEGRAM, DEFAULT_POW_PROVIDER,
    MAX_CHANNELS_PER_GUILD, MAX_ATTACHMENT_BYTES,
    TEXT_EXTENSIONS, TEXT_CONTENT_TYPES,
    sessions_col, settings_col, channels_col,
    channel_sessions, allowed_channels_cache,
} = require('./config');

const { isCategoryChannel, isTextChannel } = require('./discordAdapter');

// ══════════════════════════════════════════════════════════════
//  Unified Error Helpers — نظام أخطاء موحّد
// ══════════════════════════════════════════════════════════════

/**
 * يرجع كائن خطأ موحّد
 * @param {string} msg
 * @returns {{ ok: false, msg: string }}
 */
function _err(msg) {
    return { ok: false, msg: String(msg) };
}

/**
 * يرجع كائن نجاح موحّد
 * @param {string} msg
 * @param {...any} extra - خصائص إضافية كـ key-value pairs
 * @returns {{ ok: true, msg: string, ...extra }}
 */
function _ok(msg, extra = {}) {
    return { ok: true, msg: String(msg), ...extra };
}

// ══════════════════════════════════════════════════════════════
//  Attachment Detection — كشف المرفقات النصية
// ══════════════════════════════════════════════════════════════

/**
 * يتحقق إذا كان المرفق نصياً (بحسب contentType أو الامتداد)
 * @param {{ contentType?: string, name?: string }} attachment
 * @returns {boolean}
 */
function is_text_attachment(attachment) {
    const contentType = attachment.contentType || '';
    if (contentType) {
        for (const prefix of TEXT_CONTENT_TYPES) {
            if (contentType.startsWith(prefix)) return true;
        }
    }
    const filename = attachment.name || attachment.filename || '';
    const ext      = path.extname(filename.toLowerCase());
    return TEXT_EXTENSIONS.has(ext);
}

// ══════════════════════════════════════════════════════════════
//  MongoDB Session Helpers — دوال الجلسات
// ══════════════════════════════════════════════════════════════

/**
 * يحفظ جلسة القناة في MongoDB
 */
async function db_save_channel_session(guild_id, channel_id, session_id, parent_message_id, mode = 'default', thinking = false, agent_id = 'default') {
    const cfg = require('./config');
    await cfg.sessions_col.updateOne(
        { agent_id: String(agent_id), guild_id: String(guild_id), channel_id: String(channel_id) },
        {
            $set: {
                session_id        : session_id,
                parent_message_id : parent_message_id,
                mode              : mode,
                thinking          : Boolean(thinking),
                updated_at        : new Date(),
            },
            $setOnInsert: {
                created_at: new Date(),
            },
        },
        { upsert: true },
    );
}

/**
 * يحمّل جلسة القناة من MongoDB
 * @returns {Promise<{session_id: string, parent_message_id: string|null, mode: string, thinking: boolean}|null>}
 */
async function db_load_channel_session(guild_id, channel_id, agent_id = 'default') {
    const cfg = require('./config');
    const doc = await cfg.sessions_col.findOne({
        agent_id  : String(agent_id),
        guild_id  : String(guild_id),
        channel_id: String(channel_id),
    });
    if (doc && doc.session_id) {
        return {
            session_id        : doc.session_id,
            parent_message_id : doc.parent_message_id || null,
            mode              : doc.mode || 'default',
            thinking          : Boolean(doc.thinking),
        };
    }
    return null;
}

/**
 * يحذف جلسة القناة من MongoDB (إعادة تعيين)
 */
async function db_reset_channel_session(guild_id, channel_id, agent_id = 'default') {
    const cfg = require('./config');
    await cfg.sessions_col.deleteOne({
        agent_id  : String(agent_id),
        guild_id  : String(guild_id),
        channel_id: String(channel_id),
    });
}

/**
 * يعرض جلسات المحادثة المحفوظة لوكيل داخل سيرفر.
 */
async function db_list_channel_sessions(guild_id, agent_id = 'default') {
    const cfg = require('./config');
    return cfg.sessions_col
        .find({ agent_id: String(agent_id), guild_id: String(guild_id) })
        .sort({ updated_at: -1, created_at: -1 })
        .limit(25)
        .toArray();
}

// ══════════════════════════════════════════════════════════════
//  Allowed Channels DB Helpers — القنوات المسموحة
// ══════════════════════════════════════════════════════════════

/**
 * يجيب قائمة القنوات المسموحة للسيرفر (مع cache)
 * @param {string} guildId
 * @returns {Promise<string[]>}
 */
async function get_allowed_channels(guildId, agent_id = 'default', cache = allowed_channels_cache) {
    const key = `${agent_id}:${String(guildId)}`;
    if (cache.has(key)) {
        return cache.get(key);
    }
    const cfg = require('./config');
    const doc = await cfg.channels_col.findOne({ agent_id: String(agent_id), guild_id: String(guildId) });
    const ids = (doc && Array.isArray(doc.channel_ids)) ? doc.channel_ids.map(String) : [];
    cache.set(key, ids);
    return ids;
}

/**
 * يضيف قناة للسيرفر — يرفض إذا وصلنا للحد الأقصى
 * @param {string} guildId
 * @param {string} channelId
 * @returns {Promise<boolean>} true عند النجاح
 */
async function add_allowed_channel(guildId, channelId, agent_id = 'default', cache = allowed_channels_cache) {
    const key = `${agent_id}:${String(guildId)}`;
    const cid = String(channelId);
    const ids = await get_allowed_channels(guildId, agent_id, cache);

    if (ids.includes(cid)) return true;          // موجودة أصلاً
    if (ids.length >= MAX_CHANNELS_PER_GUILD) return false; // تجاوز الحد

    ids.push(cid);
    cache.set(key, ids);

    const cfg = require('./config');
    await cfg.channels_col.updateOne(
        { agent_id: String(agent_id), guild_id: String(guildId) },
        { $addToSet: { channel_ids: cid } },
        { upsert: true },
    );
    return true;
}

/**
 * يزيل قناة من قائمة السيرفر
 * @param {string} guildId
 * @param {string} channelId
 */
async function remove_allowed_channel(guildId, channelId, agent_id = 'default', cache = allowed_channels_cache) {
    const key = `${agent_id}:${String(guildId)}`;
    const cid = String(channelId);
    const ids = await get_allowed_channels(guildId, agent_id, cache);
    const idx = ids.indexOf(cid);
    if (idx !== -1) ids.splice(idx, 1);
    cache.set(key, ids);

    const cfg = require('./config');
    await cfg.channels_col.updateOne(
        { agent_id: String(agent_id), guild_id: String(guildId) },
        { $pull: { channel_ids: cid } },
    );
}

// ══════════════════════════════════════════════════════════════
//  Control Role Helpers — رتبة التحكم
// ══════════════════════════════════════════════════════════════

/**
 * يجيب رتبة التحكم للسيرفر من DB
 * @param {string} guildId
 * @returns {Promise<string>}
 */
async function get_control_role(guildId, agent_id = 'default') {
    const cfg = require('./config');
    const doc = await cfg.settings_col.findOne({ agent_id: String(agent_id), guild_id: String(guildId) });
    if (doc && doc.control_role) return doc.control_role;
    return cfg.CONTROL_ROLE_NAME || '';
}

/**
 * يحفظ رتبة التحكم للسيرفر في DB
 * @param {string} guildId
 * @param {string} roleName
 */
async function set_control_role(guildId, roleName, agent_id = 'default') {
    const cfg = require('./config');
    await cfg.settings_col.updateOne(
        { agent_id: String(agent_id), guild_id: String(guildId) },
        { $set: { control_role: roleName } },
        { upsert: true },
    );
}

// ══════════════════════════════════════════════════════════════
//  POW Provider Helpers — مزود POW
// ══════════════════════════════════════════════════════════════

/**
 * يجيب مزود POW للسيرفر من DB
 * @param {string} guildId
 * @returns {Promise<string>}
 */
async function get_pow_provider(guildId, agent_id = 'default') {
    const cfg = require('./config');
    const doc = await cfg.settings_col.findOne({ agent_id: String(agent_id), guild_id: String(guildId) });
    if (doc && doc.pow_provider) return doc.pow_provider;
    return DEFAULT_POW_PROVIDER;
}

/**
 * يحفظ مزود POW للسيرفر في DB
 * @param {string} guildId
 * @param {string} provider - 'railway' أو 'telegram'
 */
async function set_pow_provider(guildId, provider, agent_id = 'default') {
    if (!['railway', 'telegram'].includes(provider)) {
        throw new Error("provider must be 'railway' or 'telegram'");
    }
    const cfg = require('./config');
    await cfg.settings_col.updateOne(
        { agent_id: String(agent_id), guild_id: String(guildId) },
        { $set: { pow_provider: provider } },
        { upsert: true },
    );
}

// ══════════════════════════════════════════════════════════════
//  Guild Search Helpers — دوال البحث المتدرجة (Async مع تحديث الكاش)
// ══════════════════════════════════════════════════════════════

/**
 * يبحث عن قناة بالـ ID ثم الاسم المطابق ثم الاحتواء.
 * إذا لم توجد في الكاش، يتم جلب جميع القنوات أولاً إن أمكن.
 * @param {import('discord.js').Guild} guild
 * @param {string} q - الاستعلام (ID أو اسم)
 * @returns {Promise<import('discord.js').GuildBasedChannel|null>}
 */
async function findChannel(guild, q) {
    if (!q) return null;
    const qs = String(q).trim();
    
    // 1. بحث بالـ ID في الكاش
    try {
        const ch = guild.channels.cache.get(qs);
        if (ch) return ch;
    } catch (_) {}

    // 2. محاولة fetch مباشر إذا كان المُدخل يبدو كـ ID (أرقام فقط)
    if (/^\d{17,20}$/.test(qs)) {
        try {
            const fetched = await guild.channels.fetch(qs).catch(() => null);
            if (fetched) return fetched;
        } catch (_) {}
    }

    const ql = qs.toLowerCase();
    
    // 3. بحث بالاسم المطابق في الكاش
    for (const ch of guild.channels.cache.values()) {
        if (ch.name.toLowerCase() === ql) return ch;
    }
    // 4. بحث بالاحتواء في الكاش
    for (const ch of guild.channels.cache.values()) {
        if (ch.name.toLowerCase().includes(ql)) return ch;
    }

    // 5. إذا لم نجد، نحدث الكاش (fetch كل القنوات) ثم نعيد البحث
    try {
        await guild.channels.fetch();
        // إعادة البحث بالاسم المطابق
        for (const ch of guild.channels.cache.values()) {
            if (ch.name.toLowerCase() === ql) return ch;
        }
        // إعادة البحث بالاحتواء
        for (const ch of guild.channels.cache.values()) {
            if (ch.name.toLowerCase().includes(ql)) return ch;
        }
    } catch (_) {}

    return null;
}

/**
 * يبحث عن كاتيجوري بالـ ID ثم الاسم
 * @param {import('discord.js').Guild} guild
 * @param {string} q
 * @returns {Promise<import('discord.js').CategoryChannel|null>}
 */
async function findCategory(guild, q) {
    if (!q) return null;
    const qs = String(q).trim();

    // 1. بحث بالـ ID في الكاش
    try {
        const ch = guild.channels.cache.get(qs);
        if (ch && isCategoryChannel(ch)) return ch;
    } catch (_) {}

    // 2. محاولة fetch مباشر إذا كان ID
    if (/^\d{17,20}$/.test(qs)) {
        try {
            const fetched = await guild.channels.fetch(qs).catch(() => null);
            if (fetched && isCategoryChannel(fetched)) return fetched;
        } catch (_) {}
    }

    const ql = qs.toLowerCase();
    // 3. بحث بالاسم المطابق
    for (const ch of guild.channels.cache.values()) {
        if (isCategoryChannel(ch) && ch.name.toLowerCase() === ql) return ch;
    }
    // 4. بحث بالاحتواء
    for (const ch of guild.channels.cache.values()) {
        if (isCategoryChannel(ch) && ch.name.toLowerCase().includes(ql)) return ch;
    }

    // 5. تحديث الكاش وإعادة المحاولة
    try {
        await guild.channels.fetch();
        for (const ch of guild.channels.cache.values()) {
            if (isCategoryChannel(ch) && ch.name.toLowerCase() === ql) return ch;
        }
        for (const ch of guild.channels.cache.values()) {
            if (isCategoryChannel(ch) && ch.name.toLowerCase().includes(ql)) return ch;
        }
    } catch (_) {}

    return null;
}

/**
 * يبحث عن رتبة بالـ ID ثم الاسم
 * @param {import('discord.js').Guild} guild
 * @param {string} q
 * @returns {Promise<import('discord.js').Role|null>}
 */
async function findRole(guild, q) {
    if (!q) return null;
    const qs = String(q).trim();

    // 1. بحث بالـ ID في الكاش
    try {
        const r = guild.roles.cache.get(qs);
        if (r) return r;
    } catch (_) {}

    // 2. محاولة fetch مباشر إذا كان ID
    if (/^\d{17,20}$/.test(qs)) {
        try {
            const fetched = await guild.roles.fetch(qs).catch(() => null);
            if (fetched) return fetched;
        } catch (_) {}
    }

    const ql = qs.toLowerCase();
    // 3. بحث بالاسم المطابق
    for (const r of guild.roles.cache.values()) {
        if (r.name.toLowerCase() === ql) return r;
    }
    // 4. بحث بالاحتواء
    for (const r of guild.roles.cache.values()) {
        if (r.name.toLowerCase().includes(ql)) return r;
    }

    // 5. تحديث الكاش وإعادة المحاولة
    try {
        await guild.roles.fetch();
        for (const r of guild.roles.cache.values()) {
            if (r.name.toLowerCase() === ql) return r;
        }
        for (const r of guild.roles.cache.values()) {
            if (r.name.toLowerCase().includes(ql)) return r;
        }
    } catch (_) {}

    return null;
}

/**
 * يبحث عن عضو بالـ ID ثم username/nickname/globalName مع محاولة fetch
 * @param {import('discord.js').Guild} guild
 * @param {string} q
 * @param {import('discord.js').Client} [client] - للـ fetch إذا لزم الأمر
 * @returns {Promise<import('discord.js').GuildMember|null>}
 */
async function findMember(guild, q, client = null) {
    if (!q) return null;
    const qs = String(q).trim();
    
    // 1. بحث بالـ ID في الكاش
    try {
        const m = guild.members.cache.get(qs);
        if (m) return m;
    } catch (_) {}

    // 2. محاولة fetch مباشر إذا كان ID
    if (/^\d{17,20}$/.test(qs)) {
        try {
            const fetched = await guild.members.fetch(qs).catch(() => null);
            if (fetched) return fetched;
        } catch (_) {}
    }

    const ql = qs.toLowerCase();
    // 3. بحث بالاسم المطابق (username, nickname, globalName)
    for (const m of guild.members.cache.values()) {
        if (
            m.user.username.toLowerCase() === ql ||
            (m.nickname && m.nickname.toLowerCase() === ql) ||
            (m.user.globalName && m.user.globalName.toLowerCase() === ql)
        ) return m;
    }
    // 4. بحث بالاحتواء
    for (const m of guild.members.cache.values()) {
        if (
            m.user.username.toLowerCase().includes(ql) ||
            (m.nickname && m.nickname.toLowerCase().includes(ql)) ||
            (m.user.globalName && m.user.globalName.toLowerCase().includes(ql))
        ) return m;
    }

    // 5. تحديث الكاش (fetch all members) ثم إعادة البحث
    try {
        await guild.members.fetch();
        for (const m of guild.members.cache.values()) {
            if (
                m.user.username.toLowerCase() === ql ||
                (m.nickname && m.nickname.toLowerCase() === ql) ||
                (m.user.globalName && m.user.globalName.toLowerCase() === ql)
            ) return m;
        }
        for (const m of guild.members.cache.values()) {
            if (
                m.user.username.toLowerCase().includes(ql) ||
                (m.nickname && m.nickname.toLowerCase().includes(ql)) ||
                (m.user.globalName && m.user.globalName.toLowerCase().includes(ql))
            ) return m;
        }
    } catch (_) {}

    return null;
}

/**
 * يبحث عن سيرفر بالـ ID ثم الاسم بين guilds المتاحة
 * @param {import('discord.js').Client} client
 * @param {string} q
 * @returns {import('discord.js').Guild|null}
 */
function findGuild(client, q) {
    if (!q) return null;
    const qs = String(q).trim();
    try {
        const g = client.guilds.cache.get(qs);
        if (g) return g;
    } catch (_) {}
    const ql = qs.toLowerCase();
    for (const g of client.guilds.cache.values()) {
        if (g.name.toLowerCase() === ql) return g;
    }
    for (const g of client.guilds.cache.values()) {
        if (g.name.toLowerCase().includes(ql)) return g;
    }
    return null;
}

// ══════════════════════════════════════════════════════════════
//  Permissions Helpers — دوال الصلاحيات
// ══════════════════════════════════════════════════════════════

/**
 * يحدد مستوى وصول العضو
 * @param {import('discord.js').GuildMember} member
 * @returns {'owner'|'admin'|'member'}
 */
function getAccessLevel(member) {
    if (BigInt(member.id) === BOT_OWNER_ID) return 'owner';
    if (member.permissions.has('Administrator')) return 'admin';
    return 'member';
}

/**
 * يتحقق إذا كان المستخدم هو مطور البوت
 * @param {string} userId
 * @returns {boolean}
 */
function isBotOwner(userId) {
    return BigInt(userId) === BOT_OWNER_ID;
}

/**
 * يتحقق إذا كانت أداة القراءة مسموحة للمستوى
 * @param {string} tool
 * @param {'owner'|'admin'|'member'} accessLevel
 * @returns {boolean}
 */
// أدوات شخصية آمنة متاحة لـ member — محصورة بهوية المستخدم نفسه ولا تلمس السيرفر
const MEMBER_SAFE_TOOLS = Object.freeze([
    'web_search', 'read_url',                        // 🌐 ويب (قراءة فقط)
    'remember', 'recall', 'forget_memory',           // 🧠 ذاكرته هو فقط
    'set_reminder', 'list_reminders', 'cancel_reminder', // ⏰ تذكيراته هو فقط
]);

function toolAllowedForAccess(tool, accessLevel) {
    if (accessLevel === 'owner') return true;
    if (accessLevel === 'admin') {
        const adminBlocked = ['list_all_guilds', 'mass_dm', 'get_bot_list'];
        return !adminBlocked.includes(tool);
    }
    return MEMBER_SAFE_TOOLS.includes(tool); // member: أدواته الشخصية الآمنة فقط
}

/**
 * يتحقق إذا كانت عملية execute مسموحة للمستوى
 * @param {string} action
 * @param {'owner'|'admin'|'member'} accessLevel
 * @param {object} params
 * @returns {{ allowed: boolean, reason: string }}
 */
function executeAllowedForAccess(action, accessLevel, params) {
    if (accessLevel === 'owner') return { allowed: true, reason: '' };
    if (accessLevel !== 'admin') {
        return { allowed: false, reason: '⛔ هذه العملية تتطلب صلاحيات إدارية.' };
    }
    if (params.target_guild || params.source_guild) {
        return { allowed: false, reason: '⛔ الأدمن يستطيع التنفيذ داخل السيرفر الحالي فقط.' };
    }
    const ownerOnlyActions = ['clone_server', 'mass_dm', 'create_webhook', 'send_webhook_message'];
    if (ownerOnlyActions.includes(action)) {
        return { allowed: false, reason: '⛔ هذه الأداة متاحة لمطور البوت فقط.' };
    }
    return { allowed: true, reason: '' };
}

// ══════════════════════════════════════════════════════════════
//  Internal Prompt Protection — حماية التعليمات الداخلية
// ══════════════════════════════════════════════════════════════

/**
 * يتحقق إذا كانت الرسالة تطلب الكشف عن التعليمات الداخلية
 * @param {string} text
 * @returns {boolean}
 */
function looks_like_internal_prompt_request(text) {
    const t = text.toLowerCase();
    const patterns = [
        'التعليمات التي تاتي', 'التعليمات التي تأتي', 'ارسل لي التعليمات',
        'اعطني التعليمات', 'اظهر التعليمات', 'اكشف التعليمات',
        'system prompt', 'developer message', 'internal instructions',
        'سيستم برومبت', 'برومبت النظام', 'رسالة النظام', 'توثيقك الداخلي',
    ];
    return patterns.some(p => t.includes(p));
}

// ══════════════════════════════════════════════════════════════
//  DeepSeek API Helpers — دوال DeepSeek المساعدة
// ══════════════════════════════════════════════════════════════

/** يولّد device ID عشوائي */
function _device_id() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < 88; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

/** يولّد rangers ID */
function _rangers_id() {
    const ts = BigInt(Date.now());
    const rv = BigInt(Math.floor(Math.random() * (9_999_999_999 - 1_000_000_000)) + 1_000_000_000);
    return String((ts << 32n) | rv);
}

/** يجيب offset المنطقة الزمنية */
function _tz_offset() {
    return String(-Math.round(new Date().getTimezoneOffset() * 60));
}

/**
 * يبني headers لطلبات DeepSeek
 * @param {string} powResponse
 * @param {string} token
 * @returns {object}
 */
function _build_headers(powResponse, token) {
    return {
        'User-Agent'               : 'DeepSeek/2.1.1 Android/36',
        'Accept'                   : 'application/json',
        'Accept-Encoding'          : 'gzip',
        'Content-Type'             : 'application/json',
        'x-client-platform'        : 'android',
        'x-client-version'         : '2.1.1',
        'x-client-locale'          : 'ar',
        'x-client-bundle-id'       : 'com.deepseek.chat',
        'x-rangers-id'             : _rangers_id(),
        'x-client-timezone-offset' : _tz_offset(),
        'x-device-id'              : _device_id(),
        'x-os-version'             : '30',
        'x-app-version'            : '2.1.1',
        'Authorization'            : `Bearer ${token}`,
        'X-DS-PoW-Response'        : powResponse,
        'accept-charset'           : 'UTF-8',
    };
}

/**
 * يجلب POW token من المزود المناسب
 * @param {string} guildId
 * @returns {Promise<{pow_response: string, pow_data: any}>}
 */
async function _get_pow(guildId, token = DEEPSEEK_TOKEN, agent_id = 'default') {
    const provider = await get_pow_provider(guildId, agent_id);

    if (provider === 'telegram') {
        const encodedToken = encodeURIComponent(token);
        const url = `${POW_PROXY_TELEGRAM}/get_pow?authorization=${encodedToken}`;
        try {
            const resp = await axios.get(url, { timeout: 15000 });
            if (resp.status === 200) {
                const data = resp.data;
                const pr   = data.x_ds_pow_response || data.pow_response;
                if (pr) return { pow_response: pr, pow_data: data.solved_json || null };
            }
        } catch (_) {}
        throw new Error('POW fetch failed (telegram proxy)');
    }

    // railway (افتراضي)
    const powUrl = `${RAILWAY_URL}/pow`;
    const urls   = [`${powUrl}?authorization=${token}`, powUrl];
    for (const url of urls) {
        try {
            const resp = await axios.get(url, { timeout: 15000 });
            if (resp.status === 200) {
                const data = resp.data;
                const pr   = data.x_ds_pow_response || data.pow_response;
                if (pr) return { pow_response: pr, pow_data: data.solved_json || null };
            }
        } catch (_) {
            continue;
        }
    }
    throw new Error('POW fetch failed (railway)');
}

/**
 * ينشئ جلسة DeepSeek جديدة
 * @returns {Promise<string>} session_id
 */
async function _new_ds_session(token = DEEPSEEK_TOKEN) {
    const url   = 'https://chat.deepseek.com/api/v0/chat_session/create';
    const hdrs  = {
        'x-client-bundle-id'       : 'com.deepseek.chat',
        'x-client-platform'        : 'web',
        'x-client-version'         : '2.0.0',
        'x-client-locale'          : 'en_US',
        'x-client-timezone-offset' : _tz_offset(),
        'x-app-version'            : '2.0.0',
        'Authorization'            : `Bearer ${token}`,
        'Content-Type'             : 'application/json',
        'Accept'                   : '*/*',
    };
    const resp = await axios.post(url, {}, { headers: hdrs });
    const sid  = resp.data?.data?.biz_data?.chat_session?.id;
    if (!sid) throw new Error(`Bad session response: ${JSON.stringify(resp.data)}`);
    return sid;
}

/**
 * يزيل التفكير وبعض الرموز غير المرغوبة من نص الرد
 * @param {string} text
 * @returns {string}
 */
function _strip(text) {
    text = text.replace(/\bFINISHEDSEARCH\b|\bFINISHED\b/gi, '');
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    text = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1');
    return text.trim();
}

/**
 * يرسل prompt لـ DeepSeek ويجمع الرد المتدفق (streaming)
 * @param {string} prompt
 * @param {string} guildId
 * @param {string|null} sessionId
 * @param {string|null} parentMessageId
 * @param {string} mode - 'default' أو 'expert'
 * @param {boolean} thinking
 * @returns {Promise<{fullText: string, sessionId: string, newParentMessageId: string|null}>}
 */
async function _stream_ds(prompt, guildId, sessionId = null, parentMessageId = null, mode = 'default', thinking = false, deepseekToken = DEEPSEEK_TOKEN, agent_id = 'default') {
    const token = deepseekToken;
    if (!token) throw new Error('DEEPSEEK_TOKEN not set');

    if (!sessionId) sessionId = await _new_ds_session(token);

    const powD = await _get_pow(guildId, token, agent_id);
    const hdrs = _build_headers(powD.pow_response, token);

    const modelType = (mode === 'expert') ? 'expert' : 'default';
    const payload   = {
        chat_session_id   : sessionId,
        parent_message_id : parentMessageId,
        prompt            : prompt,
        ref_file_ids      : [],
        thinking_enabled  : Boolean(thinking),
        search_enabled    : false,
        model_type        : modelType,
        action            : null,
        preempt           : false,
        stream            : true,
    };
    if (powD.pow_data !== null && powD.pow_data !== undefined) {
        payload.pow = powD.pow_data;
    }

    let fullText    = '';
    let newPmid     = null;

    // streaming request باستخدام axios responseType: 'stream'
    const response = await axios.post(
        'https://chat.deepseek.com/api/v0/chat/completion',
        payload,
        {
            headers      : hdrs,
            timeout      : 120_000,
            responseType : 'stream',
        },
    );

    if (response.status === 429) {
        throw new Error('⏳ DeepSeek مزدحم حالياً، حاول مرة أخرى بعد لحظة.');
    }
    if (response.status !== 200) {
        throw new Error(`DS ${response.status}`);
    }

    // معالجة الـ stream سطراً بسطر
    await new Promise((resolve, reject) => {
        let buf = '';
        response.data.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line.startsWith('data: ')) continue;
                try {
                    const d = JSON.parse(line.slice(6));
                    if (newPmid === null && d.response_message_id) {
                        newPmid = d.response_message_id;
                    }
                    const v = d.v;
                    if (v && typeof v === 'object') {
                        const frags = v.response?.fragments || [];
                        for (const frag of frags) {
                            const ftype = (frag.type || '').toUpperCase();
                            if (ftype === 'RESPONSE') {
                                fullText += frag.content || '';
                            }
                        }
                    } else if (typeof v === 'string') {
                        fullText += v;
                    }
                } catch (_) {}
            }
        });
        response.data.on('end', resolve);
        response.data.on('error', reject);
    });

    return {
        fullText       : _strip(fullText),
        sessionId      : sessionId,
        newParentMessageId : newPmid,
    };
}

// ══════════════════════════════════════════════════════════════
//  Bot Context Builder — بناء سياق البوت الكامل
// ══════════════════════════════════════════════════════════════

/**
 * يبني نص معلومات البوت الكامل للسياق
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildBasedChannel|null} currentChannel
 * @returns {Promise<string>}
 */
async function buildBotContext(client, guild, currentChannel = null, agent_id = 'default', cache = allowed_channels_cache) {
    const botUser   = client.user;
    const botMember = guild.members.cache.get(botUser.id);
    const botName   = botUser.displayName || botUser.username;
    const botId     = botUser.id;
    const botDisc   = botUser.discriminator && botUser.discriminator !== '0'
        ? `${botUser.username}#${botUser.discriminator}`
        : `@${botUser.username}`;
    const created   = botUser.createdAt.toISOString().slice(0, 10);
    const guildCnt  = client.guilds.cache.size;

    // جلب bio من Discord API
    let bio = 'غير متوفر';
    try {
        const resp = await axios.get(
            `https://discord.com/api/v10/users/${botId}`,
            {
                headers : { Authorization: `Bot ${USER_TOKEN}` },
                timeout : 5000,
            },
        );
        if (resp.status === 200) {
            bio = resp.data.bio || 'غير متوفر';
        }
    } catch (_) {}

    let botRoles      = [];
    let botPermsList  = [];
    let highestRole   = '@everyone';
    let isAdmin       = false;

    if (botMember) {
        botRoles    = botMember.roles.cache
            .filter(r => r.name !== '@everyone')
            .map(r => r.name);
        highestRole = botMember.roles.highest.name;
        const perms = botMember.permissions;
        isAdmin     = perms.has('Administrator');
        if (isAdmin) {
            botPermsList = ['administrator (كل الصلاحيات)'];
        } else {
            botPermsList = perms.toArray();
        }
    }

    const allowedIds   = await get_allowed_channels(guild.id, agent_id, cache);
    const allowedNames = allowedIds.map(cid => {
        const ch = guild.channels.cache.get(cid);
        return ch ? `#${ch.name}` : `ID:${cid}`;
    });

    const otherGuildsLines = [];
    for (const g of client.guilds.cache.values()) {
        if (g.id === guild.id) continue;
        otherGuildsLines.push(`  - ${g.name} (ID: ${g.id}, أعضاء: ${g.memberCount})`);
    }

    const channelBlock = [];
    if (currentChannel) {
        const { ChannelType } = require('discord.js');
        const chName = currentChannel.name || 'غير معروف';
        const chId   = currentChannel.id;
        const chType = isTextChannel(currentChannel) ? 'نصية' : 'صوتية';
        channelBlock.push(
            '',
            '  [القناة التي يتحدث فيها المستخدم معك الآن]',
            `  الاسم : #${chName}`,
            `  النوع : ${chType}`,
            `  الـ ID: ${chId}`,
        );
    }

    // ── قسم إيموجيات السيرفر ─ـ
    const emojiLines = [];
    const allEmojis = [...guild.emojis.cache.values()].slice(0, 50);
    if (allEmojis.length > 0) {
        emojiLines.push('');
        emojiLines.push('  [إيموجيات السيرفر المتاحة لك]');
        emojiLines.push('  (تستطيع استخدام هذه الإيموجيات في ردودك بكتابة <:اسم_الإيموجي:ID_الإيموجي>)');
        for (const emoji of allEmojis) {
            const tag = emoji.animated
                ? `<a:${emoji.name}:${emoji.id}>`
                : `<:${emoji.name}:${emoji.id}>`;
            emojiLines.push(`  ${tag} — \`${emoji.name}\` \`${emoji.id}\``);
        }
    }

    const lines = [
        '══════════════════════════════════',
        '  [معلومات البوت — السياق الكامل]',
        '══════════════════════════════════',
        `  الاسم             : ${botName}`,
        `  التاق             : ${botDisc}`,
        `  الـ ID            : ${botId}`,
        `  تاريخ الإنشاء    : ${created}`,
        `  البايو            : ${bio}`,
        `  عدد السيرفرات    : ${guildCnt} سيرفر`,
        '',
        '  [السيرفر الحالي]',
        `  الاسم             : ${guild.name}`,
        `  الـ ID            : ${guild.id}`,
        `  عدد الأعضاء      : ${guild.memberCount}`,
        `  الأونر            : ${guild.members.cache.get(guild.ownerId)?.displayName || 'غير معروف'}`,
        ...channelBlock,
        '',
        '  [رتب البوت في هذا السيرفر]',
        `  الرتب             : ${botRoles.length ? botRoles.join(', ') : 'لا رتب'}`,
        `  أعلى رتبة        : ${highestRole}`,
        `  أدمن؟             : ${isAdmin ? 'نعم ✅' : 'لا ❌'}`,
        '',
        '  [صلاحياته في هذا السيرفر]',
        `  ${botPermsList.length ? botPermsList.join(', ') : 'لا صلاحيات'}`,
        '',
        '  [القنوات التي يستمع فيها البوت في هذا السيرفر]',
        `  ${allowedNames.length ? allowedNames.join(', ') : 'لم تُحدد قنوات'}`,
        '',
        '  [سيرفرات أخرى البوت موجود فيها]',
        ...(otherGuildsLines.length ? otherGuildsLines : ['  لا يوجد سيرفرات أخرى']),
        ...emojiLines,
        '══════════════════════════════════',
    ];
    return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  Text Attachment Fetcher — جلب محتوى المرفقات النصية
// ══════════════════════════════════════════════════════════════

/**
 * يجلب محتوى مرفق نصي من URL
 * @param {string} url
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function fetchTextAttachment(url, maxBytes = MAX_ATTACHMENT_BYTES) {
    const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout     : 15000,
        maxContentLength: maxBytes + 1024,
    });
    const buf  = Buffer.from(resp.data);
    const data = buf.slice(0, maxBytes);
    let text   = data.toString('utf8');
    if (buf.length > maxBytes) text += '\n... (تم اقتطاع الملف)';
    return text;
}

// ══════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════
module.exports = {
    // Error Helpers
    _err,
    _ok,

    // Attachment
    is_text_attachment,
    fetchTextAttachment,

    // DB Sessions
    db_save_channel_session,
    db_load_channel_session,
    db_reset_channel_session,
    db_list_channel_sessions,

    // Allowed Channels
    get_allowed_channels,
    add_allowed_channel,
    remove_allowed_channel,

    // Control Role
    get_control_role,
    set_control_role,

    // POW Provider
    get_pow_provider,
    set_pow_provider,

    // Search Helpers (Async)
    findChannel,
    findCategory,
    findRole,
    findMember,
    findGuild,

    // Permissions
    getAccessLevel,
    isBotOwner,
    toolAllowedForAccess,
    executeAllowedForAccess,

    // Internal Prompt Protection
    looks_like_internal_prompt_request,

    // DeepSeek API
    _device_id,
    _rangers_id,
    _tz_offset,
    _build_headers,
    _get_pow,
    _new_ds_session,
    _strip,
    _stream_ds,

    // Bot Context
    buildBotContext,
};