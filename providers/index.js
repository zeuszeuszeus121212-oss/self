/**
 * providers/index.js — Disor Bot v7.1 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * سجل المزودين (Provider Registry) — قلب منصة الوكلاء متعددة النماذج.
 *
 * كل مزود يلتزم بنفس العقد (Contract):
 *   id, label, emoji, description
 *   modalFields()                → حقول النوافذ الخاصة به في المعالج والتعديل
 *   validate(config)             → {ok, missing[]}
 *   describe(config)             → سطر حالة للعرض
 *   chat({prompt, guildId, sessionId, parentMessageId, mode, thinking, config, agentId})
 *                                → {fullText, sessionId, newParentMessageId}
 *   testConnection(config)       → رسالة نجاح/فشل حقيقية
 *
 * إضافة مزود جديد = ملف جديد + سطر واحد هنا. لا شيء آخر يتغير.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const deepseek = require('./deepseek');
const qwen     = require('./qwen');
const openai   = require('./openai');

const PROVIDERS = {
    [deepseek.id]: deepseek,
    [qwen.id]   : qwen,
    [openai.id] : openai,
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

/** كل المزودين — للقوائم المنسدلة */
function listProviders() {
    return Object.values(PROVIDERS).map(p => ({
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
    extractProviderConfig,
    extractAllProviderConfigs,
    buildFallbackChain,
};
