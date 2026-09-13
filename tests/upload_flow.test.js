/**
 * tests/upload_flow.test.js — اختبارات v7.4.2
 * ─────────────────────────────────────────────────────────────
 * يغطي إصلاحَي الجولة السادسة:
 *  1) كراش التشغيل "crypto is not defined" داخل درايفر mongodb 7.x
 *     (الغلوبال crypto غير معرّف افتراضياً في Node < 19) → polyfills.js
 *  2) حد نوافذ ديسكورد المطلق 4000 حرف مقابل الكوكيز الطويلة
 *     → مسار ملف/لصق كامل (زر «الكوكيز من ملف» + handleSecretUploadMessage)
 *     مع تطبيع الكوكيز وتحققها وتشفيرها وتطبيقها حياً
 */

'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const FAKE_AGENT_ID = '507f1f77bcf86cd799439011';
process.env.ENCRYPTION_KEY = 'b'.repeat(64);

// وثيقة "قاعدة بيانات" قابلة للتحديث — updateOne يعدّلها و findOne يرجع نسخة منها
// (مثل mongo الحقيقي: الحفظ ثم القراءة تعيد القيمة الجديدة)
const dbDoc = {
    _id: FAKE_AGENT_ID, name: 'GEM', provider: 'gemini',
    gemini_cookies: '', discord_token: 'DT', status: 'stopped',
};

const updateCalls = [];
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: null, reminders_col: null, knowledge_col: null,
    usage_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), async updateOne() { return { modifiedCount: 1 }; } },
    providers_col: null,
    agents_col: {
        findOne: async () => ({ ...dbDoc }),
        updateOne: async (filter, patch) => {
            updateCalls.push(JSON.parse(JSON.stringify(patch)));
            Object.assign(dbDoc, patch.$set || {});
            return { modifiedCount: 1 };
        },
        find: () => ({ limit: () => ({ toArray: async () => [] }) }),
    },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), insertOne: async () => {} },
    settings_col: { findOne: async () => null },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    MAX_ATTACHMENT_BYTES: 1_000_000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

// ── اعتراض تنزيل المرفقات (بدون شبكة حقيقية) قبل تحميل managerDashboard ──
const utils = require('../utils');
const REAL_FETCH = utils.fetchTextAttachment;
let fakeFileContent = null;   // null = لا اعتراض
utils.fetchTextAttachment = async (url) => {
    if (fakeFileContent !== null) return fakeFileContent;
    return REAL_FETCH(url);
};

const secrets = require('../secrets');
const { ObjectId } = require('mongodb');
const dashboard = require('../managerDashboard');
const { handleDashboardInteraction, handleSecretUploadMessage, renderAgentSettings } = dashboard;
const providers = require('../providers');
const geminiInternals = require('../providers/gemini').__internals;

// ---------- أدوات المحاكاة (نفس نمط fixes.test.js) ----------
function makeInteraction({ customId, isModal = false, isSelect = false, guildId = '111111111111111111' } = {}) {
    const captured = { showModal: null, reply: null, update: null };
    return {
        customId, values: null,
        user: { id: '656783724662226963' },
        guildId, member: null, channel: null, channelId: '222222222222222222',
        isChatInputCommand: () => false,
        isStringSelectMenu: () => isSelect,
        isModalSubmit: () => isModal,
        isButton: () => !isModal && !isSelect,
        isChannelSelectMenu: () => false,
        isRoleSelectMenu: () => false,
        async showModal(modal) { captured.showModal = modal; return true; },
        async reply(payload) { captured.reply = payload; return true; },
        async update(payload) { captured.update = payload; return true; },
        async followUp(payload) { captured.followUps = captured.followUps || []; captured.followUps.push(payload); return true; },
        fields: null,
        __captured: captured,
    };
}

function makeMessage({ content = '', attachments = [] } = {}) {
    const replies = [];
    return {
        guild: { id: '111111111111111111' },
        author: { id: '656783724662226963', bot: false },
        content,
        attachments: new Map(attachments.map(a => [a.id, a])),
        async reply(payload) { replies.push(payload); return true; },
        __replies: replies,
    };
}

function toJson(v) {
    return JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x)));
}

function textOf(payload) {
    const j = toJson(payload);
    if (typeof j === 'string') return j; // ردود نصية مجردة
    const parts = [];
    if (j.content) parts.push(j.content);
    for (const e of j.embeds || []) {
        if (e.title) parts.push(e.title);
        for (const f of e.fields || []) parts.push(`${f.name} ${f.value}`);
        if (e.description) parts.push(e.description);
    }
    return parts.join('\n');
}

const fakeManager = {
    runtimes: new Map(),
    async createAgent(opts) { return { ...opts, _id: new ObjectId(FAKE_AGENT_ID) }; },
    async logAgent() {},
    async notify() {},
};
fakeManager.runtimes.set(FAKE_AGENT_ID, { runtimeSettings: { provider: 'gemini', providerConfig: {}, fallback_configs: {} } });

function findButton(page, suffix) {
    for (const row of page.components || []) {
        for (const b of row.components || []) {
            const cid = b.customId || b.data?.custom_id || (b.toJSON ? b.toJSON().custom_id : '');
            if (String(cid).endsWith(suffix)) return b;
        }
    }
    return null;
}

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    // ══════════════════════════════════════════════════════════
    // 1) كراش "crypto is not defined" — polyfill يحقن webcrypto عند غياب الغلوبال
    // ══════════════════════════════════════════════════════════
    {
        // عملية فرعية تحاكي Node < 19: نحذف الغلوبال إن كان قابلاً للحذف ثم نطلب polyfills
        const out = execSync(`node ${JSON.stringify(path.join(__dirname, '_polyfill_child.js'))}`, { cwd: path.join(__dirname, '..') }).toString().trim();
        assert.ok(out === 'OK' || out === 'SKIP', `عملية فرعية أنتجت: ${out}`);
        if (out === 'OK') {
            // نفس السطر الذي ينهار فيه درايفر mongodb 7.x (lib/utils.js randomBytes)
            ok('1) polyfills.js: عند غياب globalThis.crypto يُحقن webcrypto — سطر randomBytes في mongodb يعمل');
        } else {
            // في هذه البيئة الغلوبال غير قابل للحذف — نتأكد أن polyfill لا يفسد الموجود
            const before = globalThis.crypto;
            require('../polyfills');
            assert.strictEqual(globalThis.crypto, before, 'polyfill لا يستبدل webcrypto موجوداً');
            ok('1) polyfills.js: لا يمس globalThis.crypto الموجود (وُلّد SKIP في العملية الفرعية)');
        }
    }

    // ══════════════════════════════════════════════════════════
    // 2) كل حقول المزودين ضمن حدود ديسكورد — لا "Invalid string length" عند فتح أي نافذة
    // ══════════════════════════════════════════════════════════
    {
        const { TextInputBuilder, TextInputStyle } = require('discord.js');
        let checked = 0;
        for (const p of Object.values(providers.PROVIDERS)) {
            for (const f of p.modalFields) {
                assert.ok(f.label.length <= 45, `${p.id}.${f.id}: تسمية ${f.label.length} حرف > 45`);
                const b = new TextInputBuilder().setCustomId(f.id)
                    .setLabel(f.label)
                    .setStyle(f.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                    .setMaxLength(Math.min(f.maxLength || 300, 4000))
                    .toJSON();
                assert.ok(b, `${p.id}.${f.id} يُبنى بنجاح`);
                checked++;
            }
        }
        const g = providers.getProvider('gemini').modalFields[0];
        assert.strictEqual(g.maxLength, 4000, 'كوكيز Gemini تظل تسمح بـ 4000 داخل النافذة');
        assert.strictEqual(g.required, false, 'كوكيز Gemini اختيارية عند الإنشاء — القيم الأطول من 4000 طريقها الملف');
        ok(`2) ${checked} حقلاً عبر كل المزودين ضمن حدود ديسكورد (تسمية ≤ 45 وحد ≤ 4000)`);
    }

    // ══════════════════════════════════════════════════════════
    // 3) صفحة الإعدادات: زر «الكوكيز من ملف» يظهر لكل مزود له سر
    // ══════════════════════════════════════════════════════════
    {
        for (const pid of ['deepseek', 'qwen', 'openai', 'gemini']) {
            dbDoc.provider = pid;
            const page = await renderAgentSettings(FAKE_AGENT_ID, '111111111111111111');
            const btn = findButton(page, ':secret_file');
            assert.ok(btn, `زر الملف ظاهر لمزود ${pid}`);
        }
        dbDoc.provider = 'gemini';
        const page = await renderAgentSettings(FAKE_AGENT_ID, '111111111111111111');
        const gemBtn = findButton(page, ':secret_file');
        const label = gemBtn.data?.label || gemBtn.toJSON().label;
        assert.ok(label.includes('الكوكيز'), `تسمية الزر لكوكيز Gemini: «${label}»`);
        ok('3) صفحة الإعدادات: زر تجاوز الحد ظاهر لكل المزودين، وتسميته خاصة بالكوكيز لـ Gemini');
    }

    // ══════════════════════════════════════════════════════════
    // 4) الضغط على الزر يفتح نافذة انتظار تشرح الطريقتين
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:secret_file` });
        assert.strictEqual(await handleDashboardInteraction(i, fakeManager), true, 'الزر له معالج');
        const txt = textOf(i.__captured.update);
        assert.ok(txt.includes('4000'), 'النافذة تشرح أن 4000 حد ديسكورد المطلق');
        assert.ok(txt.includes('ملف') && txt.includes('لصق'), 'النافذة تعرض طريقتي الإرسال');
        const cancel = findButton(i.__captured.update, ':settings');
        assert.ok(cancel, 'زر إلغاء وعودة موجود');
        ok('4) زر «الكوكيز من ملف» يفتح نافذة انتظار 3 دقائق بتعليمات واضحة');
    }

    // ══════════════════════════════════════════════════════════
    // 5) مسار اللصق المباشر: تطبيع + تحقق + تشفير + تطبيق حي
    // ══════════════════════════════════════════════════════════
    {
        const PLAINTEXT = '__Secure-1PSID=paste1; SID=paste2';
        const raw = `Cookie:\n${PLAINTEXT.replace('; ', ';\n')}`; // مع كلمة Cookie: وأسطر جديدة كما تُنسخ من المتصفح
        const msg = makeMessage({ content: raw });
        const updatesBefore = updateCalls.length;
        assert.strictEqual(await handleSecretUploadMessage(msg, fakeManager), true, 'الرسالة استُهلكت كرفع سر');
        assert.strictEqual(updateCalls.length, updatesBefore + 1, 'تم الحفظ في قاعدة البيانات');
        const patch = updateCalls[updateCalls.length - 1];
        const stored = patch.$set.gemini_cookies;
        assert.ok(stored && stored !== PLAINTEXT, 'القيمة مخزنة مشفرة وليست نصاً صريحاً');
        assert.strictEqual(secrets.decryptSecret(stored), PLAINTEXT, 'فك التشفير يعيد الكوكيز نظيفة كاملة');
        // تطبيع فعلي: parseCookieString على النص الأصلي = نفس نتيجة المحفوظ
        assert.deepStrictEqual(
            geminiInternals.parseCookieString(secrets.decryptSecret(stored)),
            { '__Secure-1PSID': 'paste1', SID: 'paste2' },
            'الكوكيز المنظفة قابلة للتحليل بكامل مفاتيحها',
        );
        // تطبيق حي
        const rt = fakeManager.runtimes.get(FAKE_AGENT_ID);
        assert.strictEqual(rt.runtimeSettings.providerConfig.gemini_cookies, PLAINTEXT, 'الـ Runtime تلقى الكوكيز فوراً');
        assert.ok(rt.runtimeSettings.fallback_configs, 'fallback_configs حُدّث أيضاً');
        // نجاح للمرسل
        const replyTxt = textOf(msg.__replies[0]);
        assert.ok(replyTxt.includes('كامل') && replyTxt.includes('حرف'), 'رد النجاح يذكر الطول الكامل');
        assert.ok(replyTxt.includes(secrets.maskSecret(PLAINTEXT)), 'القيمة تظهر مقنعة فقط');
        ok('5) لصق مباشر: Cookie: والأسطر الجديدة تُنظف، تُشفّر، تُحفظ، وتُطبق حياً');
    }

    // ══════════════════════════════════════════════════════════
    // 6) كوكيز ناقصة الجوهرية تُرفض بالاسم ولا تُحفظ
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:secret_file` });
        await handleDashboardInteraction(i, fakeManager); // فتح نافذة جديدة
        const bad = '__Secure-3PSIDCC=AKEn; __Secure-3PAPISID=ppD; __Secure-3PSIDTS=x; __Secure-1PSIDTS=y';
        const msg = makeMessage({ content: bad });
        const updatesBefore = updateCalls.length;
        assert.strictEqual(await handleSecretUploadMessage(msg, fakeManager), true);
        assert.strictEqual(updateCalls.length, updatesBefore, 'لم يُحفظ شيء');
        const txt = textOf(msg.__replies[0]);
        assert.ok(txt.includes('__Secure-1PSID') || txt.includes('SID'), 'الرفض يسمي معرف الجلسة الناقص بالاسم');
        ok('6) كوكيز بلا معرف جلسة تُرفض برسالة تسمي الناقص — ولا يُسقط الحفظ قيمة صالحة');
    }

    // ══════════════════════════════════════════════════════════
    // 7) مسار الملف: مرفق نصي يُنزَّل ويُحفظ كاملاً (بلا حد 4000)
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:secret_file` });
        await handleDashboardInteraction(i, fakeManager);
        const COOKIE_FILE = `__Secure-1PSID=gaa.${'x'.repeat(4190)}; SID=file2`; // أطول من 4000 عمداً
        fakeFileContent = COOKIE_FILE;
        try {
            const msg = makeMessage({
                attachments: [{ id: 'a1', name: 'cookies.txt', size: COOKIE_FILE.length, contentType: 'text/plain', url: 'https://cdn.example/cookies.txt' }],
            });
            const updatesBefore = updateCalls.length;
            assert.strictEqual(await handleSecretUploadMessage(msg, fakeManager), true);
            assert.strictEqual(updateCalls.length, updatesBefore + 1, 'الحفظ تم');
            const stored = updateCalls[updateCalls.length - 1].$set.gemini_cookies;
            const plain = secrets.decryptSecret(stored);
            assert.strictEqual(plain, COOKIE_FILE.trim(), `الملف وصل كاملاً (${COOKIE_FILE.length} حرف > 4000) دون أي قصّ`);
            const rt = fakeManager.runtimes.get(FAKE_AGENT_ID);
            assert.strictEqual(rt.runtimeSettings.providerConfig.gemini_cookies, COOKIE_FILE.trim(), 'تطبيق حي من الملف');
            assert.ok(textOf(msg.__replies[0]).includes('cookies.txt'), 'رد النجاح يذكر اسم الملف');
        } finally {
            fakeFileContent = null;
        }
        ok('7) مسار الملف: قيمة > 4000 حرف تصل كاملة — هذا هو تجاوز الحد المطلوب');
    }

    // ══════════════════════════════════════════════════════════
    // 8) ملف غير نصي / ضخم يُرفض والنافذة تبقى مفتوحة
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:secret_file` });
        await handleDashboardInteraction(i, fakeManager);
        const img = makeMessage({ attachments: [{ id: 'a2', name: 'shot.png', size: 5000, contentType: 'image/png', url: 'https://cdn.example/shot.png' }] });
        const before = updateCalls.length;
        assert.strictEqual(await handleSecretUploadMessage(img, fakeManager), true);
        assert.ok(textOf(img.__replies[0]).includes('غير نصي'), 'رفض الملف غير النصي');
        assert.strictEqual(updateCalls.length, before, 'لا حفظ');

        const big = makeMessage({ attachments: [{ id: 'a3', name: 'big.txt', size: 5 * 1024 * 1024, contentType: 'text/plain', url: 'https://cdn.example/big.txt' }] });
        assert.strictEqual(await handleSecretUploadMessage(big, fakeManager), true);
        assert.ok(textOf(big.__replies[0]).includes('كبير'), 'رفض الملف الضخم');
        assert.strictEqual(updateCalls.length, before, 'لا حفظ');

        // رسالة فارغة تماماً أثناء فتح النافذة → تُتجاهل ولا تُغلق النافذة
        const empty = makeMessage({ content: '' });
        assert.strictEqual(await handleSecretUploadMessage(empty, fakeManager), false, 'رسالة بلا ملف ونص تُتجاهل');
        ok('8) ملفات غير نصية/ضخمة تُرفض، والرسائل الفارغة تُتجاهل دون إغلاق النافذة');
    }

    // ══════════════════════════════════════════════════════════
    // 9) نص غير كوكيز يُرفض دون إغلاق النافذة، وقيمة صالحة تغلقها،
    //    وبعد الإغلاق لا يُلتقط أي شيء
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:secret_file` });
        await handleDashboardInteraction(i, fakeManager);
        const junk = makeMessage({ content: 'hello عادي — رسالة عابرة' });
        assert.strictEqual(await handleSecretUploadMessage(junk, fakeManager), true, 'النص العابر يُستهلك (يرفض بالتحقق)');
        assert.ok(textOf(junk.__replies[0]).includes('غير مكتملة') || textOf(junk.__replies[0]).includes('جلسة'), 'الرفض يوضح السبب');
        // النافذة ما زالت مفتوحة بعد الرفض — قيمة صالحة تغلقها
        const good = makeMessage({ content: '__Secure-1PSID=consume1; SID=consume2;' });
        assert.strictEqual(await handleSecretUploadMessage(good, fakeManager), true, 'القيمة الصالحة أغلقت النافذة');
        // الآن لا نافذة معلقة — لا التقاط لرسائل لاحقة
        const msg2 = makeMessage({ content: '__Secure-1PSID=zz; SID=zz;' });
        assert.strictEqual(await handleSecretUploadMessage(msg2, fakeManager), false, 'بلا نافذة معلقة لا يُلتقط شيء');
        ok('9) الرفض لا يغلق النافذة، الصالح يغلقها، وبعدها لا التقاط عشوائي');
    }

    console.log(`\n🎉 upload_flow: ${passed} اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌', e); process.exit(1); });
