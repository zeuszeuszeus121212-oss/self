/**
 * qwenAccounts.js — Disor Bot v7.9 "Al-Raqeeb"
 * ═══════════════════════════════════════════════════════════
 * 🌐 حساب Qwen مستقل لكل سيرفر — «حساب تلقائي عند الانضمام»
 *
 * طلب المالك: لكل سيرفر حساب مختلف في Qwen — عند إضافة البوت
 * لسيرفر جديد يُنشأ حساب تلقائي هناك، فلا يُحرق توكن واحد
 * بضغط كل السيرفرات، ولا يوقف حظر حسابٍ واحد كل الوكلاء.
 *
 * الدورة الكاملة (حقيقية ومجرّبة ضد chat.qwen.ai):
 *   1) بريد مؤقت (mail.tm افتراضياً — قابلة للتبديل/التمديد)
 *   2) POST /api/v2/auths/signup → توكن Bearer JWT (30 يوم)
 *   3) تفعيل تلقائي: قراءة رسالة التفعيل من البريد وفتح الرابط
 *   4) تأكيد عبر /api/v2/auths/signin → الحساب «active»
 *   5) تجديد التوكن دورياً بالـ signin قبل انتهائه
 *
 * الواقعية (بلا وعود فارغة):
 *   • الحساب غير المفعّل (pending) لا يقبل المحادثة من Qwen نفسه
 *     — لذلك التوكن المفعّل فقط يُستخدم للتشغيل.
 *   • لو فشل البريد المؤقت (خدماتهم متقلبة) يُخزن الحساب مع
 *     بياناته كاملة (email/password) والحالة «pending» — المالك
 *     يراها في /الرصد ويستطيع تفعيلها يدوياً من بريده.
 *   • صفر تأثير على الوكلاء: بلا حساب مفعّل → يعمل الوكيل
 *     بتوكنه المُهيأ كما هو (التوفر أولاً دائماً).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');
const axios = require('axios');

const QWEN_API_BASE = process.env.QWEN_API_BASE || 'https://chat.qwen.ai/api/v2';
const MAIL_BASE = process.env.QWEN_MAIL_API || 'https://api.mail.tm';
const SIGNUP_TIMEOUT_MS = 30_000;
const TOKEN_TTL_WARN_MS = 3 * 24 * 3600 * 1000; // تجديد قبل 3 أيام من الانتهاء
const TIMER_INTERVAL_MS = 12 * 3600 * 1000;     // فحص كل 12 ساعة

let notifier = null; // مُبلّغ اختياري (قناة إشعارات المالك) — يُحقن من bot.js
function setNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }
async function safeNotify(payload) {
    try { if (notifier) await notifier(payload); } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
//  أدوات مساعدة
// ══════════════════════════════════════════════════════════════

const rndHex = (n = 6) => crypto.randomBytes(n).toString('hex');

function generateCredentials() {
    const tag = rndHex(4);
    return {
        name: `DisorGuild${tag}`,
        email: `disor.g${tag}@gmail.com`,
        password: `Dx${rndHex(6)}#Zq${rndHex(2)}`,
    };
}

function accountsCol() {
    try { return require('./config').qwen_guild_accounts_col || null; } catch (_) { return null; }
}

function validToken(doc) {
    return Boolean(doc?.token && doc.expires_at && new Date(doc.expires_at).getTime() - Date.now() > TOKEN_TTL_WARN_MS);
}

// ══════════════════════════════════════════════════════════════
//  البريد المؤقت — mail.tm (قابلة للتمديد بمزودات إضافية لاحقاً)
// ══════════════════════════════════════════════════════════════

async function createTempMailbox() {
    const domainsRes = await axios.get(`${MAIL_BASE}/domains`, { timeout: 15_000 });
    const domain = (domainsRes.data?.['hydra:member'] || []).find(d => d.isActive)?.domain;
    if (!domain) throw new Error('لا يوجد نطاق بريد مؤقت متاح');

    const tag = rndHex(5);
    const address = `disor.${tag}@${domain}`;
    const password = `Dx${tag}#MailZ9`;
    await axios.post(`${MAIL_BASE}/accounts`, { address, password }, {
        headers: { 'Content-Type': 'application/json' }, timeout: 15_000,
    });

    // التوكن قد يتأخر عن إنشاء الحساب — نجرّب قليلاً
    for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const tk = await axios.post(`${MAIL_BASE}/token`, { address, password }, {
                headers: { 'Content-Type': 'application/json' }, timeout: 15_000,
            });
            if (tk.data?.token) return { address, password, mailToken: tk.data.token, provider: 'mail.tm' };
        } catch (_) {}
    }
    // البريد أُنشئ لكن لا يمكن قراءته الآن — بلا mailToken
    return { address, password, mailToken: null, provider: 'mail.tm' };
}

/** قراءة رسالة التفعيل واستخراج رابط chat.qwen.ai — best effort */
async function fetchActivationLink(mailbox, maxWaitMs = 90_000) {
    if (!mailbox?.mailToken) return null;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 6000));
        try {
            const msgs = await axios.get(`${MAIL_BASE}/messages`, {
                headers: { Authorization: `Bearer ${mailbox.mailToken}` }, timeout: 15_000,
            });
            const list = msgs.data?.['hydra:member'] || [];
            for (const m of list) {
                const full = await axios.get(`${MAIL_BASE}/messages/${m.id}`, {
                    headers: { Authorization: `Bearer ${mailbox.mailToken}` }, timeout: 15_000,
                }).catch(() => null);
                if (!full?.data) continue;
                const d = full.data;
                const html = [d.text, d.html && Array.isArray(d.html) ? d.html.join(' ') : d.html]
                    .filter(Boolean).join(' ');
                const link = html.match(/https:\/\/[^"'\s<>\\]*chat\.qwen\.ai[^"'\s<>\\]*/i)?.[0]
                    || html.match(/https:\/\/[^"'\s<>\\]*(?:verify|activate|confirm)[^"'\s<>\\]*/i)?.[0];
                if (link) return link;
            }
        } catch (_) {}
    }
    return null;
}

// ══════════════════════════════════════════════════════════════
//  Qwen — signup / signin / التفعيل
// ══════════════════════════════════════════════════════════════

async function qwenSignup({ name, email, password }) {
    const res = await axios.post(`${QWEN_API_BASE}/auths/signup`,
        { name, email, password },
        { headers: { 'Content-Type': 'application/json' }, timeout: SIGNUP_TIMEOUT_MS });
    const data = res.data?.data || {};
    if (!data.token) throw new Error('تسجيل Qwen بدون توكن: ' + JSON.stringify(res.data || {}).slice(0, 200));
    return {
        token: data.token,
        userId: data.id || null,
        role: data.role || 'pending',
        expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null,
    };
}

/** دخول ببيانات الحساب — يعمل فقط بعد التفعيل؛ يُستخدم للتأكيد والتجديد */
async function qwenSignin(email, password) {
    const res = await axios.post(`${QWEN_API_BASE}/auths/signin`,
        { email, password },
        { headers: { 'Content-Type': 'application/json' }, timeout: SIGNUP_TIMEOUT_MS });
    const data = res.data?.data || {};
    if (res.data?.success === false || !data.token) {
        return { ok: false, reason: data.message || 'غير مفعّل بعد' };
    }
    return {
        ok: true,
        token: data.token,
        expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : new Date(Date.now() + 30 * 24 * 3600 * 1000),
    };
}

/** فتح رابط التفعيل ثم التأكيد بـ signin — يحوّل الحساب إلى active إن نجح */
async function activateAccount(doc, { link = null } = {}) {
    const col = accountsCol();
    if (!doc) return { ok: false, error: 'لا يوجد حساب' };

    // 1) فتح رابط التفعيل إن وُجد
    if (link) {
        await axios.get(link, { timeout: 30_000, maxRedirects: 5 }).catch(() => {});
    }

    // 2) التأكيد بالدخول — ناجح فقط إن كان الحساب مفعّلاً فعلاً
    const sign = await qwenSignin(doc.email, doc.qwen_password).catch((e) => ({ ok: false, reason: e.message }));
    if (sign.ok && col) {
        await col.updateOne({ guild_id: doc.guild_id }, { $set: {
            token: sign.token,
            expires_at: sign.expiresAt,
            status: 'active',
            activated_at: new Date(),
            last_signin_at: new Date(),
            last_error: '',
            updated_at: new Date(),
        } }).catch(() => {});
        await safeNotify({
            type: 'qwen_account', level: 'success',
            title: `🌐✅ حساب Qwen الخاص بسيرفر <#${doc.guild_id}> أصبح جاهزاً`,
            message: `البريد: ${doc.email} — التوكن مُجدَّد تلقائياً كل 30 يوماً.`,
            guildId: doc.guild_id,
        });
        return { ok: true };
    }

    if (col) {
        await col.updateOne({ guild_id: doc.guild_id }, { $set: {
            last_error: sign.reason || 'لم يصل رابط التفعيل',
            updated_at: new Date(),
        } }).catch(() => {});
    }
    return { ok: false, reason: sign.reason || 'رابط التفعيل غير متوفر' };
}

// ══════════════════════════════════════════════════════════════
//  الواجهة العامة
// ══════════════════════════════════════════════════════════════

/**
 * تسجيل حساب Qwen جديد لسيرفر — من بريد مؤقت، ويُخزن كامل بياناته.
 * لا يرمي أبداً — يعيد {ok, status, error?}
 */
async function registerGuildAccount(guildId, { reason = 'manual' } = {}) {
    const col = accountsCol();
    if (!col) return { ok: false, status: 'unavailable', error: 'قاعدة البيانات غير متصلة' };
    const gid = String(guildId);

    try {
        // بريد مؤقت (إن تعطل — بريد جينيريك pending يُفعَّل يدوياً)
        let mailbox = null;
        try { mailbox = await createTempMailbox(); } catch (mailErr) {
            console.warn('[QwenAccounts] البريد المؤقت تعطل:', mailErr.message);
        }

        const creds = generateCredentials();
        const email = mailbox?.address || creds.email;
        const signup = await qwenSignup({ name: creds.name, email, password: creds.password });

        const doc = {
            guild_id: gid,
            email,
            mail_password: mailbox?.password || '',   // لقراءة بريد التفعيل لاحقاً
            mail_token: mailbox?.mailToken || '',
            mail_provider: mailbox?.provider || '',
            qwen_password: creds.password,            // 🔐 يُخزن لعملية signin/التفعيل
            token: signup.token,
            user_id: signup.userId,
            role: signup.role,
            expires_at: signup.expiresAt,
            status: 'pending',
            reason,
            last_error: mailbox ? '' : 'البريد المؤقت تعطل — التفعيل يدوياً',
            created_at: new Date(),
            updated_at: new Date(),
        };
        await col.updateOne({ guild_id: gid }, { $set: doc, $setOnInsert: { created_at: new Date() } }, { upsert: true });

        console.log(`[QwenAccounts] ✅ حساب جديد للسيرفر ${gid} (${email}) — الحالة: pending`);

        // 🔄 محاولة تفعيل تلقائي فورية (بريد → رابط → تأكيد)
        (async () => {
            try {
                const link = doc.mail_token ? await fetchActivationLink(doc) : null;
                const act = await activateAccount(doc, { link });
                if (!act.ok) console.warn(`[QwenAccounts] حساب ${gid} ما زال pending: ${act.reason || ''}`);
            } catch (e) {
                console.warn('[QwenAccounts] فشل التفعيل التلقائي:', e.message);
            }
        })();

        await safeNotify({
            type: 'qwen_account', level: 'info',
            title: '🌐 حساب Qwen تلقائي جديد لسيرفر',
            message: `السيرفر: ${gid} — البريد: ${email} — الحالة: قيد التفعيل (تنتهي صلاحية التوكن: ${signup.expiresAt ? signup.expiresAt.toISOString().slice(0, 10) : '—'})`,
            guildId: gid,
        });

        return { ok: true, status: 'pending', email };
    } catch (e) {
        console.error('[QwenAccounts] فشل تسجيل الحساب:', e.message);
        if (col) await col.updateOne({ guild_id: String(guildId) }, { $set: {
            status: 'failed', last_error: String(e.message || e).slice(0, 300), updated_at: new Date(),
        } }, { upsert: true }).catch(() => {});
        return { ok: false, status: 'failed', error: String(e.message || e).slice(0, 300) };
    }
}

/**
 * ضمان وجود حساب للسيرفر:
 *   • active سليم → إرجاعه كما هو
 *   • active قارب الانتهاء → تجديد بالـ signin
 *   • pending → إعادة محاولة التفعيل (بريد/تأكيد)
 *   • لا حساب → تسجيل جديد
 */
async function ensureGuildAccount(guildId, { reason = 'auto' } = {}) {
    const col = accountsCol();
    if (!col) return { ok: false, error: 'قاعدة البيانات غير متصلة' };
    const gid = String(guildId);

    let doc = null;
    try { doc = await col.findOne({ guild_id: gid }); } catch (_) {}

    if (!doc) return registerGuildAccount(gid, { reason });

    if (doc.status === 'active' && validToken(doc)) {
        return { ok: true, status: 'active', cached: true };
    }

    if (doc.status === 'active') {
        // تجديد التوكن
        const sign = await qwenSignin(doc.email, doc.qwen_password).catch((e) => ({ ok: false, reason: e.message }));
        if (sign.ok) {
            await col.updateOne({ guild_id: gid }, { $set: {
                token: sign.token, expires_at: sign.expiresAt, last_signin_at: new Date(), updated_at: new Date(),
            } }).catch(() => {});
            return { ok: true, status: 'active', renewed: true };
        }
        await col.updateOne({ guild_id: gid }, { $set: { status: 'pending', last_error: sign.reason || 'فشل التجديد', updated_at: new Date() } }).catch(() => {});
        return { ok: false, error: sign.reason || 'فشل تجديد التوكن' };
    }

    // pending — إعادة محاولة التفعيل
    const act = await activateAccount(doc, {});
    if (act.ok) return { ok: true, status: 'active', reactivated: true };
    return { ok: false, error: act.reason || 'ما زال قيد التفعيل' };
}

/**
 * التوكن الجاهز للتشغيل لسيرفر معيّن — فقط حسابات مفعّلة وسليمة.
 * لا ينشئ ولا ينشّط — قراءة آمنة سريعة لمسار runAgent.
 * @returns {Promise<string|null>}
 */
async function getGuildQwenToken(guildId) {
    const col = accountsCol();
    if (!col || !guildId) return null;
    try {
        const doc = await col.findOne({ guild_id: String(guildId), status: 'active' });
        return validToken(doc) ? doc.token : null;
    } catch (_) {
        return null;
    }
}

/** وثيقة الحساب لعرضها في /الرصد (بلا التوكن الحساس) */
async function describeGuildAccount(guildId) {
    const col = accountsCol();
    if (!col) return null;
    try {
        const doc = await col.findOne({ guild_id: String(guildId) });
        if (!doc) return null;
        return {
            status: doc.status,
            email: doc.email,
            created_at: doc.created_at,
            expires_at: doc.expires_at,
            last_error: doc.last_error || '',
        };
    } catch (_) {
        return null;
    }
}

/** كل حسابات السيرفرات — للوحة الرصد */
async function listGuildAccounts() {
    const col = accountsCol();
    if (!col) return [];
    try { return await col.find({}).sort({ created_at: -1 }).limit(200).toArray(); } catch (_) { return []; }
}

/** فحص دوري: تجديد التوكنات القاربة على الانتهاء + إعادة محاولة المعلّقة */
async function sweepAccounts() {
    const col = accountsCol();
    if (!col) return;
    try {
        const docs = await col.find({}).limit(500).toArray();
        for (const doc of docs) {
            try {
                if (doc.status === 'active' && !validToken(doc)) {
                    await ensureGuildAccount(doc.guild_id, { reason: 'sweep' });
                } else if (doc.status === 'pending') {
                    await ensureGuildAccount(doc.guild_id, { reason: 'sweep' });
                }
            } catch (_) {}
        }
    } catch (e) {
        console.warn('[QwenAccounts] sweep فشل:', e.message);
    }
}

let timersStarted = false;
function startQwenAccountTimers() {
    if (timersStarted) return;
    timersStarted = true;
    setInterval(() => sweepAccounts().catch(() => {}), TIMER_INTERVAL_MS).unref();
    console.log('🌐 [QwenAccounts] مجدول تجديد حسابات السيرفرات يعمل (كل 12 ساعة)');
}

module.exports = {
    setNotifier,
    registerGuildAccount,
    ensureGuildAccount,
    getGuildQwenToken,
    describeGuildAccount,
    listGuildAccounts,
    sweepAccounts,
    startQwenAccountTimers,
    // للاختبارات
    _internals: { generateCredentials, validToken, qwenSignup, qwenSignin, fetchActivationLink },
};
