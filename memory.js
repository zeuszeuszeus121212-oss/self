/**
 * memory.js — Disor Bot v7.2 "Real Agent"
 * ═══════════════════════════════════════════════════════════
 * الذاكرة طويلة المدى للوكلاء — وحدة التخزين الوحيدة لمجموعة agent_memories.
 *
 * كل وكيل يملك ذاكرته الخاصة عن كل مستخدم:
 *   • rememberFact  — إضافة حقيقة (dedup تلقائي + حد أقصى 200 لكل مستخدم)
 *   • recallFacts   — بحث بالكلمات المفتاحية + تعزيز الحداثة
 *   • forgetFacts   — نسيان بمعرف أو استعلام
 *   • buildMemoryContext — كتلة نصية تُحقن تلقائياً قبل كل محادثة
 *
 * الحماية: كل الدوال تعمل بأمان حتى لو MongoDB غير متصل (نتائج فارغة).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');

const MAX_MEMORIES_PER_USER = 200;
const CONTEXT_LIMIT = 12;           // عدد الذكريات المحقونة في السياق تلقائياً
const RECALL_LIMIT = 8;             // عدد نتائج recall افتراضياً
const RECENCY_WINDOW_MS = 30 * 24 * 3600 * 1000; // 30 يوم تعزيز حداثة كامل

function col() {
    const cfg = require('./config');
    return cfg.memories_col || null;
}

// ── تطبيع المحتوى للـ dedup: مسافات + ترميز موحد ──
function normalizeContent(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\u064B-\u0652\u0670]/g, '') // إزالة التشكيل العربي
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/\s+/g, ' ')
        .trim();
}

function fingerprint(text) {
    return crypto.createHash('sha256').update(normalizeContent(text)).digest('hex').slice(0, 32);
}

/** كلمات مفتاحية من نص — تدعم العربي واللاتيني والأرقام */
function tokenize(text) {
    return normalizeContent(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length >= 2)
        .filter(w => !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
    'في', 'من', 'على', 'عن', 'الى', 'إلى', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي',
    'هو', 'هي', 'انا', 'أنا', 'انت', 'أنت', 'كان', 'كانت', 'مع', 'كل', 'بعد',
    'قبل', 'لكن', 'أن', 'ان', 'ما', 'لا', 'او', 'أو', 'ثم', 'قد', 'the', 'and',
    'for', 'with', 'that', 'this', 'from', 'have', 'has',
]);

// ═══════════════════════════════════════════════════════════
//  الإضافة — مع dedup وحد أقصى
// ═══════════════════════════════════════════════════════════

/**
 * إضافة ذكرى جديدة لمستخدم داخل وكيل
 * @returns {{ok: boolean, duplicate?: boolean, id?: string, message: string}}
 */
async function rememberFact({ agentId, guildId, userId, content, kind = 'fact', tags = [] } = {}) {
    const c = col();
    const text = String(content || '').trim();
    if (!c) return { ok: false, message: 'قاعدة البيانات غير متصلة' };
    if (!text) return { ok: false, message: 'المحتوى فارغ' };
    if (!userId) return { ok: false, message: 'معرف المستخدم مفقود' };
    if (text.length > 1000) return { ok: false, message: 'الذكرى طويلة جداً (الحد 1000 حرف)' };

    const fp = fingerprint(text);
    const now = new Date();

    // dedup: نفس المحتوى لنفس المستخدم → تحديث حداثة بدل تكرار
    const existing = await c.findOne({ agent_id: agentId, user_id: userId, fingerprint: fp });
    if (existing) {
        await c.updateOne(
            { _id: existing._id },
            { $set: { updated_at: now, hit_boost: (existing.hit_boost || 0) + 1 } },
        );
        return { ok: true, duplicate: true, id: String(existing._id), message: 'هذه المعلومة محفوظة من قبل — جدّدت حداثتها' };
    }

    // الحد الأقصى: نحذف الأقدم أقل تفاعلاً عند الامتلاء
    const userCount = await c.countDocuments({ agent_id: agentId, user_id: userId });
    if (userCount >= MAX_MEMORIES_PER_USER) {
        const oldest = await c.find({ agent_id: agentId, user_id: userId })
            .sort({ updated_at: 1 }).limit(Math.ceil(MAX_MEMORIES_PER_USER * 0.05)).toArray();
        for (const doc of oldest) {
            await c.deleteOne({ _id: doc._id });
        }
    }

    const doc = {
        agent_id : String(agentId || 'default'),
        guild_id : guildId ? String(guildId) : null,
        user_id  : String(userId),
        kind     : ['fact', 'preference', 'event', 'skill'].includes(kind) ? kind : 'fact',
        content  : text,
        tags     : Array.isArray(tags) ? tags.slice(0, 8).map(t => String(t).slice(0, 40)) : [],
        fingerprint : fp,
        tokens   : tokenize(text).slice(0, 40),
        hits     : 0,
        hit_boost: 0,
        created_at: now,
        updated_at: now,
    };
    const res = await c.insertOne(doc);
    return { ok: true, id: String(res.insertedId), message: 'تم الحفظ' };
}

// ═══════════════════════════════════════════════════════════
//  البحث — كلمات مفتاحية + تعزيز حداثة
// ═══════════════════════════════════════════════════════════

/**
 * بحث في ذكريات مستخدم (أو كل مستخدمي الوكيل عند إذن أعلى)
 * @returns {{ok: boolean, results: Array<{id, content, kind, score, updated_at}>}}
 */
async function recallFacts({ agentId, userId, query = '', limit = RECALL_LIMIT, includeAllUsers = false } = {}) {
    const c = col();
    if (!c) return { ok: false, error: 'قاعدة البيانات غير متصلة', results: [] };

    const filter = { agent_id: String(agentId || 'default') };
    if (!includeAllUsers) {
        if (!userId) return { ok: false, error: 'معرف المستخدم مفقود', results: [] };
        filter.user_id = String(userId);
    }

    const docs = await c.find(filter).sort({ updated_at: -1 }).limit(500).toArray();
    const qTokens = new Set(tokenize(query));
    const hasQuery = qTokens.size > 0;

    const scored = [];
    for (const doc of docs) {
        // الصلة الأساسية: تطابق الكلمات فقط — بدونها لا تظهر النتيجة عند وجود استعلام
        let matchScore = 0;
        const docTokens = doc.tokens || tokenize(doc.content);
        for (const t of docTokens) {
            if (qTokens.has(t)) { matchScore += 3; continue; }
            // مطابقة جزئية للكلمات الطويلة (أحرف الجر الملتصقة بالعربي)
            for (const q of qTokens) {
                if (q.length >= 3 && (t.includes(q) || q.includes(t))) { matchScore += 1; break; }
            }
        }
        if (hasQuery && matchScore === 0) continue; // غير مطابق → مستبعد مهما كانت حديثاً

        // كسار الفصل: حداثة + تفاعل — تُطبق على المطابقين فقط
        const age = Date.now() - new Date(doc.updated_at).getTime();
        const recency = Math.max(0, 1 - age / RECENCY_WINDOW_MS);
        const score = matchScore + recency * 2 + Math.min((doc.hits || 0) + (doc.hit_boost || 0), 10) * 0.1;

        scored.push({ id: String(doc._id), content: doc.content, kind: doc.kind, tags: doc.tags || [], score, updated_at: doc.updated_at });
    }

    scored.sort((a, b) => b.score - a.score);

    // زيادة عداد الاستخدام للنتائج المعروضة
    const top = scored.slice(0, Math.min(Math.max(Number(limit) || RECALL_LIMIT, 1), 20));
    for (const t of top) {
        c.updateOne({ _id: safeObjectId(t.id) }, { $inc: { hits: 1 } }).catch(() => {});
    }

    return { ok: true, results: top };
}

// ═══════════════════════════════════════════════════════════
//  النسيان
// ═══════════════════════════════════════════════════════════

/**
 * نسيان ذكريات — بمعرف محدد، أو بكل ذكريات مستخدم، أو بـ query
 * @returns {{ok: boolean, deleted: number, message: string}}
 */
async function forgetFacts({ agentId, userId, id = null, query = '', all = false } = {}) {
    const c = col();
    if (!c) return { ok: false, deleted: 0, message: 'قاعدة البيانات غير متصلة' };
    if (!userId) return { ok: false, deleted: 0, message: 'معرف المستخدم مفقود' };

    if (id) {
        const oid = safeObjectId(String(id));
        if (!oid) return { ok: false, deleted: 0, message: 'معرف غير صالح' };
        const doc = await c.findOne({ _id: oid, agent_id: String(agentId || 'default'), user_id: String(userId) });
        if (!doc) return { ok: false, deleted: 0, message: 'لا توجد ذكرى بهذا المعرف ل هذا المستخدم' };
        await c.deleteOne({ _id: oid });
        return { ok: true, deleted: 1, message: 'نُسيت الذكرى المحددة' };
    }

    if (all && !query) {
        const r = await c.deleteMany({ agent_id: String(agentId || 'default'), user_id: String(userId) });
        return { ok: true, deleted: r.deletedCount || 0, message: `نُسيت كل الذكريات (${r.deletedCount || 0})` };
    }

    if (query) {
        const tokens = tokenize(query);
        if (!tokens.length) return { ok: false, deleted: 0, message: 'استعلام النسيان غير مفهوم' };
        const docs = await c.find({ agent_id: String(agentId || 'default'), user_id: String(userId) }).toArray();
        let deleted = 0;
        for (const doc of (docs || [])) {
            const docTokens = new Set(doc.tokens || tokenize(doc.content));
            const overlap = tokens.some(t => docTokens.has(t));
            if (overlap) {
                const dr = await c.deleteOne({ _id: doc._id });
                if (dr && dr.deletedCount) deleted++;
            }
        }
        return { ok: deleted > 0, deleted, message: deleted ? `نُسيت ${deleted} ذكرى` : 'لا ذكريات مطابقة' };
    }

    return { ok: false, deleted: 0, message: 'حدد معرف الذكرى أو استعلام أو all=true' };
}

// ═══════════════════════════════════════════════════════════
//  حقن السياق — يستدعى قبل كل محادثة تلقائياً
// ═══════════════════════════════════════════════════════════

/**
 * بناء كتلة الذكريات للسياق — أعلى ذكريات المستخدم (حداثة + تنوع)
 * @returns {string} نص فارغ إذا لا ذكريات — يُحقن فقط عند وجود محتوى
 */
async function buildMemoryContext({ agentId, guildId, userId } = {}) {
    try {
        if (!userId) return '';
        const c = col();
        if (!c) return '';
        const r = await recallFacts({ agentId, userId, limit: CONTEXT_LIMIT, includeAllUsers: false });
        if (!r.ok || !r.results.length) return '';
        const lines = r.results.map((m, i) => `${i + 1}. ${m.content}`);
        return (
            `[ذكرياتك المحفوظة عن هذا المستخدم — استخدمها بذكاء دون إعادة سردها حرفياً]\n` +
            lines.join('\n')
        );
    } catch (_) {
        return '';
    }
}

/** إحصائيات ذاكرة وكيل (للوحة التحكم) */
async function memoryStats(agentId) {
    const c = col();
    if (!c) return { ok: false, total: 0, users: 0 };
    const total = await c.countDocuments({ agent_id: String(agentId || 'default') });
    const users = await c.distinct('user_id', { agent_id: String(agentId || 'default') });
    return { ok: true, total, users: users.length };
}

/** مسح ذاكرة وكيل كاملة (من اللوحة — للمطور/الأدمن) */
async function clearAgentMemory(agentId) {
    const c = col();
    if (!c) return { ok: false, deleted: 0 };
    const r = await c.deleteMany({ agent_id: String(agentId || 'default') });
    return { ok: true, deleted: r.deletedCount || 0 };
}

function safeObjectId(s) {
    try {
        const { ObjectId } = require('mongodb');
        return new ObjectId(String(s));
    } catch (_) {
        return null;
    }
}

module.exports = {
    rememberFact,
    recallFacts,
    forgetFacts,
    buildMemoryContext,
    memoryStats,
    clearAgentMemory,
    // داخلية للاختبارات
    normalizeContent,
    fingerprint,
    tokenize,
    MAX_MEMORIES_PER_USER,
    CONTEXT_LIMIT,
};
