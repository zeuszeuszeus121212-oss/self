/**
 * guildRegistry.js — Disor Bot v7.9 "Al-Raqeeb"
 * ═══════════════════════════════════════════════════════════
 * 🛰️ RAQEEB — «العلم التام» لصاحب البوت (طلب المالك — v7.9)
 *
 * المالك يريد معرفة كل شيء عن بوتاته:
 *   • أي السيرفرات فيها البوت؟
 *   • من أضافه؟ ومتى؟ (من سجل تدقيق Discord — BOT_ADD)
 *   • أين يتكلم الناس مع البوت الآن؟ ومن قدم لهم؟
 *   • من تكلم معه سابقاً؟
 *
 * ويصل ذلك:
 *   • إشعار فوري عند إضافة البوت لأي سيرفر جديد
 *   • إشعار فوري عند كل محادثة (قابل للإطفاء من الإعدادات)
 *   • أمر /الرصد — لوحة كاملة بكل السيرفرات والنشاط
 *
 * الخصوصية: نسجل **من/أين/متى** فقط — بلا محتوى الرسائل أبداً.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { AuditLogEvent } = require('discord.js');

const MAX_ACTIVITY_ROWS = 600;      // حد سجل النشاط المخزن
const ACTIVITY_NOTIFY_COOLDOWN_MS = 4_000; // منع إغراق قناة الإشعارات بنفس الشخص/القناة

let notifier = null;              // مُبلّغ قناة الإشعارات — يُحقن من bot.js
function setNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }
async function safeNotify(payload) {
    try { if (notifier) await notifier(payload); } catch (_) {}
}

function registryCol() {
    try { return require('./config').guild_registry_col || null; } catch (_) { return null; }
}
function activityCol() {
    try { return require('./config').guild_activity_col || null; } catch (_) { return null; }
}

// ── النشاط «الآن» — ذاكرة حية خفيفة (guildId -> آخر نبضة) ──
const liveActivity = new Map(); // guildId -> { at, userId, username, channelName, agentName }

// تهدئة إشعارات النشاط: نفس الشخص في نفس القناة خلال 4 ثوانٍ = إشعار واحد
const activityNotifyAt = new Map(); // `${guild}:${channel}:${user}` -> timestamp

function settingsCol() {
    try { return require('./config').settings_col || null; } catch (_) { return null; }
}

/** هل إشعارات النشاط مفعّلة؟ (الافتراضي: نعم — المالك طلب العلم التام) */
async function activityNotifyEnabled() {
    const c = settingsCol();
    if (!c) return true;
    try {
        const s = await c.findOne({ scope: 'manager', guild_id: 'global' });
        return s?.activity_notify !== false;
    } catch (_) {
        return true;
    }
}

// ══════════════════════════════════════════════════════════════
//  تسجيل السيرفرات
// ══════════════════════════════════════════════════════════════

/**
 * استخراج «من أضاف البوت» من سجل تدقيق السيرفر (BOT_ADD).
 * @returns {Promise<{id: string, tag: string}|null>}
 */
async function findBotAdder(guild, client) {
    try {
        if (!guild?.members?.me?.permissions?.has?.('ViewAuditLog')) {
            // جرب بدون فحص صريح — fetchAuditLogs سيرمي إن لم تتوفر الصلاحية
        }
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 });
        for (const entry of logs.entries.values()) {
            const targetId = entry.target?.id || entry.targetID;
            if (String(targetId) === String(client?.user?.id)) {
                const ex = entry.executor;
                return ex ? { id: ex.id, tag: ex.tag || ex.username || String(ex.id) } : null;
            }
        }
        // آخر محاولة: أول إدخال BOT_ADD (قد يكون البوت الوحيد المضاف)
        const first = logs.entries.first();
        if (first?.executor) {
            return { id: first.executor.id, tag: first.executor.tag || first.executor.username || String(first.executor.id) };
        }
    } catch (_) {
        // لا صلاحية سجل تدقيق — عادي
    }
    return null;
}

/**
 * تسجيل انضمام البوت لسيرفر — يُستدعى من guildCreate.
 * @returns {Promise<{ok: boolean, addedBy: object|null}>}
 */
async function recordGuildJoin(guild, client) {
    const col = registryCol();
    const gid = String(guild?.id || '');
    if (!col || !gid) return { ok: false, addedBy: null };

    const addedBy = await findBotAdder(guild, client);

    const doc = {
        guild_id: gid,
        name: guild?.name || 'سيرفر',
        icon_url: guild?.iconURL?.() || null,
        member_count: guild?.memberCount || null,
        owner_id: guild?.ownerId || null,
        added_by_id: addedBy?.id || null,
        added_by_tag: addedBy?.tag || null,
        left: false,
        last_seen_at: new Date(),
    };

    try {
        await col.updateOne(
            { guild_id: gid },
            {
                $set: doc,
                $setOnInsert: { joined_at: new Date() },
            },
            { upsert: true },
        );
    } catch (e) {
        console.error('[Raqeeb] فشل حفظ سجل السيرفر:', e.message);
        return { ok: false, addedBy };
    }

    // 🔔 إشعار فوري للمالك
    await safeNotify({
        type: 'raqeeb',
        level: 'success',
        title: `🆕🛰️ أُضيف البوت إلى سيرفر جديد: ${guild?.name || gid}`,
        message: (
            `🆔 ${gid}\n` +
            `👥 الأعضاء: ${guild?.memberCount ?? '—'}\n` +
            `👤 أضافه: ${addedBy ? '@' + addedBy.tag : 'غير معروف (لا صلاحية سجل التدقيق)'}\n` +
            `📅 الوقت: <t:${Math.floor(Date.now() / 1000)}:F>\n` +
            `🌐 حساب Qwen التلقائي: جاري الإنشاء...`
        ),
        guildId: gid,
    });

    console.log(`[Raqeeb] 🆕 سيرفر جديد: ${guild?.name} (${gid}) — بواسطة ${addedBy?.tag || '؟'}`);
    return { ok: true, addedBy };
}

// ══════════════════════════════════════════════════════════════
//  🔄 ترحيل السيرفرات الحالية عند الإقلاع (Backfill)
//  الرصد سُجّل من حدث guildCreate فقط — أي أن السيرفرات التي كان
//  البوت فيها قبل تفعيل الرصد لم تُسجّل أبداً ولوحة /الرصد تراها فارغة.
//  عند إقلاع كل عميل (المدير + الوكلاء) نسجّل سيرفراته الحالية بصمت:
//  بلا إشعارات (وإلا غُرق المالك بإشعارات انضمام وهمية كل إقلاع)،
//  مع محاولة استخراج المُضيف من سجل التدقيق إن لم يُعرف بعد.
// ══════════════════════════════════════════════════════════════

/**
 * تسجيل سيرفرات عميل قائمة فعلاً في السجل — يُستدعى من ready لكل عميل.
 * صامت تماماً: لا إشعارات، لا أخطاء مرمية.
 * @param {object} client عميل Discord (مدير أو وكيل)
 * @returns {Promise<{ok: boolean, registered: number, apps: number}>}
 */
async function backfillGuilds(client) {
    const col = registryCol();
    if (!col || !client?.guilds?.cache) return { ok: false, registered: 0 };
    let count = 0;
    for (const guild of client.guilds.cache.values()) {
        try {
            const gid = String(guild.id);
            if (!gid) continue;
            const existing = await col.findOne({ guild_id: gid }).catch(() => null);
            // المُضيف: نبحث عنه فقط إن لم نعرفه بعد (بحث سجل التدقيق مكلف)
            const addedBy = (!existing || !existing.added_by_id) ? await findBotAdder(guild, client) : null;
            await col.updateOne(
                { guild_id: gid },
                {
                    $set: {
                        name: guild.name || 'سيرفر',
                        icon_url: guild.iconURL?.() || null,
                        member_count: guild.memberCount || null,
                        owner_id: guild.ownerId || null,
                        ...(addedBy ? { added_by_id: addedBy.id, added_by_tag: addedBy.tag } : {}),
                        left: false,
                        last_seen_at: new Date(),
                    },
                    $setOnInsert: { joined_at: new Date(), backfilled: true },
                    $addToSet: {
                        apps: { id: String(client.user?.id || ''), name: client.user?.username || 'bot' },
                    },
                },
                { upsert: true },
            );
            count++;
        } catch (e) {
            console.error('[Raqeeb] فشل ترحيل سيرفر:', e.message);
        }
    }
    if (count) console.log(`[Raqeeb] 🔄 ترحيل صامت: ${count} سيرفر حالي مسجل من عميل ${client.user?.username || '؟'}`);
    return { ok: true, registered: count };
}

/** تسجيل مغادرة سيرفر (طرد البوت/حذف السيرفر) */
async function recordGuildLeave(guild) {
    const col = registryCol();
    const gid = String(guild?.id || '');
    if (!col || !gid) return { ok: false };
    try {
        await col.updateOne(
            { guild_id: gid },
            { $set: { left: true, left_at: new Date(), last_seen_at: new Date(), last_name: guild?.name || null } },
        );
        liveActivity.delete(gid);
        await safeNotify({
            type: 'raqeeb',
            level: 'warning',
            title: `🚪🛰️ خرج البوت من سيرفر: ${guild?.name || gid}`,
            message: `🆔 ${gid}`,
            guildId: gid,
        });
        return { ok: true };
    } catch (e) {
        console.error('[Raqeeb] فشل تسجيل المغادرة:', e.message);
        return { ok: false };
    }
}

// ══════════════════════════════════════════════════════════════
//  تسجيل النشاط — من يتكلم مع البوت وأين
// ══════════════════════════════════════════════════════════════

/**
 * نبضة نشاط — تُستدعى عند كل رد حقيقي من البوت على شخص.
 * بلا محتوى رسائل — هوية ومكان وزمن فقط.
 * @param {object} info {agentId, agentName, guildId, guildName, channelId, channelName, userId, username}
 */
async function recordActivity(info = {}) {
    const gid = String(info.guildId || '');
    if (!gid) return { ok: false };

    // النبضة الحية (لـ «حاليا»)
    liveActivity.set(gid, {
        at: Date.now(),
        userId: info.userId || null,
        username: info.username || null,
        channelName: info.channelName || null,
        channelId: info.channelId || null,
        agentName: info.agentName || null,
    });

    // السجل الدائم (لـ «من قبل»)
    const col = activityCol();
    if (col) {
        try {
            await col.insertOne({
                agent_id: String(info.agentId || ''),
                agent_name: info.agentName || null,
                guild_id: gid,
                channel_id: info.channelId || null,
                channel_name: info.channelName || null,
                user_id: info.userId || null,
                username: info.username || null,
                created_at: new Date(),
            });
        } catch (_) {}
    }

    // 🔔 إشعار النشاط (قابل للإطفاء + تهدئة ضد الإغراق)
    try {
        if (await activityNotifyEnabled()) {
            const k = `${gid}:${info.channelId}:${info.userId}`;
            const now = Date.now();
            const last = activityNotifyAt.get(k) || 0;
            if (now - last >= ACTIVITY_NOTIFY_COOLDOWN_MS) {
                activityNotifyAt.set(k, now);
                await safeNotify({
                    type: 'raqeeb',
                    level: 'info',
                    title: '💬 نشاط محادثة جديد',
                    message: (
                        `👤 <@${info.userId}> (${info.username || '—'})\n` +
                        `📍 ${info.guildName ? `«${info.guildName}»` : `سيرفر ${gid}`} ← #${info.channelName || info.channelId || '—'}\n` +
                        `🤖 الوكيل: ${info.agentName || info.agentId || '—'}\n` +
                        `🕒 <t:${Math.floor(now / 1000)}:R>`
                    ),
                    guildId: gid,
                });
            }
        }
    } catch (_) {}

    return { ok: true };
}

// ══════════════════════════════════════════════════════════════
//  استعلامات لوحة الرصد
// ══════════════════════════════════════════════════════════════

/** كل السيرفرات + نبضتها الحية + آخر نشاط مسجل + عدد المحادثات */
async function getOverview() {
    const col = registryCol();
    if (!col) return [];
    let docs = [];
    try { docs = await col.find({}).sort({ joined_at: -1 }).limit(500).toArray(); } catch (_) { return []; }

    // ⚡ v7.11: إحصائيات النشاط كلها باستعلام تجميعي واحد بدل 2×N استعلام —
    // كانت الإطالة هنا تجعل /الرصد يتجاوز مهلة ديسكورد 3 ثوان فيظهر بالأحمر.
    const actCol = activityCol();
    const stats = new Map(); // guild_id -> { total, last }
    if (actCol) {
        try {
            const agg = await actCol.aggregate([
                { $group: { _id: '$guild_id', total: { $sum: 1 }, last: { $max: '$created_at' } } },
            ]).toArray();
            for (const row of (agg || [])) {
                stats.set(String(row._id), { total: row.total || 0, last: row.last || null });
            }
        } catch (_) {
            // تجميع غير مدعوم؟ رجوع آمن للاستعلام الفردي (نفس النتيجة أبطأ)
            try {
                const gids = docs.map(d => d.guild_id);
                for (const gid of gids) {
                    const last = await actCol.findOne({ guild_id: gid }, { sort: { created_at: -1 } }).catch(() => null);
                    const total = await actCol.countDocuments({ guild_id: gid }).catch(() => 0);
                    stats.set(gid, { total, last });
                }
            } catch (_) {}
        }
    }

    const out = [];
    for (const d of docs) {
        const s = stats.get(String(d.guild_id)) || { total: 0, last: null };
        const live = liveActivity.get(d.guild_id) || null;
        out.push({
            ...d,
            total_chats: s.total,
            last_activity: s.last ? { created_at: s.last } : null,
            live: live && (Date.now() - live.at < 5 * 60 * 1000) ? live : null,
        });
    }
    return out;
}

/** تفاصيل سيرفر واحد: معلومات الانضمام + آخر 20 نبضة نشاط */
async function getGuildDetail(guildId) {
    const col = registryCol();
    const actCol = activityCol();
    const gid = String(guildId || '');
    if (!col) return null;
    let doc = null;
    try { doc = await col.findOne({ guild_id: gid }); } catch (_) {}
    if (!doc) return null;
    let activity = [];
    if (actCol) {
        try { activity = await actCol.find({ guild_id: gid }).sort({ created_at: -1 }).limit(20).toArray(); } catch (_) {}
    }
    return { ...doc, activity, live: liveActivity.get(gid) || null };
}

/** قصّ سجل النشاط — يُستدعى دورياً */
async function trimActivity() {
    const col = activityCol();
    if (!col) return;
    try {
        const count = await col.countDocuments();
        if (count > MAX_ACTIVITY_ROWS) {
            const excess = count - MAX_ACTIVITY_ROWS;
            const old = await col.find({}).sort({ created_at: 1 }).limit(excess).toArray();
            for (const doc of old) {
                await col.deleteOne({ _id: doc._id }).catch(() => {});
            }
        }
    } catch (_) {}
}

/** إعداد إشعارات النشاط — من لوحة الإعدادات */
async function setActivityNotify(enabled) {
    const c = settingsCol();
    if (!c) return false;
    try {
        await c.updateOne(
            { scope: 'manager', guild_id: 'global' },
            { $set: { activity_notify: Boolean(enabled), updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
            { upsert: true },
        );
        return true;
    } catch (_) {
        return false;
    }
}

let trimTimerStarted = false;
function startRegistryTimers() {
    if (trimTimerStarted) return;
    trimTimerStarted = true;
    setInterval(() => trimActivity().catch(() => {}), 30 * 60 * 1000).unref();
}

module.exports = {
    setNotifier,
    recordGuildJoin,
    recordGuildLeave,
    recordActivity,
    backfillGuilds,
    getOverview,
    getGuildDetail,
    setActivityNotify,
    activityNotifyEnabled,
    startRegistryTimers,
    // للاختبارات
    _internals: { findBotAdder, liveActivity, ACTIVITY_NOTIFY_COOLDOWN_MS },
};
