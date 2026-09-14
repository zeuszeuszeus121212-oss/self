/**
 * providers/index.js — Disor Bot v7.4 "Nexus"
 * ═══════════════════════════════════════════════════════════
 * سجل المزودين (Provider Registry) — قلب منصة الوكلاء متعددة النماذج.
 *
 * كل مزود يلتزم بنفس العقد (Contract):
 *   id, label, emoji, description
 *   modalFields()                → حقول النوافذ الخاصة به في المعالج والتعديل
 *   validate(config)             → {ok, missing[]}
 *   describe(config)             → سطر حالة للعرض
 *   chat({prompt, guildId, sessionId, parentMessageId, mode, thinking, search, images, config, agentId})
 *                                → {fullText, sessionId, newParentMessageId}
 *   generateImage?(opts)         → {ok, urls[]} — اختيارية (مدعومة مع Qwen)
 *   testConnection(config)       → رسالة نجاح/فشل حقيقية
 *
 * إضافة مزود جديد = ملف جديد + سطر واحد هنا. لا شيء آخر يتغير.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const deepseek = require('./deepseek');
const qwen     = require('./qwen');
const openai   = require('./openai');
const gemini   = require('./gemini');

const PROVIDERS = {
    [deepseek.id]: deepseek,
    [qwen.id]   : qwen,
    [openai.id] : openai,
    [gemini.id] : gemini,
};

const DEFAULT_PROVIDER = 'deepseek';

/**
 * جلب مزود بالمعرف — يرجع DeepSeek افتراضياً للتوافق مع الوكلاء القدامى
 * @param {string} id
 * @returns {object|null}
 */
function getProvider(id) {
    const key = String(id || DEFAULT_PROVIDER).toLowerCase().trim();
    return PROVIDERS[key] || null;
}

/** جلب مزود مع الرجوع لـ DeepSeek إن لم يوجد */
function getProviderOrFallback(id) {
    return getProvider(id) || PROVIDERS[DEFAULT_PROVIDER];
}

/** هل المعرف مزود صالح؟ */
function isValidProvider(id) {
    return Boolean(getProvider(id));
}

/**
 * كل المزودين — للقوائم المنسدلة وللصفحات التي تحتاج العقد الكامل.
 * ⚠️ درس v7.4.3: نسخة سابقة كانت ترجع كائنات مبتورة {id,label,emoji,description}
 * فانهارت صفحة «المزود» وأمر /المزود بخطأ p.validate is not a function.
 * العقد هنا: كائن المزود الكامل (validate/describe/modalFields/chat...) لكن
 * الإيموجي فقط يُستبدل بقيمة آمنة لقوائم ديسكورد (حماية من COMPONENT_INVALID_EMOJI).
 */
function listProviders() {
    const { safeMenuEmoji } = require('../utils');
    return Object.values(PROVIDERS).map(p => ({ ...p, emoji: safeMenuEmoji(p.emoji, '🧠') }));
}

/** نسخة مبتورة آمنة للقوائم المنسدلة فقط (label/value/description/emoji) */
function listProviderOptions() {
    return listProviders().map(p => ({
        id          : p.id,
        label       : p.label,
        emoji       : p.emoji,
        description : p.description,
    }));
}

/** استخراج إعدادات المزود من وثيقة الوكيل (agent doc) في MongoDB */
function extractProviderConfig(agentDoc) {
    const provider = getProviderOrFallback(agentDoc?.provider);
    const config = {};
    for (const field of provider.modalFields) {
        const v = agentDoc?.[field.id];
        if (v !== undefined && v !== null && String(v).trim() !== '') {
            config[field.id] = String(v).trim();
        }
    }
    return config;
}

/** استخراج إعدادات كل المزودين (للتبديل السريع بين المزودين المحفوظين) */
function extractAllProviderConfigs(agentDoc) {
    const all = {};
    for (const p of Object.values(PROVIDERS)) {
        all[p.id] = extractProviderConfig({ ...agentDoc, provider: p.id });
    }
    return all;
}

/**
 * 🔑 المفاتيح المتعددة لكل مزود (v7.11 — طلب المالك):
 * المالك يستطيع إدخال أكثر من مفتاح/توكن لنفس المزود في نفس الحقل،
 * مفصولة بسطر جديد أو «|» (أو «,» للمفاتيح النصية البسيطة — وليس
 * للكوكيز لأن الكوكيز نفسها تحوي فواصل). عند فشل المزود يستدل
 * محرك التعافي على المفتاح التالي تلقائياً.
 */

// حقل الهوية (المفتاح) لكل مزود — ما يدور حوله تبديل المفاتيح
const AUTH_FIELD = {
    deepseek: 'deepseek_token',
    qwen    : 'qwen_token',
    openai  : 'openai_api_key',
    gemini  : 'gemini_cookies',
};

/** الكوكيز حقول حساسة للفاصلة — لا نقسم عليها بالفواصل */
const COMMA_SAFE_FIELDS = new Set(['deepseek_token', 'qwen_token', 'openai_api_key']);

/**
 * تقسيم مفاتيح حقل معين باحترام طبيعته (كوكيز أم مفتاح نصي)
 */
function splitFieldKeys(fieldId, value) {
    const raw = String(value ?? '');
    if (!raw.trim()) return [];
    let parts = raw.split(/\r?\n|\|/g);
    if (COMMA_SAFE_FIELDS.has(String(fieldId))) parts = parts.flatMap(p => p.split(/,(?![^(]*\))/g));
    const keys = parts.map(s => s.trim()).filter(Boolean);
    return [...new Set(keys)];
}

/** حقل الهوية لمزود معين */
function authFieldFor(providerId) {
    return AUTH_FIELD[String(providerId)] || null;
}

/**
 * عدد المفاتيح المتاحة في إعدادات مزود
 * @returns {number} 0 إن لم يوجد مفتاح، 1 مفتاح واحد، 2+ متعدد
 */
function countKeys(providerId, config = {}) {
    const field = authFieldFor(providerId);
    if (!field) return 0;
    return splitFieldKeys(field, config[field]).length;
}

/** وصف حالة المفاتيح لسطر الحالة */
function describeKeys(providerId, config = {}) {
    const n = countKeys(providerId, config);
    if (!n) return 'مفقود ❌';
    if (n === 1) return 'موجود ✅';
    return `موجود ✅ (${n} مفاتيح بديلة 🔑)`;
}

/**
 * نسخة إعدادات بمفتاح محدد (بدون تعديل الأصل)
 * @param {number} keyIdx فهرس المفتاح — 0 هو الأساسي
 * @returns {object|null} null إن تجاوز الفهرس عدد المفاتيح
 */
function withKeyIndex(providerId, config = {}, keyIdx = 0) {
    const field = authFieldFor(providerId);
    if (!field) return keyIdx === 0 ? { ...config } : null;
    const keys = splitFieldKeys(field, config[field]);
    if (keyIdx >= keys.length) return null;
    return { ...config, [field]: keys[keyIdx] };
}

/**
 * بناء سلسلة Fallback للوكيل — الأساسي أولاً ثم البدائل الجاهزة بالترتيب.
 * @param {object} runtime - runtimeSettings للوكيل:
 *   { provider, providerConfig, fallback_enabled, fallback_chain, fallback_configs }
 * @returns {Array<{id, obj, config}>} الأساسي دائماً موجود؛ البدائل فقط إن كانت مفعلة وصالحة
 */
function buildFallbackChain(runtime = {}) {
    const primary = getProviderOrFallback(runtime.provider);
    const primaryCfg = (runtime.providerConfig && Object.keys(runtime.providerConfig).length)
        ? runtime.providerConfig
        : extractProviderConfig({ ...runtime, provider: primary.id });

    const chain = [{ id: primary.id, obj: primary, config: primaryCfg }];

    if (!runtime.fallback_enabled) return chain;
    const ids = Array.isArray(runtime.fallback_chain) ? runtime.fallback_chain : [];
    const allCfg = runtime.fallback_configs || {};

    for (const pid of ids) {
        if (chain.length >= 4) break; // حد أقصى 4 مستويات — حماية من التأخير المتراكم
        if (chain.some(c => c.id === String(pid))) continue;
        const p = getProvider(pid);
        if (!p) continue;
        const cfg = allCfg[pid] || extractProviderConfig({ ...(runtime.fallback_agent_doc || {}), provider: pid });
        // البديل يجب أن تكون إعداداته كاملة — وإلا تخطّاه بصمت
        if (!p.validate(cfg).ok) continue;
        chain.push({ id: p.id, obj: p, config: cfg });
    }
    return chain;
}

module.exports = {
    DEFAULT_PROVIDER,
    PROVIDERS,
    getProvider,
    getProviderOrFallback,
    isValidProvider,
    listProviders,
    listProviderOptions,
    extractProviderConfig,
    extractAllProviderConfigs,
    buildFallbackChain,
    // 🔑 المفاتيح المتعددة (v7.11)
    AUTH_FIELD,
    authFieldFor,
    splitFieldKeys,
    countKeys,
    describeKeys,
    withKeyIndex,
};
