/**
 * usage.js — Disor Bot v7.3 "Sentinel"
 * ═══════════════════════════════════════════════════════════
 * تتبع الاستخدام الحقيقي لكل وكيل — الوحدة الوحيدة لمجموعة agent_usage.
 *
 * وثيقة لكل { agent_id, guild_id, day } مع $inc — بلا عمليات قراءة مكلفة.
 *   messages        رسائل المستخدمين المُعالجة
 *   tool_calls      إجمالي استدعاءات الأدوات
 *   tool_counts.<name> تفصيل كل أداة
 *   web_calls       استدعاءات web_search/read_url
 *   provider_calls.<id> نجاح كل مزود
 *   fallbacks       تبديلات المزود التلقائية
 *   errors          أخطاء المزود/الأدوات
 *   reminders       تذكيرات أُرسلت
 *
 * كل الدوال آمنة بدون MongoDB (لا تُرمي أخطاء — تتبع الاختياري).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

function col() {
    try {
        const cfg = require('./config');
        return cfg.usage_col || null;
    } catch (_) {
        return null;
    }
}

/** مفتاح اليوم UTC — ثابت عبر العملية */
function dayKey(date = new Date()) {
    return new Date(date).toISOString().slice(0, 10);
}

/** خريطة الأنواع إلى حقول $inc */
function incFieldsFor(kind, meta = {}) {
    const $inc = {};
    switch (String(kind)) {
        case 'message' : $inc.messages = 1; break;
        case 'tool'    : {
            $inc.tool_calls = 1;
            const tool = String(meta.tool || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
            if (tool) $inc[`tool_counts.${tool}`] = 1;
            break;
        }
        case 'web'     : $inc.web_calls = 1; break;
        case 'provider': {
            const pid = String(meta.provider || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
            if (pid) $inc[`provider_calls.${pid}`] = 1;
            $inc.provider_total = 1;
            break;
        }
        case 'fallback': $inc.fallbacks = 1; break;
        case 'error'   : $inc.errors = 1; break;
        case 'reminder': $inc.reminders = 1; break;
        case 'knowledge': $inc.knowledge_hits = 1; break;
        default: return null;
    }
    return $inc;
}

/**
 * تسجيل حدث استخدام — لا يرمي أبداً (التتبع لا يعطّل الوكيل أبداً)
 * @param {string} agentId
 * @param {string|null} guildId
 * @param {string} kind  message | tool | web | provider | fallback | error | reminder | knowledge
 * @param {object} meta  {tool?, provider?}
 */
async function track(agentId, guildId, kind, meta = {}) {
    try {
        const c = col();
        if (!c || !agentId) return false;
        const $inc = incFieldsFor(kind, meta);
        if (!$inc) return false;
        await c.updateOne(
            { agent_id: String(agentId), guild_id: guildId ? String(guildId) : null, day: dayKey() },
            { $inc, $set: { updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
            { upsert: true },
        );
        return true;
    } catch (_) {
        return false; // فشل التتبع لا يعطل أي شيء
    }
}

/**
 * جلب سجل الاستخدام لوكيل عبر N يوم أخير
 * @returns {Promise<Array<{day, guild_id, messages, tool_calls, tool_counts, web_calls, provider_calls, fallbacks, errors, reminders, knowledge_hits}>>}
 */
async function getAgentUsage(agentId, days = 7) {
    const c = col();
    if (!c) return [];
    const since = new Date(Date.now() - (Math.max(1, Math.min(90, Number(days) || 7)) - 1) * 24 * 3600 * 1000);
    const rows = await c.find({
        agent_id: String(agentId),
        day: { $gte: dayKey(since), $lte: dayKey() },
    }).sort({ day: 1 }).limit(200).toArray();
    return rows;
}

/** تجميع ملخص من صفوف سجل */
function summarize(rows) {
    const out = {
        days: 0, messages: 0, tool_calls: 0, web_calls: 0,
        fallbacks: 0, errors: 0, reminders: 0, knowledge_hits: 0,
        provider_calls: {}, tool_counts: {},
        per_day: [],
    };
    for (const r of rows || []) {
        out.days++;
        out.messages += r.messages || 0;
        out.tool_calls += r.tool_calls || 0;
        out.web_calls += r.web_calls || 0;
        out.fallbacks += r.fallbacks || 0;
        out.errors += r.errors || 0;
        out.reminders += r.reminders || 0;
        out.knowledge_hits += r.knowledge_hits || 0;
        for (const [pid, n] of Object.entries(r.provider_calls || {})) {
            out.provider_calls[pid] = (out.provider_calls[pid] || 0) + (n || 0);
        }
        for (const [t, n] of Object.entries(r.tool_counts || {})) {
            out.tool_counts[t] = (out.tool_counts[t] || 0) + (n || 0);
        }
        out.per_day.push({ day: r.day, messages: r.messages || 0, tool_calls: r.tool_calls || 0 });
    }
    out.top_tools = Object.entries(out.tool_counts)
        .sort((a, b) => b[1] - a[1]).slice(0, 5);
    return out;
}

/** مخطط أعمدة نصي للرسائل اليومية — للعرض في embed */
function renderBars(perDay, { width = 10 } = {}) {
    if (!Array.isArray(perDay) || !perDay.length) return 'لا بيانات بعد';
    const max = Math.max(1, ...perDay.map(d => d.messages));
    return perDay.slice(-7).map(d => {
        const filled = Math.round((d.messages / max) * width);
        const bar = '█'.repeat(Math.max(d.messages > 0 ? 1 : 0, filled)) || '·';
        return `\`${d.day}\` ${bar} ${d.messages}`;
    }).join('\n');
}

module.exports = {
    dayKey,
    track,
    getAgentUsage,
    summarize,
    renderBars,
    incFieldsFor,
};
