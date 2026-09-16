/**
 * games/brain.js — عقل اللعب المشترك (v7.21.0)
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالك الحرفي (v7.21):
 *   «طلبت فقط أن يتم تمرير له رسائل الالعاب ويستطيع هو التصرف
 *    والتعليق والكلام ويعرف اللعبة وكأنه بشري هل هذا صعب؟»
 *   «هو طريقتك لاستعداءه لا عطاء تعليق خاطئة اذ لمادا اتكلم معه
 *    ينجح لكن تعليقك تقول انه يفشل؟»
 *
 * الجذر المثبت: الشات الرئيسي (tools/agent.js) يلعب بسلّم تعافي كامل
 * (بناء سلسلة المزودين + تدوير المفاتيح متعددة + إعادة محاولات + مزود
 * بديل) بينما كل استدعاءات الذكاء في الألعاب كانت تنادي المزود مباشرة
 * بمفتاح وحيد — مفتاح تالف = الشات ينجح واللعب يفشل دائماً. من اليوم
 * الألعاب تستعمل **نفس** السلّم حرفياً (نفس الدوال المصدَّرة).
 *
 * القرار: decide() — يمرر للذكاء مشهد رسالة اللعبة حرفياً (النص +
 * الأزرار) فيقرر بنفسه كإنسان: ينضم؟ يضغط أي زر؟ ماذا يقول؟
 * 🚫 لا حواجز كلمات، لا قواميس جاهزة، لا عشوائي مزيّف — الذكاء فقط.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// 🧠 v7.21 — ملاحظة معمارية: يُحل موديول المزودين **وقت النداء** لا وقت التحميل،
// لأن اختبارات المنصة تحقن مزوداً وهمياً عبر استبدال require.cache — والشات
// الرئيسي يفعل نفس الشيء. كما ندعم موديولاً بلا بناة (توافق الاختبارات):
// مسار المزود الواحد كما كان في v7.20.

// نقطة حقن للاختبارات (تبني سلسلة مزودات وهمية مباشرة)
let buildersOverride = null;
function __setBuilders(next) { buildersOverride = next || null; }

// حقن قرار للاختبارات — يعزل الاختبارات القديمة من نداءات المزود الحقيقية
let decideOverride = null;
function __setDecide(fn) { decideOverride = typeof fn === 'function' ? fn : null; }

const RETRIES_PER_KEY = 2;   // محادثة جديدة ×2 لكل مفتاح (نفس الشات الرئيسي)

/** بناء السلسلة وقت النداء — مع توافق موديول المزودين البديل (الاختبارات) */
function resolveChain(runtimeSettings) {
    if (buildersOverride) return buildersOverride.chain || [];
    let mod = null;
    try { mod = require('../providers'); } catch (_) {}
    if (mod && typeof mod.buildFallbackChain === 'function' && typeof mod.withKeyIndex === 'function') {
        return mod.buildFallbackChain(runtimeSettings || {});
    }
    // توافق الاختبارات: موديول بديل بلا بناة → المزود الواحد كما في v7.20
    const get = mod && typeof mod.getProviderOrFallback === 'function' ? mod.getProviderOrFallback : null;
    const obj = get ? get(runtimeSettings?.provider) : null;
    return obj ? [{ id: 'single', obj, config: runtimeSettings?.providerConfig || {} }] : [];
}

/** تدوير المفتاح وقت النداء (توافق الموديول البديل) */
function rotateKey(entry, keyIdx) {
    if (buildersOverride && typeof buildersOverride.withKeyIndex === 'function') {
        return buildersOverride.withKeyIndex(entry.id, entry.config, keyIdx);
    }
    let mod = null;
    try { mod = require('../providers'); } catch (_) {}
    if (mod && typeof mod.withKeyIndex === 'function') {
        return mod.withKeyIndex(entry.id, entry.config, keyIdx);
    }
    return keyIdx === 0 ? entry.config : null;
}

/**
 * استدعاء ذكاء بسلّم التعافي الكامل — نفس معنى الشات الرئيسي:
 * سلسلة مزودين (أساسي + بدائل) × مفاتيح متعددة × محاولات.
 * يرجع النص أو يرمي آخر خطأ بعد استنفاد السلّم.
 */
async function chatSmart(runtimeSettings, { prompt, timeoutMs = 9000 } = {}) {
    const chain = resolveChain(runtimeSettings);
    if (!chain || !chain.length) throw new Error('لا سلسلة مزودين');

    let lastError = null;
    for (let ci = 0; ci < chain.length; ci++) {
        const entry = chain[ci];
        // المفاتيح المتعددة لنفس المزود
        for (let ki = 0; ; ki++) {
            const rotated = rotateKey(entry, ki);
            if (!rotated) break; // نفدت المفاتيح → المزود التالي
            for (let attempt = 1; attempt <= RETRIES_PER_KEY; attempt++) {
                try {
                    const result = await Promise.race([
                        entry.obj.chat({ prompt, config: rotated, agentId: runtimeSettings?.agentId || 'games' }),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('ai_timeout')), timeoutMs)),
                    ]);
                    const text = result && (result.fullText || result.reply || result.text);
                    if (text && String(text).trim()) return String(text);
                    throw new Error('رد فارغ من المزود');
                } catch (error) {
                    lastError = error;
                    // مهلة الاتصال نفسها تحرق ربع مهلة التصويت — محاولة ثانية فقط بلا انتظار
                }
            }
        }
    }
    throw lastError || new Error('فشل كل المزودين');
}

/**
 * استخراج أول كائن JSON من نص الذكاء (يتسامح مع أي كلام حوله).
 */
function extractJson(text) {
    const raw = String(text || '');
    const start = raw.indexOf('{');
    if (start === -1) return null;
    // جرّب أقرب إغلاق متوازن
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth += 1;
        else if (raw[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                try { return JSON.parse(raw.slice(start, i + 1)); } catch (_) { return null; }
            }
        }
    }
    return null;
}

/** تطبيع قرار الذكاء إلى {act, button, say} أو null */
function normalizeDecision(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const actRaw = String(parsed.act || parsed.action || parsed.decision || '').toLowerCase().trim();
    if (!actRaw) return null;
    const actMap = {
        'join': 'join', 'انضمام': 'join', 'انضم': 'join', 'ادخل': 'join',
        'click': 'click', 'ضغط': 'click', 'اضغط': 'click',
        'none': 'none', 'لا شيء': 'none', 'nothing': 'none', 'تجاهل': 'none',
    };
    const act = actMap[actRaw] || null;
    if (!act) return null;
    const button = String(parsed.button || parsed.button_label || parsed.target || '').trim() || null;
    const say = String(parsed.say || parsed.comment || '').trim().slice(0, 120) || null;
    return { act, button, say };
}

/**
 * قرار الذكاء في مشهد لعبة — «يمرر له الرسالة وهو يتصرف كإنسان»:
 * النص الحرفي + أسماء الأزرار + من هو → {act: join|click|none, button, say}.
 * يرجع null عند فشل الذكاء (بعد السلّم الكامل) — لا تخمين ولا بديل مزيّف.
 */
async function decide({ runtimeSettings, agentName, scene, session, timeoutMs = 5000 }) {
    // حقن الاختبارات — يسبق كل شيء
    if (decideOverride) {
        try { return await decideOverride({ runtimeSettings, agentName, scene, session, timeoutMs }); }
        catch (_) { return null; }
    }
    try {
        const buttonsLine = (scene.buttons || [])
            .map((b, i) => `${i + 1}. ${b.label || '(بلا اسم)'}`)
            .join('\n');
        const contextLine = session
            ? `\nأنت الآن داخل جلسة حية: ${session.gameName || 'لعبة'}${session.mafia?.role ? ` — دورك: ${session.mafia.role}` : ''}\n`
            : '';
        const prompt =
            `أنت لاعب بشري في ديسكورد اسمك «${agentName || 'اللاعب'}».\n` +
            (contextLine) +
            `وصلت رسالة من بوت لعبة، نصها الحرفي:\n"""\n${String(scene.text || '').slice(0, 700)}\n"""\n` +
            (buttonsLine ? `\nالأزرار المتاحة في الرسالة:\n${buttonsLine}\n` : '\nلا توجد أزرار في الرسالة.\n') +
            `\nموقفك: ${scene.hint || 'لا تعرف إن كنت داخل هذه اللعبة أم لا'}\n\n` +
            'قرر كإنسان تماماً. أجب JSON فقط بدون أي كلام آخر:\n' +
            '{"act":"join|click|none","button":"اسم الزر بالحرف إن كنت ستضغط","say":"سطر قصير جداً تقوله في الشات إن كان مناسباً، أو نص فارغ"}\n' +
            'القاعدة: زر «انضمام/دخول» في رسالة لوبي = انضم عادي كأي لاعب. رسالة تصويت فيها أسماء لاعبين وأنت داخل الجولة = صوّت بعقلانية. غير ذلك = none.';
        const raw = await chatSmart(runtimeSettings, { prompt, timeoutMs });
        return normalizeDecision(extractJson(raw));
    } catch (_) {
        return null; // فشل الذكاء بعد السلّم كاملاً — صمت + التبليغ مرئي من المستدعي
    }
}

module.exports = {
    chatSmart,
    decide,
    extractJson,
    normalizeDecision,
    __setBuilders,
    __setDecide,
};
