/**
 * proactive.js — Disor Bot v7.3 "Sentinel"
 * ═══════════════════════════════════════════════════════════
 * الاستباقية — إصغاء القنوات بالكلمات المفتاحية.
 *
 * كل وكيل يملك: proactive_enabled + proactive_channels:
 *   [{ channel_id, keywords: [..], cooldown_minutes }]
 *
 * رسالة عادية (غير موجّهة للوكيل) في قناة مُصغاة تُعالج كمحادثة كاملة
 * فقط إذا: تطابقت كلمة مفتاحية + انتهت فترة التهدئة للقناة.
 *
 * الأمان: تهدئة إلزامية (1..720 دقيقة، افتراضي 10) — لا إزعاج ولا سبام.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const DEFAULT_COOLDOWN_MINUTES = 10;
const MIN_COOLDOWN_MINUTES = 1;
const MAX_COOLDOWN_MINUTES = 720;
const MAX_KEYWORDS = 12;
const MAX_KEYWORD_LEN = 60;

/** تطبيع نص عربي/لاتيني للمطابقة — نفس روح تطبيع الذاكرة */
function normalizeKeyword(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\u064B-\u0652\u0670]/g, '') // التشكيل
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/\s+/g, ' ')
        .trim();
}

/** تنظيف قائمة كلمات مفتاحية قادمة من إدخال المستخدم (فاصلة أو سطر جديد) */
function cleanKeywords(raw) {
    if (!raw) return [];
    const parts = String(raw)
        .split(/[,،\n]/)
        .map(k => normalizeKeyword(k))
        .filter(k => k.length >= 2 && k.length <= MAX_KEYWORD_LEN);
    return [...new Set(parts)].slice(0, MAX_KEYWORDS);
}

/** تحديد التهدئة ضمن الحدود المسموحة */
function clampCooldown(minutes) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOLDOWN_MINUTES;
    return Math.min(MAX_COOLDOWN_MINUTES, Math.max(MIN_COOLDOWN_MINUTES, Math.round(n)));
}

/** تنظيف قائمة قنوات الإصغاء القادمة من وثيقة الوكيل */
function sanitizeEntries(entries) {
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        const channel_id = String(e.channel_id || '').trim();
        if (!/^\d{5,25}$/.test(channel_id)) continue;
        const keywords = cleanKeywords(Array.isArray(e.keywords) ? e.keywords.join(',') : e.keywords);
        if (!keywords.length) continue; // بلا كلمات مفتاحية = لا إصغاء (أمان)
        out.push({
            channel_id,
            keywords,
            cooldown_minutes: clampCooldown(e.cooldown_minutes),
        });
    }
    return out.slice(0, 10); // حد أقصى 10 قنوات مُصغاة لكل وكيل
}

/**
 * محاولة مطابقة رسالة مع قنوات الإصغاء.
 * @param {object} p
 * @param {Array}  p.entries       قنوات الإصغاء (بعد sanitize)
 * @param {string} p.channelId     قناة الرسالة
 * @param {string} p.content       نص الرسالة
 * @param {boolean} p.isBot        هل الرسالة من بوت؟ (تُرفض دائماً)
 * @param {boolean} p.isDm         رسالة خاصة؟ (تُرفض — الاستباقية في السيرفرات فقط)
 * @param {number} p.now           الزمن الحالي (ms) — قابل للحقن للاختبارات
 * @param {Map}    p.cooldowns     خريطة تهدئة مشتركة `${guildId}:${channelId}` → ts
 * @param {string} p.guildId       لتمييز مفاتيح التهدئة
 * @returns {{entry: object, keyword: string} | null}
 */
function matchProactive({ entries, channelId, content, isBot = false, isDm = false, now = Date.now(), cooldowns = null, guildId = '' } = {}) {
    if (isBot || isDm) return null;
    const list = sanitizeEntries(entries);
    if (!list.length || !channelId) return null;

    const entry = list.find(e => e.channel_id === String(channelId));
    if (!entry) return null;

    const normalized = normalizeKeyword(content);
    if (!normalized) return null;

    const keyword = entry.keywords.find(k => normalized.includes(k));
    if (!keyword) return null;

    // التهدئة — لكل قناة على حدة
    if (cooldowns) {
        const key = `${guildId}:${entry.channel_id}`;
        const last = cooldowns.get(key) || 0;
        const elapsed = now - last;
        if (elapsed < entry.cooldown_minutes * 60 * 1000) return null;
        cooldowns.set(key, now);
    }

    return { entry, keyword };
}

/** هل الاستباقية مفعلة للوكيل؟ (توافق قديم: بلا إعداد = معطلة) */
function isEnabled(agentOrRuntime) {
    const cfg = agentOrRuntime?.proactive_enabled ?? agentOrRuntime?.features?.proactive;
    return Boolean(cfg);
}

module.exports = {
    DEFAULT_COOLDOWN_MINUTES,
    MIN_COOLDOWN_MINUTES,
    MAX_COOLDOWN_MINUTES,
    MAX_KEYWORDS,
    normalizeKeyword,
    cleanKeywords,
    clampCooldown,
    sanitizeEntries,
    matchProactive,
    isEnabled,
};
