/**
 * games/store.js — إعدادات لعب كل وكيل + إحصائياته (v7.14)
 * ═══════════════════════════════════════════════════════════
 * نقل مفهوم engineSettings/engineStats من tokenService في Auto:
 * في Auto الحساب = token وله إعدادات لكل محرك. هنا الوكيل = agent
 * ولكل (وكيل × سيرفر) إعدادات لعب مستقلة.
 *
 * الافتراضي: كل المحركات معطلة — بلا تفعيل صريح لا يعمل شيء إطلاقاً
 * (شرط المالك: «لا اريده ان يخرب اي شيء حالي»).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { getEngines, getEngine } = require('./engines');

// ⚡ كاش حي — خط الأنابيب يعمل على كل رسالة بوت، فلا يُسمح باستعلام DB كل مرة
const cache = new Map(); // `${agentId}:${guildId}` → { settings, loadedAt }
const CACHE_TTL_MS = 30_000;

function defaultSettings() {
    return {
        enabled     : false,   // المفتاح الرئيسي — معطل افتراضياً
        channel_id  : null,    // قناة زر التلقائية (حلقة إرسال الأمر كما في Auto zarChannel)
        zar_command : '-روليت', // أمر بدء الدورة (Auto يرسل '-روليت' حرفياً)
        ai_answers  : true,    // ريبلكا: جرّب الذكاء أولاً ثم القاموس (القاموس هو الاحتياط دائماً)
        suppress_ai : false,   // إطفاء ردود الذكاء على رسائل الألعاب المعالجة — افتراضياً بلا أي تغيير على السلوك الحالي
        social      : { enabled: false }, // 🫧 التفاعل الاجتماعي — معطل افتراضياً (v7.15 صفر كسر)
        engines     : getEngines().reduce((acc, engine) => {
            acc[engine.id] = { enabled: false, ...engine.defaultSettings };
            return acc;
        }, {}),
    };
}

function ensureCol() {
    const cfg = require('../config');
    if (!cfg.game_players_col) throw new Error('game_players_col غير متصلة — MongoDB غير مهيأ');
    return cfg.game_players_col;
}

function normalize(doc) {
    const base = defaultSettings();
    if (!doc) return base;
    const merged = { ...base };
    if (typeof doc.enabled === 'boolean') merged.enabled = doc.enabled;
    if (doc.channel_id) merged.channel_id = String(doc.channel_id);
    if (doc.zar_command) merged.zar_command = String(doc.zar_command).trim() || base.zar_command;
    if (typeof doc.ai_answers === 'boolean') merged.ai_answers = doc.ai_answers;
    if (typeof doc.suppress_ai === 'boolean') merged.suppress_ai = doc.suppress_ai;
    if (doc.social && typeof doc.social === 'object') {
        if (typeof doc.social.enabled === 'boolean') merged.social.enabled = doc.social.enabled;
    }
    const docEngines = doc.engines && typeof doc.engines === 'object' ? doc.engines : {};
    for (const engine of getEngines()) {
        const saved = docEngines[engine.id] || {};
        merged.engines[engine.id] = {
            ...merged.engines[engine.id],
            ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined && v !== null)),
            enabled: Boolean(saved.enabled),
        };
    }
    return merged;
}

function cacheKey(agentId, guildId) {
    return `${String(agentId)}:${String(guildId)}`;
}

/** اقرأ إعدادات (وكيل × سيرفر) — من الكاش الحي ثم DB ثم الافتراضي المعطل */
async function getGameSettings(agentId, guildId) {
    const key = cacheKey(agentId, guildId);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.settings;

    let settings;
    try {
        const col = ensureCol();
        const doc = await col.findOne({ agent_id: String(agentId), guild_id: String(guildId) });
        settings = normalize(doc);
    } catch (_) {
        settings = defaultSettings(); // بلا DB: الافتراضي المعطل — آمن
    }
    cache.set(key, { settings, loadedAt: Date.now() });
    return settings;
}

/** حدّث إعدادات (وكيل × سيرفر) — patch جزئي + إبطال الكاش فوراً */
async function updateGameSettings(agentId, guildId, patch = {}) {
    const col = ensureCol();
    const $set = { updated_at: new Date() };
    if (typeof patch.enabled === 'boolean') $set.enabled = patch.enabled;
    if (patch.channel_id !== undefined) $set.channel_id = patch.channel_id ? String(patch.channel_id) : null;
    if (patch.zar_command !== undefined) $set.zar_command = String(patch.zar_command || '').trim() || '-روليت';
    if (typeof patch.ai_answers === 'boolean') $set.ai_answers = patch.ai_answers;
    if (typeof patch.suppress_ai === 'boolean') $set.suppress_ai = patch.suppress_ai;
    if (patch.social && typeof patch.social === 'object' && typeof patch.social.enabled === 'boolean') {
        $set['social.enabled'] = patch.social.enabled;
    }
    if (patch.engines && typeof patch.engines === 'object') {
        for (const [engineId, value] of Object.entries(patch.engines)) {
            if (!getEngine(engineId)) continue;
            if (typeof value === 'boolean') {
                $set[`engines.${engineId}.enabled`] = value;
            } else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    $set[`engines.${engineId}.${k}`] = v;
                }
            }
        }
    }
    await col.updateOne(
        { agent_id: String(agentId), guild_id: String(guildId) },
        { $set, $setOnInsert: { agent_id: String(agentId), guild_id: String(guildId), created_at: new Date() } },
        { upsert: true },
    );
    cache.delete(cacheKey(agentId, guildId)); // إبطال فوري — التغيير حي بلا إعادة تشغيل
    return getGameSettings(agentId, guildId);
}

function invalidateAgent(agentId) {
    for (const key of [...cache.keys()]) {
        if (key.startsWith(`${String(agentId)}:`)) cache.delete(key);
    }
}

// ════════════════════════════════════════════════════════════
//  الإحصائيات — في الذاكرة للجلسة + سجل دائم في agent_logs
//  (نفس حقول Auto engineStats: joins/plays/wins/losses/errors)
// ════════════════════════════════════════════════════════════

const stats = new Map(); // `${agentId}:${guildId}` → { joins, plays, wins, losses, errors, last_event }
const recentEvents = new Map(); // `${agentId}` → آخر 12 حدثاً للعرض في اللوحة

function statsFor(agentId, guildId) {
    const key = cacheKey(agentId, guildId);
    if (!stats.has(key)) {
        stats.set(key, { joins: 0, plays: 0, wins: 0, losses: 0, errors: 0, last_event: null });
    }
    return stats.get(key);
}

function incrementStats(agentId, guildId, field) {
    const s = statsFor(agentId, guildId);
    if (s[field] !== undefined) s[field] += 1;
    s.last_event = { field, at: new Date() };
    return s;
}

function pushRecentEvent(agentId, event) {
    const key = String(agentId);
    if (!recentEvents.has(key)) recentEvents.set(key, []);
    const list = recentEvents.get(key);
    list.unshift({ ...event, at: new Date().toISOString() });
    if (list.length > 12) list.length = 12;
    return list;
}

function getRecentEvents(agentId) {
    return [...(recentEvents.get(String(agentId)) || [])];
}

function resetSessionStats(agentId, guildId) {
    if (guildId) stats.delete(cacheKey(agentId, guildId));
    else for (const key of [...stats.keys()]) if (key.startsWith(`${String(agentId)}:`)) stats.delete(key);
}

/** سجل دائم في agent_logs — نفس نمط accountAgent.remember */
async function logGameEvent(agentId, guildId, event) {
    try {
        const cfg = require('../config');
        if (!cfg.logs_col) return;
        await cfg.logs_col.insertOne({
            agent_id  : String(agentId),
            guild_id  : guildId ? String(guildId) : null,
            type      : 'game_player',
            message   : event.type || 'game_event',
            extra     : event,
            created_at: new Date(),
        });
    } catch (_) {}
}

module.exports = {
    defaultSettings,
    getGameSettings,
    updateGameSettings,
    invalidateAgent,
    statsFor,
    incrementStats,
    pushRecentEvent,
    getRecentEvents,
    resetSessionStats,
    logGameEvent,
};
