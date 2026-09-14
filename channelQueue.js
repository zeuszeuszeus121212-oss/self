/**
 * channelQueue.js — Disor Bot v7.9 "Al-Raqeeb"
 * ═══════════════════════════════════════════════════════════
 * 🎭 قائمة انتظار الرسائل — «واحد واحد بس!»
 *
 * المشكلة: شخصان يتكلمان مع البوت في نفس القناة بنفس الوقت
 * → البوت يرد عليهما معاً (ررررربكة + تضارب جلسة القناة).
 *
 * الحل (طلب المالك):
 *   • يرد على الأول أولاً بالكامل.
 *   • الثاني (والثالث...) يُعلَّم على رسالته إيموجي 👀 فقط —
 *     دلالة «البوت شاف رسالتك وإنت في الانتظار».
 *   • أول ما يخلص من الأول يجي للثاني، وهكذا بالترتيب.
 *
 * قائمة لكل قناة (channelKey) مستقلة — قنوات مختلفة تعمل متوازية بلا تأثير.
 *
 * التصميم:
 *   - enqueueChannelTask(key, task) → { promise, wasBusy }
 *     wasBusy=true يعني كان في عمل قائم في نفس القناة (المفروض نحط 👀)
 *   - المهام تسير بالترتيب الصارم؛ فشل مهمة لا يكسر القائمة أبداً
 *   - تنظيف ذاتي: آخر مهمة تخلص → يُحذف مفتاح القناة من الذاكرة
 *   - بلا تبعيات — قابل للاختبار 100% بلا Discord ولا DB
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const queues = new Map(); // channelKey -> Promise (ذيل القائمة)
const depths = new Map(); // channelKey -> عدد المهام غير المنتهية (منتظرة + المنفذة)

/**
 * إضافة مهمة إلى قائمة قناة — تُنفذ بعد انتهاء كل ما قبلها.
 * @param {string} channelKey مفتاح فريد للقناة (guildId_channelId مثلاً)
 * @param {() => Promise<any>} task دالة غير متزامنة (يجب ألا ترمي — تُبتلع الأخطاء حماية للقائمة)
 * @returns {{ promise: Promise<any>, wasBusy: boolean }} wasBusy=true → كان في انتظار (نضع 👀)
 */
function enqueueChannelTask(channelKey, task) {
    const key = String(channelKey || 'global');
    const prev = queues.get(key) || Promise.resolve();
    const wasBusy = (depths.get(key) || 0) > 0;

    depths.set(key, (depths.get(key) || 0) + 1);

    let run;
    try {
        run = prev.then(task, task); // بغضّ النظر عن نتيجة السابقة — التالي يشتغل دائماً
    } catch (e) {
        // حماية نظرية إن was task غير دالة — نعاملها كمهمة فاشلة لا تكسر القائمة
        console.error('[ChannelQueue] مهمة غير صالحة:', e?.message || e);
        run = Promise.resolve();
    }

    const release = () => {
        const d = (depths.get(key) || 1) - 1;
        if (d <= 0) {
            depths.delete(key);
            if (queues.get(key) === stableTail) queues.delete(key);
        } else {
            depths.set(key, d);
        }
    };

    // ذيل القائمة — دائماً مستقر (بلا رفض) حتى لا تتراكم unhandled rejections
    const stableTail = (async () => {
        try { await run; } catch (_) {}
        release();
    })();
    queues.set(key, stableTail);

    // الوعد المُعاد للمستدعي يحمل نتيجة مهمته (قد يرفض — على المستدعي الصيد)
    return { promise: run, wasBusy };
}

/**
 * هل القناة مشغولة الآن (فيها مهمة منتظرة أو قيد التنفيذ)؟
 */
function isChannelBusy(channelKey) {
    return (depths.get(String(channelKey || 'global')) || 0) > 0;
}

/**
 * عدد المهام المعلقة لقناة (تشخيص/اختبارات)
 */
function channelDepth(channelKey) {
    return depths.get(String(channelKey || 'global')) || 0;
}

/** تفريغ كامل — للاختبارات فقط */
function _resetQueue() {
    queues.clear();
    depths.clear();
}

module.exports = {
    enqueueChannelTask,
    isChannelBusy,
    channelDepth,
    _resetQueue,
};
