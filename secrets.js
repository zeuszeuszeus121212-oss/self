/**
 * secrets.js — Disor Bot v7.4 "Nexus"
 * ═══════════════════════════════════════════════════════════
 * تشفير الأسرار (التوكنات) — AES-256-GCM.
 *
 * المبدأ:
 *   • مفتاح واحد من ENV `ENCRYPTION_KEY`:
 *       - hex 64 حرفاً  → يُستخدم خاماً كـ 32 بايت
 *       - أي عبارة أخرى → تُشتق بمفتاح scrypt (salt ثابت للتطبيق)
 *   • بلا مفتاح: لا تشفير — التوكنات تبقى كما كانت (توافق قديم) مع تحذير واحد.
 *
 * الصيغة: `enc:v1:<iv_base64>:<tag_base64>:<data_base64>`
 *   البادئة تميّز المشفر عن القديم — فك شفاف عند كل نقطة استخدام.
 *
 * الحقول السرية المعترف بها في وثيقة الوكيل (agents):
 *   discord_token, deepseek_token, qwen_token, openai_api_key, gemini_cookies
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const SALT = 'disor.agent.secrets.v1';

/** الحقول التي تُعد أسراراً في وثيقة الوكيل */
const SECRET_FIELDS = Object.freeze([
    'discord_token',
    'deepseek_token',
    'qwen_token',
    'openai_api_key',
    'gemini_cookies',
]);

// ── المفتاح: يُحسب مرة واحدة عند أول استدعاء ──
let _key = undefined;
let _warned = false;

function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * جلب مفتاح التشفير — null إن لم يُضبط ENCRYPTION_KEY
 * @returns {Buffer|null}
 */
function getKey() {
    if (_key !== undefined) return _key;
    const raw = process.env.ENCRYPTION_KEY;
    if (!raw || !String(raw).trim()) {
        _key = null;
        if (!_warned) {
            _warned = true;
            console.warn('⚠️ ENCRYPTION_KEY غير مضبوط — التوكنات ستُخزن نصاً صريحاً. أضف ENCRYPTION_KEY (hex 64 أو أي عبارة) لتفعيل التشفير.');
        }
        return _key;
    }
    const trimmed = String(raw).trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        _key = Buffer.from(trimmed, 'hex');
    } else {
        // عبارة نصية → اشتقاق ثابت ومستقر عبر scrypt
        _key = crypto.scryptSync(trimmed, SALT, 32);
    }
    return _key;
}

/** إعادة تعيين المفتاح المحسوب — للاختبارات فقط (تغيير ENV ثم الاستدعاء) */
function resetKeyForTests() {
    _key = undefined;
    _warned = false;
}

/**
 * تشفير نص سر — يعيد نفس النص إن كان التشفير معطلاً أو مُشفّراً مسبقاً.
 * @param {string} plain
 * @returns {string}
 */
function encryptSecret(plain) {
    if (plain === null || plain === undefined) return plain;
    const s = String(plain);
    if (!s || isEncrypted(s)) return s;
    const key = getKey();
    if (!key) return s; // التشفير معطل — نفس السلوك القديم
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/**
 * فك تشفير نص سر — pass-through للنص القديم غير المشفر.
 * @returns {string|null} null عند الفشل (عبث/مفتاح خاطئ/مفتاح مفقود)
 */
function decryptSecret(value) {
    if (value === null || value === undefined) return value;
    const s = String(value);
    if (!s) return s;
    if (!isEncrypted(s)) return s; // توافق قديم — نص صريح
    const key = getKey();
    if (!key) return null; // لا يمكن الفك بلا مفتاح
    try {
        const parts = s.split(':');
        // enc:v1:iv:tag:data → 5 أجزاء
        if (parts.length !== 5) return null;
        const [, ver, ivB64, tagB64, dataB64] = parts;
        if (ver !== 'v1') return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        const out = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
        return out.toString('utf8');
    } catch (_) {
        return null; // عبث أو مفتاح مختلف — لا تسريب
    }
}

/**
 * قناع عرض — يخفي كل السلسلة ويُظهر آخر 4 أحرف فقط.
 * يعمل مع المشفر والقديم معاً.
 * @param {string} value
 * @returns {string}
 */
function maskSecret(value) {
    if (value === null || value === undefined || value === '') return 'غير محدد';
    let s = String(value);
    if (isEncrypted(s)) s = decryptSecret(s) || '';
    if (!s) return 'غير قابل للفك 🔒';
    if (s.length <= 8) return '••••••••';
    return `••••••••${s.slice(-4)}`;
}

/**
 * نسخة من وثيقة الوكيل بحقولها السرية مفكوكة — تُستخدم عند كل قراءة للاستخدام الفعلي.
 * لا تعدّل الوثيقة الأصلية.
 * @param {object} agentDoc
 * @returns {object} نسخة ضحلة مفكوكة الأسرار
 */
function decryptAgentDoc(agentDoc) {
    if (!agentDoc || typeof agentDoc !== 'object') return agentDoc;
    const out = { ...agentDoc };
    for (const f of SECRET_FIELDS) {
        if (out[f] !== undefined && out[f] !== null && out[f] !== '') {
            out[f] = decryptSecret(out[f]);
        }
    }
    return out;
}

/**
 * تشفير حقول الأسرار داخل كائن $set قبل كتابته لقاعدة البيانات.
 * يعدّل الكائن ويعيده.
 * @param {object} patch
 * @returns {object}
 */
function encryptSecretsInPatch(patch) {
    if (!patch || typeof patch !== 'object') return patch;
    for (const f of SECRET_FIELDS) {
        const v = patch[f];
        if (typeof v === 'string' && v !== '' && !isEncrypted(v)) {
            patch[f] = encryptSecret(v);
        }
    }
    return patch;
}

/**
 * ترحيل شفاف: تشفير كل التوكنات النصية في مجموعة الوكلاء (idempotent).
 * يُستدعى مرة عند الإقلاع بعد الاتصال بقاعدة البيانات.
 * @param {Collection} agents_col
 * @returns {Promise<{skipped: boolean, reason?: string, scanned: number, encrypted: number}>}
 */
async function migrateAgentTokensEncryption(agents_col) {
    if (!agents_col) return { skipped: true, reason: 'قاعدة البيانات غير متصلة', scanned: 0, encrypted: 0 };
    if (!getKey()) return { skipped: true, reason: 'ENCRYPTION_KEY غير مضبوط', scanned: 0, encrypted: 0 };

    let scanned = 0;
    let encrypted = 0;
    try {
        const cursor = await agents_col.find({});
        for await (const doc of cursor) {
            scanned++;
            const $set = {};
            for (const f of SECRET_FIELDS) {
                const v = doc[f];
                if (typeof v === 'string' && v !== '' && !isEncrypted(v)) {
                    $set[f] = encryptSecret(v);
                }
            }
            if (Object.keys($set).length) {
                await agents_col.updateOne({ _id: doc._id }, { $set });
                encrypted++;
            }
        }
    } catch (e) {
        console.error('❌ [Secrets] فشل ترحيل التشفير:', e.message);
        return { skipped: true, reason: e.message, scanned, encrypted };
    }
    if (encrypted > 0) console.log(`🔐 [Secrets] شُفّرت توكنات ${encrypted}/${scanned} وكيل (AES-256-GCM)`);
    return { skipped: false, scanned, encrypted };
}

module.exports = {
    PREFIX,
    SECRET_FIELDS,
    isEncrypted,
    getKey,
    resetKeyForTests,
    encryptSecret,
    decryptSecret,
    maskSecret,
    decryptAgentDoc,
    encryptSecretsInPatch,
    migrateAgentTokensEncryption,
};
