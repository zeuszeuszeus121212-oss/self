/**
 * permissions.js — Disor Bot v7.13.0 «بلا أدمن»
 * ═══════════════════════════════════════════════════════════
 * 🛡️ الوكيل يعمل بدون صلاحية Administrator — مضمون بالتصميم.
 *
 * شكوى المالك (v7.13): وكلاء بدون رتبة أدمن يضعون إيموجي فقط ولا يردون.
 * الجذران اللذان يعالجهما هذا الملف:
 *
 *   1) صلاحية «إرسال الرسائل» مفقودة في القناة → message.reply() يرمي
 *      DiscordAPIError[50013] بعد أن استُهلك طلب الذكاء الاصطناعي كاملاً —
 *      فيرى المستخدم إيموجي فقط بلا رد وبلا سبب واضح.
 *      الحل: فحص القدرة على الرد *قبل* أي استهلاك للذكاء الاصطناعي.
 *
 *   2) مهمة عالقة بلا استجابة تحتجز قائمة القناة → كل رسالة تالية تحصل
 *      على 👀 إلى الأبد. الحل: ساعة توقف صارمة تُحرر القائمة وتُبلغ المالك.
 *
 * قواعد صارمة:
 *   • الأدمن (Administrator) **غير مطلوب إطلاقاً** — الحد الأدنى فقط:
 *     عرض القناة + إرسال الرسائل (ومن المستحسن: قراءة السجل + التفاعلات).
 *   • غياب معلومات الصلاحيات لا يحجب أبداً (fail-open) — الحجب الخاطئ
 *     أسوأ من فشل الرد، فنترك لديسكورد القرار حين لا نعرف.
 *   • بلا تبعيات — قابل للاختبار 100% بلا Discord ولا DB.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// الصلاحيات التي بدونها يستحيل الرد فعلياً — تجب الحجب قبل استهلاك الـ AI
const REPLY_REQUIRED_PERMS = Object.freeze(['ViewChannel', 'SendMessages']);

// صلاحيات تُكسِر تجربة الرد إن غابت لكنها لا تمنعه — نُنذر ولا نحجب
const REPLY_WARN_PERMS = Object.freeze(['ReadMessageHistory', 'AddReactions']);

// أسماء عربية ودودة — تظهر في التقارير و/شرح
const PERM_LABELS_AR = Object.freeze({
    ViewChannel        : 'عرض القناة',
    SendMessages       : 'إرسال الرسائل',
    ReadMessageHistory : 'قراءة سجل الرسائل',
    AddReactions       : 'إضافة التفاعلات',
    Administrator      : 'الأدمن (كل الصلاحيات)',
});

/**
 * فحص القدرة على الرد في قناة — من **قبل** أي عمل أو استهلاك ذكاء اصطناعي.
 * @param {object} p
 * @param {PermissionsBitField|null} p.perms صلاحيات البوت في هذه القناة (channel.permissionsFor(botMember))
 * @param {boolean} [p.hasBotMember=true] هل عضوية البوت معروفة أصلاً؟
 * @returns {{ ok: boolean, unknown: boolean, missing: string[], warnings: string[], isAdmin: boolean }}
 *   ok      = نستطيع الرد (أو لا نعلم — fail-open)
 *   unknown = لا توجد معلومات صلاحيات → لا نحجب أبداً
 */
function checkReplyAbility({ perms = null, hasBotMember = true } = {}) {
    if (!hasBotMember || !perms || typeof perms.has !== 'function') {
        return { ok: true, unknown: true, missing: [], warnings: [], isAdmin: false };
    }
    let isAdmin = false;
    try { isAdmin = perms.has('Administrator') === true; } catch (_) {}
    const missing = REPLY_REQUIRED_PERMS.filter((p) => {
        try { return !perms.has(p); } catch (_) { return false; }
    });
    const warnings = REPLY_WARN_PERMS.filter((p) => {
        try { return !perms.has(p); } catch (_) { return false; }
    });
    return { ok: missing.length === 0, unknown: false, missing, warnings, isAdmin };
}

/**
 * هل هذا الخطأ هو «صلاحيات ناقصة» من ديسكورد (50013 Missing Permissions)؟
 * يكشفه بأي شكل: code رقمي، أو الاسم DiscordAPIError[50013]، أو نص الرسالة.
 * @param {Error|any} error
 * @returns {boolean}
 */
function isMissingPermissionsError(error) {
    if (!error) return false;
    if (error.code === 50013) return true;
    const name = String(error.name || '');
    if (name.includes('50013')) return true;
    const msg = String(error.message || '');
    return msg.includes('Missing Permissions');
}

// ⏱️ السقف الزمني الافتراضي لمهمة رد واحدة — بعده تُحرر قائمة القناة حتماً
const DEFAULT_TASK_TIMEOUT_MS = 180_000;

/**
 * ساعة توقف صارمة حول عمل الرد — تضمن أن قائمة القناة **لا تعلق أبداً**
 * (المزود عالق/الشبكة ميتة/DB لا يجيب): بعد المهلة تعود النتيجة timedOut
 * والمهمة تُحرر للرسائل التالية فوراً. العمل المتأخر قد يكتمل لاحقاً في
 * الخلفية (رد متأخر أفضل من صمت أبدي) — وأي فشل متأخر يُبتلع بلا unhandled.
 *
 * @param {() => Promise<any>} factory دالة العمل
 * @param {number} [ms] المهلة بالملي ثانية
 * @returns {Promise<{ timedOut: boolean, result: any }>} يرمي إذا فشل العمل قبل المهلة
 */
async function withTaskTimeout(factory, ms = DEFAULT_TASK_TIMEOUT_MS) {
    const limit = Math.max(1, Number(ms) || DEFAULT_TASK_TIMEOUT_MS);
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, result: null }), limit);
    });
    const workPromise = Promise.resolve().then(factory);
    workPromise.catch(() => {}); // فشل متأخر بعد المهلة لا يصبح unhandled rejection
    try {
        return await Promise.race([
            workPromise.then((result) => ({ timedOut: false, result })),
            timeoutPromise,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * أسطر تشخيص الصلاحيات لبطاقة /شرح — تُرى على البوت نفسه في قناته.
 * @param {PermissionsBitField|null} perms صلاحيات البوت في قناة الأمر
 * @returns {string[]} أسطر Markdown جاهزة للحقن في البطاقة
 */
function buildPermissionDiagLines(perms) {
    const hasPerms = Boolean(perms && typeof perms.has === 'function');
    const ability = checkReplyAbility({ perms, hasBotMember: hasPerms });
    if (ability.unknown) {
        return ['⚠️ تعذّر قراءة صلاحياتي هنا — لو ما رددت عليّ، امنح رتبتي «إرسال الرسائل» في هذه القناة.'];
    }
    const lines = ['**🛡️ فحص قدرتي على الرد في هذي القناة:**'];
    for (const p of [...REPLY_REQUIRED_PERMS, ...REPLY_WARN_PERMS]) {
        const has = !ability.missing.includes(p) && !ability.warnings.includes(p);
        const label = PERM_LABELS_AR[p] || p;
        const note = (!has && p === 'SendMessages') ? ' ← هاي سبب صمتي هنا!' : '';
        lines.push(`${has ? '✅' : '❌'} ${label}${note}`);
    }
    lines.push('> 🛡️ صلاحية الأدمن **غير مطلوبة إطلاقاً** — يكفي منح رتبتي الصلاحيات أعلاه.');
    if (ability.missing.length) {
        const names = ability.missing.map((p) => `«${PERM_LABELS_AR[p] || p}»`).join(' و ');
        lines.push(`> 🔧 الإصلاح: إعدادات القناة ← صلاحيات الأدوار ← امنح رتبتي ${names}.`);
    }
    if (ability.warnings.length) {
        const names = ability.warnings.map((p) => `«${PERM_LABELS_AR[p] || p}»`).join(' و ');
        lines.push(`> 💡 مفقود (لا يمنع الرد لكنه يحسّن التجربة): ${names}.`);
    }
    return lines;
}

/** تنظيف حالة الاختبارات — لا حالة داخلية حالياً (توافق مستقبلي) */
function _resetForTests() {}

module.exports = {
    REPLY_REQUIRED_PERMS,
    REPLY_WARN_PERMS,
    PERM_LABELS_AR,
    DEFAULT_TASK_TIMEOUT_MS,
    checkReplyAbility,
    isMissingPermissionsError,
    withTaskTimeout,
    buildPermissionDiagLines,
    _resetForTests,
};
