/**
 * channelHistory.js — Disor Bot v7.11 "La Yansaa"
 * ═══════════════════════════════════════════════════════════
 * 🧷 ذاكرة القناة الدائمة — «ما يُنسى ما عاد يُنسى»
 *
 * المشكلة التي عالجناها (طلب المالك):
 *   لما تتحول المحادثة لمفتاح آخر أو مزود آخر أو تُنشأ جلسة جديدة
 *   لأي سبب — كان البوت ينسى كل ما قيل في القناة ويبدأ من الصفر.
 *
 * الحل:
 *   سجل حوار دائم في MongoDB لكل (وكيل + سيرفر + قناة): كل رسالة
 *   مستخدم وكل رد بوت يُلحق به. وعند بدء أي جلسة جديدة لدى أي مزود
 *   يُحقن آخر جزء من هذا السجل في السياق — فيكمل الحوار وكأنه
 *   لم ينقطع، مهما تغير المفتاح أو المزود.
 *
 * الخصوصية: السجل لكل وكيل على حدة — وكيل لا يرى قنوات وكيل آخر.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const MAX_ENTRIES_PER_CHANNEL = 200;  // سقف السجل لكل قناة — الأقدم يُحذف
const MAX_STORED_LEN = 3500;          // أقصى طول مخزن للرسالة الواحدة
const DEFAULT_RENDER_LIMIT = 24;      // عدد الأحداث المحقونة في السياق افتراضياً
const MAX_RENDERED_ENTRY_LEN = 400;   // قصّ كل سطر عند الحقن (السياق يبقى مقتصداً)

function col() {
    try { return require('./config').channel_history_col || null; } catch (_) { return null; }
}

function chKey(agentId, guildId, channelId) {
    return {
        agent_id  : String(agentId || 'default'),
        guild_id  : String(guildId || 'dm'),
        channel_id: String(channelId || ''),
    };
}

/** اقتطاع آمن للنص المخزن */
function clamp(text, max = MAX_STORED_LEN) {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ═══════════════════════════════════════════════════════════
//  التخزين
// ═══════════════════════════════════════════════════════════

/**
 * إلحاق حدث حوار بالسجل — لا يرمي أخطاء أبداً (أفضل جهود).
 * @param {object} e {agentId, guildId, channelId, role: 'user'|'assistant', content, userId, username, ignored}
 */
async function appendMessage(e = {}) {
    try {
        const c = col();
        if (!c) return { ok: false };
        const content = clamp(e.content);
        if (!content) return { ok: false };
        const doc = {
            ...chKey(e.agentId, e.guildId, e.channelId),
            role     : e.role === 'assistant' ? 'assistant' : 'user',
            content,
            user_id  : e.userId ? String(e.userId) : null,
            username : e.username ? String(e.username).slice(0, 80) : null,
            ignored  : Boolean(e.ignored),
            created_at: new Date(),
        };
        await c.insertOne(doc);
        trimChannel(chKey(e.agentId, e.guildId, e.channelId));
        return { ok: true };
    } catch (_) {
        return { ok: false };
    }
}

/** قصّ السجل الأقدم لكل قناة — يُستدعى بشكل رخيص بعد كل إضافة */
let trimCounter = 0;
function trimChannel(key) {
    trimCounter++;
    // قصّ خفيف: كل 10 إضافات نفحص الحد (تقليل استعلامات العدّ)
    if (trimCounter % 10 !== 1) return;
    const c = col();
    if (!c) return;
    (async () => {
        try {
            const count = await c.countDocuments(key);
            if (count <= MAX_ENTRIES_PER_CHANNEL) return;
            const excess = count - MAX_ENTRIES_PER_CHANNEL;
            const old = await c.find(key).sort({ created_at: 1 }).limit(excess).toArray();
            for (const d of old) await c.deleteOne({ _id: d._id }).catch(() => {});
        } catch (_) {}
    })();
}

/** آخر N حدث من سجل القناة (تصاعدياً — الأقدم أولاً) */
async function getRecent({ agentId, guildId, channelId, limit = DEFAULT_RENDER_LIMIT } = {}) {
    const c = col();
    if (!c) return [];
    try {
        const key = chKey(agentId, guildId, channelId);
        const docs = await c.find(key).sort({ created_at: -1 }).limit(Math.max(1, Math.min(Number(limit) || DEFAULT_RENDER_LIMIT, 60))).toArray();
        return (docs || []).reverse();
    } catch (_) {
        return [];
    }
}

/** عدد أحداث السجل لقناة (للاختبارات) */
async function countChannel({ agentId, guildId, channelId } = {}) {
    const c = col();
    if (!c) return 0;
    try { return await c.countDocuments(chKey(agentId, guildId, channelId)); } catch (_) { return 0; }
}

// ═══════════════════════════════════════════════════════════
//  الحقن — كتلة السياق لأي جلسة جديدة
// ═══════════════════════════════════════════════════════════

function renderEntry(d, botName) {
    const who = d.role === 'assistant'
        ? `BOT (${botName || 'أنا'})`
        : `USER (${d.username || d.user_id || 'مستخدم'})`;
    const content = clamp(d.content, MAX_RENDERED_ENTRY_LEN).replace(/\s+/g, ' ').trim();
    const flag = d.role === 'user' && d.ignored ? ' ← [تجاهلتُ الرد عليها عمداً بشخصيتي]' : '';
    return `${who}: ${content}${flag}`;
}

/**
 * بناء كتلة سياق القناة — تُحقن عند بدء جلسة جديدة لدى أي مزود.
 * @returns {string} '' إذا لا سجل — بلا أي حقن فارغ
 */
async function renderBlock({ agentId, guildId, channelId, botName, limit = DEFAULT_RENDER_LIMIT } = {}) {
    try {
        const entries = await getRecent({ agentId, guildId, channelId, limit });
        if (!entries.length) return '';
        const lines = entries.map(d => renderEntry(d, botName));
        return (
            `══════════════════════════════════════════════\n` +
            `ذاكرة هذه القناة — الحوار نفسه مستمر بلا انقطاع\n` +
            `══════════════════════════════════════════════\n` +
            `أسطر «BOT» هي كلامك أنت في رسائل سابقة، وأسطر «USER» كلام المشاركين معك. ` +
            `أنت تكمل نفس الحوار من حيث توقف — لا تعيد الترحيب، لا تسأل «ماذا كنا نتحدث»، ` +
            `ولا تكرر ما قلتَه — تحدث كما لو أنك تذكر كل هذا بذاكرتك الطبيعية.\n\n` +
            lines.join('\n')
        );
    } catch (_) {
        return '';
    }
}

// ═══════════════════════════════════════════════════════════
//  التصفير — /محادثة-جديدة و /حذف-محادثة
// ═══════════════════════════════════════════════════════════

async function clearChannel({ agentId, guildId, channelId } = {}) {
    const c = col();
    if (!c) return { ok: false, deleted: 0 };
    try {
        const r = await c.deleteMany(chKey(agentId, guildId, channelId));
        return { ok: true, deleted: r.deletedCount || 0 };
    } catch (_) {
        return { ok: false, deleted: 0 };
    }
}

module.exports = {
    appendMessage,
    getRecent,
    countChannel,
    renderBlock,
    clearChannel,
    renderEntry,
    MAX_ENTRIES_PER_CHANNEL,
    DEFAULT_RENDER_LIMIT,
};
