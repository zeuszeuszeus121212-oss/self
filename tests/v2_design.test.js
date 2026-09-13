/**
 * tests/v2_design.test.js — الجولة الثامنة (v7.5)
 * ═══════════════════════════════════════════════════════════
 * يحمي إصلاحات هذه الجولة:
 *  1) عقد listProviders الكامل — السبب الجذري لانهيار زر «المزود» وأمر /المزود
 *     (نسخة سابقة بترت الكائنات فأصبحت p.validate غير موجودة).
 *  2) زر «المزود» في لوحة الوكيل يعمل فعلياً (محاكاة ضغط حقيقية).
 *  3) إنشاء وكيل بمفتاح مزود فارغ (allowIncomplete) — لا «المفتاح مفقود»،
 *     بل إنشاء ناجح + تنبيه إكمال، والعلم يُمسح تلقائياً عند إكمال الحقول.
 *  4) كل الصفحات على Components V2: بلا embeds، بـ flags صحيح، وتسلسل
 *     toJSON سليم، ونص إجمالي ≤ 4000 (حد ديسكورد).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { ObjectId } = require('mongodb');

// ---------- حقن config وهمي في require cache (بدون MongoDB حقيقي) ----------
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const FAKE_AGENT_ID = '507f1f77bcf86cd799439011';
const OWNER_ID = '656783724662226963';

let currentFakeAgent = {
    _id: FAKE_AGENT_ID,
    name: 'وكيل الاختبار',
    provider: 'gemini',
    gemini_cookies: 'enc:v1:fake',
    discord_token: 'tok',
    status: 'stopped',
    token_type: 'bot',
};

const fakeConfig = {
    BOT_OWNER_ID: BigInt(OWNER_ID),
    MONGODB_URI: null,
    DISCORD_TOKEN: null,
    USER_TOKEN: null,
    DEEPSEEK_TOKEN: null,
    CONTROL_ROLE_NAME: '',
    RAILWAY_URL: '',
    POW_PROXY_TELEGRAM: '',
    DEFAULT_POW_PROVIDER: 'railway',
    MAX_CHANNELS_PER_GUILD: 5,
    MAX_ATTACHMENT_BYTES: 1000000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
    mongoClient: null,
    connectMongo: async () => {},
    channel_sessions: new Map(),
    allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() },
    agents_col: {
        findOne: async (q) => (q && q._id ? currentFakeAgent : currentFakeAgent),
        updateOne: async (q, u) => {
            if (u.$set && currentFakeAgent) Object.assign(currentFakeAgent, u.$set);
            return { modifiedCount: 1 };
        },
        insertOne: async (doc) => ({ insertedId: new ObjectId(FAKE_AGENT_ID) }),
        find: () => {
            const arr = [currentFakeAgent];
            const chain = {
                sort: () => chain,
                skip: () => chain,
                limit: () => chain,
                toArray: async () => arr,
            };
            return chain;
        },
        countDocuments: async () => 1,
    },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), insertOne: async () => {} },
    settings_col: { findOne: async () => null, updateOne: async () => ({}) },
    providers_col: null,
    knowledge_col: {
        find: () => ({ limit: () => ({ toArray: async () => [] }), toArray: async () => [] }),
        countDocuments: async () => 0,
        distinct: async () => [],
        aggregate: () => ({ toArray: async () => [] }),
    },
    usage_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    account_settings_col: { findOne: async () => null, updateOne: async () => ({}) },
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const providers = require('../providers');
const utils = require('../utils');
const dashboard = require('../managerDashboard');
const botModule = require('../bot');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

// ---------- أدوات مساعدة ----------
function makeInteraction({ customId, isButton = false, isSelect = false, isModal = false, values = [], fields = null } = {}) {
    const captured = {};
    return {
        isChatInputCommand: () => false,
        isButton: () => isButton,
        isStringSelectMenu: () => isSelect,
        isModalSubmit: () => isModal,
        isChannelSelectMenu: () => false,
        isRoleSelectMenu: () => false,
        customId,
        guildId: '111111111111111111',
        user: { id: OWNER_ID },
        member: { permissions: { has: () => true }, roles: { cache: new Map() } },
        values,
        fields,
        replied: false,
        deferred: false,
        async update(p) { captured.update = p; return p; },
        async reply(p) { captured.reply = p; return p; },
        async followUp(p) { captured.followUp = p; return p; },
        async showModal(m) { captured.modal = m; return m; },
        __captured: captured,
    };
}

/** فحص payload بمعايير Components V2 الصارمة */
function assertV2Payload(payload, label) {
    assert.ok(payload && typeof payload === 'object', `${label}: payload موجود`);
    assert.strictEqual(payload.flags, 32768, `${label}: flags = IsComponentsV2 (32768)`);
    assert.ok(!('embeds' in payload), `${label}: لا مفتاح embeds إطلاقاً`);
    assert.ok(!('content' in payload), `${label}: لا مفتاح content مع V2`);
    assert.ok(Array.isArray(payload.components) && payload.components.length >= 1, `${label}: مكوّنات موجودة`);
    // تسلسل toJSON كامل + حساب النص الإجمالي (حد ديسكورد 4000)
    const json = JSON.parse(JSON.stringify(payload, (k, v) => (v && typeof v.toJSON === 'function' ? v.toJSON() : v)));
    let textTotal = 0;
    let count = 0;
    (function walk(comp) {
        if (!comp || typeof comp !== 'object') return;
        count++;
        if (comp.content && typeof comp.content === 'string') textTotal += comp.content.length;
        assert.ok(count <= 40, `${label}: عدد المكوّنات ≤ 40 (حد ديسكورد)`);
        for (const child of comp.components || []) walk(child);
    })(json);
    assert.ok(textTotal <= 4000, `${label}: النص الإجمالي ${textTotal} ≤ 4000`);
    return json;
}

const fakeManager = {
    runtimes: new Map(),
    async createAgent(opts) {
        // يحاكي bot.js createAgent الحقيقي بما فيه منطق allowIncomplete
        const p = providers.getProviderOrFallback(opts.provider);
        const v = p.validate(opts.providerConfig || {});
        const doc = {
            ...opts,
            config_incomplete: !v.ok,
            missing_provider_fields: v.ok ? [] : v.missing,
            _id: new ObjectId(FAKE_AGENT_ID),
        };
        return doc;
    },
    async logAgent() {},
    async notify() {},
    restartAgent: async () => ({}),
};

async function run() {
    // ══════════════════════════════════════════════════════════
    // 1) عقد listProviders الكامل — لم يعد يبتُر الكائنات (سبب كارثة زر المزود)
    // ══════════════════════════════════════════════════════════
    {
        const list = providers.listProviders();
        assert.strictEqual(list.length, Object.keys(providers.PROVIDERS).length, 'كل المزودين مسجلين');
        for (const p of list) {
            assert.strictEqual(typeof p.validate, 'function', `${p.id}.validate دالة — كان الغياب ينهار الزر`);
            assert.strictEqual(typeof p.describe, 'function', `${p.id}.describe دالة`);
            assert.strictEqual(typeof p.chat, 'function', `${p.id}.chat دالة`);
            assert.ok(Array.isArray(p.modalFields), `${p.id}.modalFields مصفوفة`);
            assert.strictEqual(typeof p.testConnection, 'function', `${p.id}.testConnection دالة`);
            assert.ok(utils.MENU_SAFE_EMOJIS.has(p.emoji), `${p.id}: إيموجي آمن للقوائم`);
        }
        // listProviderOptions — النسخة المبتورة الآمنة للقوائم فقط
        for (const o of providers.listProviderOptions()) {
            assert.deepStrictEqual(Object.keys(o).sort(), ['description', 'emoji', 'id', 'label'], 'options: حقول محددة فقط');
        }
        ok('1) عقد listProviders كامل (validate/describe/chat/modalFields) + إيموجي آمن — لا انهيار زر المزود مجدداً');
    }

    // ══════════════════════════════════════════════════════════
    // 2) زر «المزود» في لوحة الوكيل — ضغط حقيقي يعمل لكل المزودين (V2)
    // ══════════════════════════════════════════════════════════
    {
        for (const pid of ['gemini', 'openai', 'qwen', 'deepseek']) {
            currentFakeAgent = { ...currentFakeAgent, provider: pid, gemini_cookies: pid === 'gemini' ? 'enc:v1:fake' : undefined };
            const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:aiprovider`, isButton: true });
            const handled = await dashboard.handleDashboardInteraction(i, fakeManager);
            assert.ok(handled, `${pid}: تفاعل معالج`);
            const page = i.__captured.update;
            assert.ok(page, `${pid}: صفحة المزود رُسمت`);
            const json = assertV2Payload(page, `صفحة المزود (${pid})`);
            // قائمة تبديل المزود موجودة وفيها كل المزودين
            let found = null;
            (function walk(c) {
                if (!c || typeof c !== 'object' || found) return;
                if (c.custom_id === `dash:agent:${FAKE_AGENT_ID}:aiprovider_set`) { found = c; return; }
                for (const ch of c.components || []) walk(ch);
            })(json);
            assert.ok(found, `${pid}: قائمة تبديل المزود موجودة`);
            assert.strictEqual(found.options.length, 4, `${pid}: أربعة مزودين في القائمة`);
        }
        currentFakeAgent = { ...currentFakeAgent, provider: 'gemini', gemini_cookies: 'enc:v1:fake' };
        ok('2) زر «المزود» يعمل لكل المزودين الأربعة — القائمة كاملة وكلها Components V2');
    }

    // ══════════════════════════════════════════════════════════
    // 3) إنشاء وكيل بمفتاح فارغ — allowIncomplete يمنع «المفتاح مفقود»
    // ══════════════════════════════════════════════════════════
    {
        // أ) bot.js createAgent الحقيقي: ناقص + allowIncomplete → نجاح بعلم
        const doc = await botModule.createAgent({
            name: 'ناقص', discord_token: 'tok', provider: 'gemini',
            providerConfig: {}, allowIncomplete: true,
        });
        assert.strictEqual(doc.config_incomplete, true, 'العلم config_incomplete=true');
        assert.deepStrictEqual(doc.missing_provider_fields, ['gemini_cookies'], 'الحقول الناقصة مسماة');

        // ب) نفس الاستدعاء بلا allowIncomplete → يرمي (السلوك الصارم محفوظ للمستدعين الآخرين)
        let threw = false;
        try {
            await botModule.createAgent({ name: 'صارم', discord_token: 'tok', provider: 'gemini', providerConfig: {} });
        } catch (e) { threw = true; }
        assert.ok(threw, 'بلا allowIncomplete يبقى الرمي (توافق قديم)');

        // ج) مكتمل → علم false وقائمة فارغة
        const doc2 = await botModule.createAgent({
            name: 'مكتمل', discord_token: 'tok', provider: 'gemini',
            providerConfig: { gemini_cookies: '__Secure-1PSID=x; SID=y' }, allowIncomplete: true,
        });
        assert.strictEqual(doc2.config_incomplete, false, 'مكتمل: بلا علم ناقص');

        // د) مفتاح OpenAI اختياري في النافذة — القيمة الطويلة طريقها الملف لاحقاً
        const keyField = providers.getProvider('openai').modalFields.find(f => f.id === 'openai_api_key');
        assert.strictEqual(keyField.required, false, 'openai_api_key اختياري عند الإنشاء');
        ok('3) createAgent allowIncomplete: إنشاء ناجح بعلم واضح + الرمي الصارم محفوظ + مفتاح OpenAI اختياري');
    }

    // ══════════════════════════════════════════════════════════
    // 4) إرسال نموذج إنشاء Gemini بكوكيز فارغة → تنبيه إكمال + صفحة وكيل (V2)
    // ══════════════════════════════════════════════════════════
    {
        const fields = {
            getTextInputValue(id) {
                if (id === 'name') return 'وكيل من ملف';
                if (id === 'discord_token') return 'tok';
                if (id === 'gemini_cookies') return ''; // ← فارغ عن قصد (ملف لاحقاً)
                if (id === 'personality') return '';
                throw new Error('حقل غير موجود: ' + id);
            },
        };
        const i = makeInteraction({ customId: `dash:create_modal:bot:gemini`, isModal: true, fields });
        const handled = await dashboard.handleDashboardInteraction(i, fakeManager);
        assert.strictEqual(handled, true, 'التفاعل معالج');
        const reply = i.__captured.reply;
        assert.ok(reply, 'رد نجاح بدون أي رمي — «المفتاح مفقود» انتهى');
        const json = assertV2Payload(reply, 'رد الإنشاء الناقص');
        // حاويتان: تنبيه + صفحة الوكيل
        assert.ok(json.components.length >= 2, 'تنبيه الإكمال فوق صفحة الوكيل');
        const text = JSON.stringify(json);
        assert.ok(text.includes('بيانات المزود ناقصة') || text.includes('أكمل بيانات'), 'نص التنبيه يوضح الناقص وطريقة الإكمال');
        ok('4) إنشاء Gemini بكوكيز فارغة: نجاح + تنبيه إكمال واضح — لا «المفتاح مفقود»');
    }

    // ══════════════════════════════════════════════════════════
    // 5) كل الصفحات الرئيسية Components V2 — بلا embeds ونص ≤ 4000
    // ══════════════════════════════════════════════════════════
    {
        const pages = {
            'الرئيسية': await dashboard.renderHome(fakeManager, makeInteraction({})),
            'الوكلاء': await dashboard.renderAgents(fakeManager, 0),
            'صفحة الوكيل': await dashboard.renderAgent(fakeManager, FAKE_AGENT_ID),
            'المزود': await dashboard.renderAgentAIProvider(FAKE_AGENT_ID, '111111111111111111'),
            'الإعدادات': await dashboard.renderAgentSettings(FAKE_AGENT_ID, '111111111111111111'),
            'المعرفة': await dashboard.renderAgentKnowledge(FAKE_AGENT_ID, '111111111111111111'),
            'الاستباقية': await dashboard.renderAgentProactive(FAKE_AGENT_ID, '111111111111111111'),
            'المزودون المحفوظون': await dashboard.renderProviders(),
        };
        for (const [name, page] of Object.entries(pages)) {
            assertV2Payload(page, `صفحة ${name}`);
        }
        ok(`5) ${Object.keys(pages).length} صفحات رئيسية كلها Components V2 سليمة (flags/بدون embeds/نص ≤ 4000)`);
    }

    // ══════════════════════════════════════════════════════════
    // 6) رسالة خطأ عامة (الغطاء الأعلى في bot.js) V2 وليست إيمبد
    // ══════════════════════════════════════════════════════════
    {
        // محاكاة: معالج interaction يرمي → الرد بحاوية حمراء V2
        const embed = dashboard.embed;
        const errContainer = embed('خطأ في Dashboard', 'رسالة تجريبية', dashboard.COLORS.danger);
        const { v2Payload } = require('../ui');
        const payload = v2Payload(errContainer);
        const json = assertV2Payload(payload, 'رسالة الخطأ');
        assert.strictEqual(json.components[0].accent_color, dashboard.COLORS.danger, 'الشريط الأحمر للخطأ');
        ok('6) غطاء الأخطاء في bot.js يبني حاوية V2 حمراء — رسائل الخطأ لم تعد إيمبدات');
    }

    console.log('\n════════════════════════════════');
    console.log(`v2_design: ${passed}/6 ناجحة`);
    if (passed !== 6) process.exit(1);
}

run().catch((e) => { console.error('💥', e); process.exit(1); });
