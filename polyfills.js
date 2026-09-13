/**
 * polyfills.js — توافق بيئات التشغيل القديمة
 * ═══════════════════════════════════════════════════════════
 * ⚠️ يجب أن يكون أول require في كل نقاط الدخول (bot.js / config.js)
 *
 * السبب الجذري لكراش التشغيل المُبلّغ عنه:
 *   "❌ فشل الاتصال بـ MongoDB: crypto is not defined"
 *   "ReferenceError: crypto is not defined at randomBytes (mongodb/lib/utils.js)"
 *
 * درايفر mongodb 7.x يستخدم الغلوبال `crypto` (Web Crypto API) مباشرة:
 *   const randomBytes = (size) => Promise.resolve(crypto.getRandomValues(new Uint8Array(size)));
 * وهذا الغلوبال **غير معرّف افتراضياً في Node.js 18 وما قبله** (أصبح افتراضياً من Node 19)
 * فتنهار مصادقة SCRAM مع MongoDB عند أول اتصال.
 *
 * الحل: نحقن webcrypto من node:crypto في globalThis قبل تحميل أي وحدة أخرى.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

if (typeof globalThis.crypto === 'undefined') {
    try {
        const nc = require('node:crypto');
        if (nc && nc.webcrypto) {
            Object.defineProperty(globalThis, 'crypto', {
                value        : nc.webcrypto,
                writable     : true,
                enumerable   : true,
                configurable : true,
            });
        }
        // بيئات أقدم بكثير من Node 15 لا تملك webcrypto أصلاً —
        // درايفر mongodb 7.x يتطلب Node ≥ 16.20 على أي حال فلا بديل هنا.
    } catch (_) { /* تجاهل صامت — لا شيء يمكن فعله في هذه البيئة */ }
}

module.exports = {};
