/**
 * errorReporter.js — Disor Bot v7.8.0 "Poker Face"
 * ═══════════════════════════════════════════════════════════
 * 🕶️ سياسة وجه البوكر — خصوصية الأخطاء المطلقة:
 *
 *   القنوات العامة (حيث يتكلم الناس مع الوكيل) لا ترى تفاصيل تقنية أبداً:
 *   لا أسماء مزودين، لا نماذج، لا توكنات، لا رسائل استثناءات، لا شيء.
 *   ما يراه الناس هو اعتذار بشري محايد يوحي أن الوكيل مشغول فقط.
 *
 *   الأخطاء الحقيقية الكاملة (أي وكيل، أي مزود، أي تشخيص، أين ومتى ولمن)
 *   تُرسل إلى قناة الإشعارات المحددة من لوحة التحكم عبر مُخبِر المدير
 *   (bot.js يحقن دالة notify هنا عند الإقلاع) + console.error دائماً.
 *
 *   هذا الملف آمن تماماً: كل دالة فيه لا ترمي استثناءً ولا تعلق الرد
 *   على المستخدم — التقرير حيٌّ ثانوي لا يعطل مسار المحادثة أبداً.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════
//  🎭 الوجوه العامة — ردود بشرية محايدة عند أي خلل داخلي
//  قواعد صارمة: بلا ⚠️/❌، بلا كلمات "خطأ/نموذج/مزود/توكن/أدوات/نظام"،
//  بلا اعتراف بأن ثمة تقنية انكسرت — مجرد "أنا مشغول/تشتت" بشري.
// ═══════════════════════════════════════════════════════════
const PUBLIC_FACES = Object.freeze([
    'ها! لا تراسلوني بنفس الوقت.. عليّ ضغط هسة 😅 جرب بعد شوي',
    'هدوا شوي يا جماعة 😮‍💨 عليّ ضغط.. أكلمك بعد قليل',
    'ترى عليّ ضغط هلا.. لا تراسلوني بنفس الوقت ها! 🙏',
    'لحظة لحظة 😅 صرت مشغول شوي.. عاود الكلمة بعد شوي',
    'ما أقدر أركز بكل هالرسائل مرة وحدة 😅 انتظرني شوي',
    'ثانية وحدة.. ذهني مشغول هسة 🙃 عاود اسألي بعد شوي',
    'عليّ ضغط شديد هسة 😮‍💨 خليني آخذ نفَس وأرجع لك',
]);

/** وجه بشري عشوائي للقنوات العامة — بلا أي تفصيل تقني */
function randomPublicFace() {
    return PUBLIC_FACES[Math.floor(Math.random() * PUBLIC_FACES.length)];
}

/** هل هذا النص أحد الوجوه العامة؟ (للاختبارات) */
function isPublicFace(text) {
    return PUBLIC_FACES.includes(String(text || '').trim());
}

// ═══════════════════════════════════════════════════════════
//  📡 المُخبِر — bot.js يحقن notify هنا عند الإقلاع
//  التقرير يصل قناة الإشعارات عبر مدير البوت (حل القناة:
//  قناة الوكيل ← قناة السيرفر ← القناة العامة) — نفس بنية notify
// ═══════════════════════════════════════════════════════════
let managerNotifier = null;

function setManagerNotifier(fn) {
    managerNotifier = typeof fn === 'function' ? fn : null;
}

// ═══════════════════════════════════════════════════════════
//  🔁 تهدئة التكرار — نفس الخطأ لنفس الوكيل لا يغرق القناة:
//  أول حدوث خلال النافذة يُسجل ويُرسل؛ التكرارات تُعَدّ وتُذكر
//  مجمّعة في أول تقرير تالٍ مختلف أو بعد انتهاء النافذة.
// ═══════════════════════════════════════════════════════════
const DEDUPE_WINDOW_MS = 60_000;
const recentErrors = new Map(); // key → { at, count }

function dedupeKey(agentId, coreText) {
    const h = crypto.createHash('sha1').update(String(coreText || '')).digest('hex').slice(0, 16);
    return `${String(agentId || 'default')}:${h}`;
}

// ═══════════════════════════════════════════════════════════
//  🚨 التقرير المفصل — يذهب لقناة الإشعارات فقط (ليس للقنوات العامة)
// ═══════════════════════════════════════════════════════════

/**
 * reportAgentError — يبني تقريراً تفصيلياً كاملاً ويوصله لقناة الإشعارات.
 * لا يرمي أبداً — كل خطوة محمية، والفشل ينتهي بـ console.error فقط.
 *
 * @param {object}  p
 * @param {string}  p.agentId        معرف الوكيل (من runtime)
 * @param {string}  [p.agentName]    اسم الوكيل الودود
 * @param {string}  [p.agentKind]    'agent' | 'chat'
 * @param {object}  [p.client]       كلاينت الوكيل (للتحقق من الاسم فقط)
 * @param {string}  [p.source]       'provider' | 'unexpected' | 'slash' | 'account'
 * @param {object}  [p.guild]        سيرفر الحدث
 * @param {object}  [p.channel]      قناة الحدث
 * @param {object}  [p.user]         { id, username } — آخر من كلمه
 * @param {Array}   [p.providerErrors] [{id,label,message}] — فشلالسلسلة بالترتيب
 * @param {Error}   [p.error]        الاستثناء الأصلي
 * @param {string}  [p.context]      سطر سياق إضافي
 * @param {number}  [p.now]          حقن الزمن (للاختبارات)
 * @returns {Promise<{delivered: boolean, suppressed: boolean}>}
 */
async function reportAgentError({
    agentId = 'default',
    agentName = null,
    agentKind = null,
    client = null,
    source = 'runtime',
    guild = null,
    channel = null,
    user = null,
    providerErrors = [],
    error = null,
    context = '',
    now = Date.now(),
} = {}) {
    const errText = String(error?.message || error || '—').slice(0, 500);
    const stackLine = error?.stack ? String(error.stack).split('\n').slice(1, 3).join(' | ').slice(0, 300) : '';

    // ── 1) التهدئة: نفس الخطأ لنفس الوكيل خلال النافذة = عدّاد فقط ──
    const key = dedupeKey(agentId, `${source}|${errText}`);
    const prev = recentErrors.get(key);
    if (prev && (now - prev.at) < DEDUPE_WINDOW_MS) {
        prev.count += 1;
        return { delivered: false, suppressed: true };
    }
    const carriedCount = prev ? prev.count : 0;
    recentErrors.set(key, { at: now, count: 0 });
    // تنظيف المفاتيح القديمة — الخريطة لا تكبر بلا حدود
    if (recentErrors.size > 200) {
        for (const [k, v] of recentErrors) {
            if ((now - v.at) >= DEDUPE_WINDOW_MS) recentErrors.delete(k);
        }
    }

    // ── 2) بناء التقرير الكامل ──
    const displayName = agentName
        || client?.user?.displayName
        || client?.user?.username
        || null;

    const SOURCE_LABELS = Object.freeze({
        provider  : 'فشل سلسلة المزودين (لا يوجد بديل متاح)',
        unexpected: 'استثناء غير متوقع أثناء معالجة رسالة',
        slash     : 'استثناء داخل أمر Slash',
        account   : 'فشل رد الحساب الحقيقي (AI Reply)',
        runtime   : 'خطأ Runtime',
        // 🛡️ v7.13 «بلا أدمن» — تشخيص صلاحيات واضح بدل إيموجي غامض
        permissions: 'البوت لا يملك صلاحية الرد في القناة (الأدمن غير مطلوب — يكفي: عرض القناة + إرسال الرسائل)',
        timeout    : 'تجاوز الحد الزمني للمعالجة — المزود لم يستجب وحُررت قائمة الانتظار تلقائياً',
    });

    const detailLines = [
        `🤖 **الوكيل:** ${displayName ? `«${displayName}»` : '—'} \`${agentId}\`${agentKind ? ` — وضع: **${agentKind === 'chat' ? 'محادثة 💬' : 'وكيل 🤖'}**` : ''}`,
        `🩺 **المصدر:** ${SOURCE_LABELS[source] || source}`,
        guild ? `📡 **السيرفر:** ${guild.name || '—'} \`${guild.id || '—'}\`` : null,
        channel ? `#️⃣ **القناة:** ${channel.name ? `#${channel.name}` : '—'} \`${channel.id || '—'}\`` : null,
        user ? `👤 **آخر مُتفاعل:** @${user.username || '—'} \`${user.id || '—'}\`` : null,
        Array.isArray(providerErrors) && providerErrors.length
            ? `🔌 **سلسلة المزودين (${providerErrors.length}):**\n${providerErrors
                .map((pe, i) => `↳ ${i + 1}. **${pe.label || pe.id || 'مزود'}** — ${String(pe.message || '—').slice(0, 300)}`)
                .join('\n')}`
            : null,
        error ? `🐞 **التشخيص:** ${errText}` : null,
        stackLine ? `🧵 **الأثر:** \`${stackLine}\`` : null,
        context ? `📎 **سياق:** ${String(context).slice(0, 200)}` : null,
        carriedCount > 0 ? `♻️ **تكرر ${carriedCount} مرة خلال الدقيقة الماضية** (كُبِّط إرسالها)` : null,
        `🕒 **الوقت:** ${new Date(now).toISOString()}`,
    ].filter(Boolean);
    const detailText = detailLines.join('\n');

    // ── 3) console.error دائماً — السجل المحلي مصدر لا يسقط ──
    console.error(`[ErrorReport ${agentId}] (${source})`, errText, stackLine || '');

    // ── 4) حفظ في agent_logs — للأرشفة والتحقيق لاحقاً ──
    try {
        const cfg = require('./config');
        if (cfg.logs_col?.insertOne) {
            await cfg.logs_col.insertOne({
                agent_id  : String(agentId),
                type      : 'agent_error',
                message   : errText,
                extra     : { source, agentKind, guildId: guild?.id || null, channelId: channel?.id || null, userId: user?.id || null, providers: providerErrors },
                created_at: new Date(),
            }).catch(() => {});
        }
    } catch (_) {}

    // ── 5) الإرسال لقناة الإشعارات عبر مدير البوت ──
    if (!managerNotifier) return { delivered: false, suppressed: false };
    try {
        await managerNotifier({
            type    : 'agent_error',
            agentId : String(agentId),
            title   : `🚨 خطأ في الوكيل${displayName ? ` «${displayName}»` : ''}`,
            message : detailText,
            level   : 'error',
            guildId : guild?.id || null,
            extra   : { source, error: errText },
        });
        return { delivered: true, suppressed: false };
    } catch (e) {
        console.error('[ErrorReport] فشل إرسال التقرير لقناة الإشعارات:', e.message);
        return { delivered: false, suppressed: false };
    }
}

/** تنظيف الحالة الداخلية — للاختبارات فقط */
function _resetForTests() {
    recentErrors.clear();
    managerNotifier = null;
}

module.exports = {
    PUBLIC_FACES,
    DEDUPE_WINDOW_MS,
    randomPublicFace,
    isPublicFace,
    setManagerNotifier,
    reportAgentError,
    _resetForTests,
};
