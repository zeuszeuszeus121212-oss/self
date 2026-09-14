/**
 * providers/gemini.js — Disor Bot v7.4 "Nexus"
 * ═══════════════════════════════════════════════════════════
 * مزود Gemini — واجهة gemini.google.com عبر الكوكيز (وليس توكن).
 * نقل حقيقي من Universal AI Proxy v10.0 (GeminiBackend):
 *   • المصادقة: سلسلة كوكيز كاملة من المتصفح — تُعالج مختلفاً عن التوكنات
 *   • استخراج SNlM0e (at) + FdrFJe (f.sid) من صفحة التطبيق
 *   • StreamGenerate مع تتبع conversation_id / response_id / choice_id / at_token
 *   • تحديث الكوكيز الدوارة تلقائياً من ردود الخادم (SIDCC, PSIDTS...)
 *   • جلسات في الذاكرة لكل وكيل+قناة (TTL 6 ساعات) — نفس عقد المزودين
 *
 * ملاحظة: المفتاح هنا "كوكيز" وليس توكن — لذا validate و describe
 * والإعدادات كلها مبنية حول gemini_cookies.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');
const axios  = require('axios');

const GEMINI_BASE     = 'https://gemini.google.com';
const USER_ACCT       = 'u/1';
const GEMINI_BL       = 'boq_assistant-bard-web-server_20260817.02_p0';
const MODEL_JSPB      = '[1,null,null,null,"fbb127bbb056c959",null,null,0,[4,5,6,8,4,5,6,8],null,null,1,null,null,1,1,"036033AF-386B-4A1C-A8B6-F563586CF2B9"]';
const STREAM_PATH     = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const APP_PATH        = `/${USER_ACCT}/app`;
const REQUEST_TIMEOUT = 180_000;
const SESSION_TTL_MS  = 6 * 60 * 60 * 1000;

/** الكوكيز التي يحدّثها الخادم أحياناً — نراقبها ونستخدم الجديدة */
const TRACKED_COOKIES = new Set([
    'SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
    '__Secure-1PSIDTS', '__Secure-3PSIDTS',
    'COMPASS', '_gcl_au', '_ga_WC57KJ50ZZ', '_ga_BF8Q35BMLM',
]);

// ═════════════════════════════════════════════════════════
//  الجلسات — RAM لكل sessionId (الذي يأتي من runtime كل قناة)
// ═════════════════════════════════════════════════════════

/** @type {Map<string, {cookies: Object, snlm0e: string, fdrfje: string|null, conv: Object|null, last_used: number}>} */
const sessions = new Map();

function getSession(sessionId) {
    if (!sessionId) return null;
    const s = sessions.get(sessionId);
    if (s) s.last_used = Date.now();
    return s || null;
}

function setSession(sessionId, data) {
    sessions.set(sessionId, { ...data, last_used: Date.now() });
    return sessions.get(sessionId);
}

function evictOldSessions() {
    const now = Date.now();
    for (const [k, v] of sessions) {
        if (now - v.last_used > SESSION_TTL_MS) sessions.delete(k);
    }
}

/** تصفير جلسة محددة — يُستخدم عند فشل الرد بالكامل (كوكيز ميتة مثلاً) */
function dropSession(sessionId) {
    if (sessionId) sessions.delete(sessionId);
}

// ═════════════════════════════════════════════════════════
//  الكوكيز — تحليل وتحديث
// ═════════════════════════════════════════════════════════

/**
 * تنظيف مدخل الكوكيز قبل التحليل — يعالج أشهر أخطاء اللصق:
 *  • كلمة "Cookie:" الزائدة التي ينسخها المستخدم من ترويسات المتصفح
 *    (بدون التنظيف يُبتلع أول كوكي حقيقي ويصبح اسمه "Cookie" → فشل جلسة!)
 *  • الأسطر الجديدة بين الكوكيز (نسخ من جدول DevTools)
 */
function normalizeCookiesInput(raw) {
    let s = String(raw || '');
    s = s.replace(/^\s*[Cc]ookie\s*:\s*/, '');            // كلمة "Cookie:" في البداية
    s = s.replace(/[\r\n]+/g, '; ');                      // الأسطر الجديدة → فاصلة كوكيز
    // توحيد الفواصل: إزالة الفواصل المكررة/المسافات الزائدة
    // (نسخ DevTools غالباً تنتهي كل كوكي بـ ; فينتج ;; عند دمج الأسطر)
    s = s.split(';').map(x => x.trim()).filter(Boolean).join('; ');
    return s.trim();
}

function parseCookieString(str) {
    const out = {};
    for (const part of normalizeCookiesInput(str).split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) {
            out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
        }
    }
    return out;
}

function cookiesToString(cookies) {
    return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** دمج كوكيز جديدة من Set-Cookie — يعيد قائمة الأسماء المحدثة */
function mergeSetCookies(store, setCookieHeader) {
    const updated = [];
    const items = Array.isArray(setCookieHeader) ? setCookieHeader : (setCookieHeader ? [setCookieHeader] : []);
    for (const raw of items) {
        const first = String(raw).split(';')[0];
        const idx = first.indexOf('=');
        if (idx <= 0) continue;
        const name = first.slice(0, idx).trim();
        const value = first.slice(idx + 1).trim();
        if (TRACKED_COOKIES.has(name) && store[name] !== value) {
            store[name] = value;
            updated.push(name);
        }
    }
    return updated;
}

// ═════════════════════════════════════════════════════════
//  Headers
// ═════════════════════════════════════════════════════════

function geminiHeaders(cookiesStr) {
    return {
        'authority'      : 'gemini.google.com',
        'accept'         : '*/*',
        'accept-language': 'ar,en-US;q=0.9,en;q=0.8',
        'origin'         : 'https://gemini.google.com',
        'referer'        : 'https://gemini.google.com/',
        'user-agent'     : 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36',
        'x-same-domain'  : '1',
        'content-type'   : 'application/x-www-form-urlencoded;charset=UTF-8',
        'cookie'         : cookiesStr,
    };
}

// ═════════════════════════════════════════════════════════
//  استخراج SNlM0e + FdrFJe من صفحة التطبيق
// ═════════════════════════════════════════════════════════

function extractTokens(html) {
    let snlm0e = null;
    let fdrfje = null;
    for (const re of [/"SNlM0e":"(.*?)"/, /'SNlM0e':'(.*?)'/, /SNlM0e["\s]*:["\s]*"([^"]+)"/]) {
        const m = String(html || '').match(re);
        if (m) { snlm0e = m[1]; break; }
    }
    for (const re of [/"FdrFJe":"([\d-]+)"/, /'FdrFJe':'([\d-]+)'/, /FdrFJe["\s]*:["\s]*"([\d-]+)"/]) {
        const m = String(html || '').match(re);
        if (m) { fdrfje = m[1]; break; }
    }
    return { snlm0e, fdrfje };
}

async function fetchTokens(cookies, baseUrl) {
    const base = String(baseUrl || GEMINI_BASE).replace(/\/+$/, '');
    let url = `${base}${APP_PATH}`;
    const headers = geminiHeaders(cookiesToString(cookies));
    delete headers['content-type'];

    let html = '';
    let resp = null;
    // تتبع التحويلات يدوياً (كما في البروكسي) لالتقاط كوكيز كل خطوة
    for (let hop = 0; hop < 5; hop++) {
        resp = await axios.get(url, {
            headers,
            timeout: 30_000,
            maxRedirects: 0,
            validateStatus: () => true,
        });
        mergeSetCookies(cookies, resp.headers && resp.headers['set-cookie']);
        const loc = resp.headers && (resp.headers.location || resp.headers.Location);
        if ([301, 302, 303, 307, 308].includes(resp.status) && loc) {
            url = loc.startsWith('/') ? base + loc : loc;
            continue;
        }
        html = String(resp.data || '');
        break;
    }

    const { snlm0e, fdrfje } = extractTokens(html);
    if (!snlm0e) {
        const err = new Error('Gemini: لم أجد SNlM0e — الكوكيز منتهية أو الحساب غير متاح. انسخ كوكيز جديدة من المتصفح.');
        err.geminiCookiesDead = true;
        throw err;
    }
    return { snlm0e, fdrfje };
}

// ═════════════════════════════════════════════════════════
//  إرسال الرسالة — StreamGenerate وتفكيك الرد التزايدي
// ═════════════════════════════════════════════════════════

async function sendPrompt({ cookies, cookieHeader, snlm0e, fdrfje, prompt, conv, baseUrl }) {
    const base = String(baseUrl || GEMINI_BASE).replace(/\/+$/, '');

    const context = conv
        ? [conv.conversation_id || '', conv.response_id || '', conv.choice_id || '', null, null, null, null, null, null, conv.at_token || '']
        : ['', '', '', null, null, null, null, null, null, ''];

    const d1 = [[prompt, 0, null, null, null, null, 0], ['ar'], context, null, null, null, [], 0, [], [], 1, 0];
    const payload = { at: snlm0e, 'f.req': JSON.stringify([null, JSON.stringify(d1)]) };
    const params = {
        bl: GEMINI_BL, hl: 'ar', pageId: 'none',
        _reqid: String(Math.floor(1_000_000 + Math.random() * 8_999_999)),
        rt: 'c', 'f.sid': fdrfje || '',
    };

    const headers = geminiHeaders(cookieHeader);
    headers['x-goog-ext-525001261-jspb'] = MODEL_JSPB;
    headers['x-goog-ext-73010989-jspb']  = '[0]';
    headers['x-goog-ext-73010990-jspb']  = '[0,0,0]';

    let fullText = '';
    const newConv = conv ? { ...conv } : {};
    let newAtToken = null;

    const resp = await axios.post(`${base}${STREAM_PATH}`, new URLSearchParams(payload).toString(), {
        params,
        headers,
        timeout: REQUEST_TIMEOUT,
        responseType: 'stream',
        validateStatus: () => true,
    });

    if (resp.status !== 200) {
        throw new Error(`Gemini HTTP ${resp.status} — قد تكون الكوكيز منتهية أو مرفوضة`);
    }

    await new Promise((resolve) => {
        let buf = '';
        resp.data.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                try {
                    const a1 = JSON.parse(line);
                    if (!Array.isArray(a1) || !a1.length || !Array.isArray(a1[0]) || a1[0].length < 3 || !a1[0][2]) continue;
                    const c2 = JSON.parse(a1[0][2]);
                    if (!Array.isArray(c2)) continue;
                    if (!newConv.conversation_id && Array.isArray(c2[1]) && c2[1].length >= 2) {
                        newConv.conversation_id = c2[1][0];
                        newConv.response_id = c2[1][1];
                    }
                    const candidates = c2[4];
                    if (Array.isArray(candidates) && candidates[0]) {
                        const choice = candidates[0];
                        if (choice[0]) newConv.choice_id = choice[0];
                        const text = choice[1] && choice[1][0];
                        if (text && typeof text === 'string' && text.startsWith(fullText)) {
                            fullText = text; // الرد يصل تزايدياً — نسخة أطول من السابق
                        }
                    }
                    if (c2[3] && typeof c2[3] === 'object' && c2[3]['26']) newAtToken = c2[3]['26'];
                } catch (_) { continue; }
            }
        });
        resp.data.on('end', resolve);
        resp.data.on('error', resolve);
    });

    if (newAtToken) newConv.at_token = newAtToken;
    return { fullText, newConv: newConv.conversation_id ? newConv : null };
}

// ═════════════════════════════════════════════════════════
//  تعريف المزود — نفس العقد الموحد
// ═════════════════════════════════════════════════════════

const geminiProvider = {
    id       : 'gemini',
    label    : 'Gemini',
    // ⚠️ يجب أن يكون إيموجي يونيكود قياسي من مجموعة Twemoji التي يقبلها ديسكورد.
    // '✦' (U+2726) ليس ضمنها — كان يفشل بناء القوائم المنسدلة كاملة بخطأ
    // options[N].emoji.name[COMPONENT_INVALID_EMOJI] عند الإنشاء وعند صفحة المزود باللوحة.
    emoji    : '✨',
    description: 'Gemini عبر gemini.google.com بالكوكيز (وليس توكن) — جلسات حقيقية وتتبع محادثة وتحديث كوكيز تلقائي',

    modalFields: [
        // ⚠️ 4000 = الحد الأقصى المطلق لنوافذ ديسكورد — لا يمكن رفعه أبداً.
        // كوكيز أطول من 4000؟ تُرسل كملف من زر «الكوكيز من ملف» في صفحة إعدادات الوكيل (بلا حد فعلي).
        // الحقل اختياري هنا حتى لا يُحجب إنشاء الوكيل، والتحقق الحقيقي يحدث عند التشغيل.
        // 🔑 v7.11: كل سطر = جلسة بديلة كاملة — يتبدل المحرك للسطر التالي عند فشل الحالي.
        { id: 'gemini_cookies', label: 'سطر Cookie (كل سطر جلسة بديلة 🔑)', style: 'paragraph', required: false, maxLength: 4000 },
    ],

    validate(config = {}) {
        const missing = [];
        const raw = String(config.gemini_cookies || '');
        if (!raw.trim()) {
            missing.push('gemini_cookies');
            return { ok: missing.length === 0, missing };
        }
        // كوكيز جوجل لا تعمل أبداً بلا معرف جلسة — يكفي واحد منها؛ نسمّيها بالاسم إن غابت كلها
        const parsed = parseCookieString(raw);
        const authKeys = ['__Secure-1PSID', 'SID', '__Secure-3PSID'];
        const hasAuth = authKeys.some(k => parsed[k]);
        if (!hasAuth) {
            missing.push('كوكيز ناقصة: لا تحتوي أي معرف جلسة (__Secure-1PSID أو SID أو __Secure-3PSID) — انسخ سطر Cookie كاملاً وليس جزءاً منه');
        }
        return { ok: missing.length === 0, missing };
    },

    describe(config = {}) {
        const c = String(config.gemini_cookies || '');
        let note = '';
        if (c) {
            const parsed = parseCookieString(c);
            const hasSecure = Boolean(parsed['__Secure-1PSID'] || parsed.SID);
            note = hasSecure ? 'كوكيز سليمة الشكل ✅' : 'الشكل غير مكتمل ⚠️';
        }
        // 🔑 v7.11: الكوكيز نفسها قد تكون مجموعة جلسات متعددة (كل سطر جلسة بديلة)
        const { countKeys } = require('./index');
        const sessions = countKeys(this.id, config);
        const sessionsNote = sessions > 1 ? ` — 🔑 ${sessions} جلسات بديلة` : '';
        return `Cookies: ${c ? `موجودة ✅ (${Object.keys(parseCookieString(c)).length} مفتاحاً — ${note})` : 'مفقودة ❌'}${sessionsNote}`;
    },

    /**
     * إرسال prompt والحصول على الرد — نفس عقد المزودين
     * sessionId هنا = `gem:<uuid>` نديرها داخلياً (حالة Gemini لكل قناة)
     */
    async chat({ prompt, sessionId = null, thinking = false, config = {}, agentId = 'default' }) {
        const rawCookies = normalizeCookiesInput(config.gemini_cookies);
        if (!rawCookies) throw new Error('gemini_cookies مفقودة لهذا الوكيل');

        evictOldSessions();

        const baseUrl = config.gemini_base_url; // اختبارات فقط
        const sessionKey = (sessionId && String(sessionId).startsWith('gem:')) ? String(sessionId) : null;

        let session = getSession(sessionKey);
        let ourKey = sessionKey || `gem:${crypto.randomUUID()}`;

        if (!session || !session.snlm0e) {
            const cookies = parseCookieString(rawCookies);
            const { snlm0e, fdrfje } = await fetchTokens(cookies, baseUrl);
            session = setSession(ourKey, { cookies, snlm0e, fdrfje, conv: null });
        }

        const cookieHeader = cookiesToString(session.cookies);

        let fullText = '';
        let newConv = null;
        try {
            const r = await sendPrompt({
                cookies     : session.cookies,
                cookieHeader,
                snlm0e      : session.snlm0e,
                fdrfje      : session.fdrfje,
                prompt      : String(prompt || ''),
                conv        : session.conv || null,
                baseUrl,
            });
            fullText = r.fullText;
            newConv = r.newConv;
        } catch (e) {
            // جلسة فاسدة (توكنات صفحة انتهت) — نظفها ليُعاد البناء في الطلب القادم
            dropSession(ourKey);
            throw e;
        }

        if (newConv) session.conv = newConv;

        const text = String(fullText || '').trim();
        if (!text) throw new Error('Gemini أرجع رداً فارغاً — جرّب مجدداً أو حدّث الكوكيز.');

        return {
            fullText           : text,
            sessionId          : ourKey,
            newParentMessageId : null, // threading تُدار داخلياً في حالة الجلسة
        };
    },

    /** اختبار اتصال حقيقي — استخراج توكنات الصفحة بالكوكيز الحالية */
    async testConnection(config = {}) {
        const rawCookies = normalizeCookiesInput(config.gemini_cookies);
        if (!rawCookies) throw new Error('gemini_cookies مفقودة');
        const cookies = parseCookieString(rawCookies);
        const { snlm0e } = await fetchTokens(cookies, config.gemini_base_url);
        return `✅ اتصال Gemini ناجح — توكنات الصفحة سليمة (SNlM0e: ${String(snlm0e).slice(0, 8)}…) والكوكيز مقبولة`;
    },
};

module.exports = geminiProvider;
// داخلية — للاختبارات
module.exports.__internals = { parseCookieString, cookiesToString, mergeSetCookies, extractTokens, sessions, dropSession, normalizeCookiesInput };
