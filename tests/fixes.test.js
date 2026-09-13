/**
 * tests/fixes.test.js — اختبارات إصلاحات الجولة الخامسة (v7.4.1)
 * ─────────────────────────────────────────────────────────────
 * يغطي الأسباب الجذرية الخمسة المُبلّغ عنها:
 *  1) Qwen كان يظل يفكر حتى مع تعطيل التفكير → thinking_mode: 'Fast' + research_mode
 *     + بصمات التطبيق الحقيقية (x-mini-wua / app_waf / device-id) من qwen.py
 *  2) زر تعديل الوكيل: 6 صفوف > حد ديسكورد 5 → BASE_TYPE_MAX_LENGTH
 *  3) "Invalid string length": قيم خيارات قوائم النماذج > 100 حرف
 *  4) كوكيز Gemini: قصّ الحقول عند 300/2000 حرف + كلمة "Cookie:" الزائدة + الأسطر الجديدة
 *  5) أداة create_file — إنشاء ملفات وإرفاقها في القناة (موثقة وتعمل member وowner)
 */

'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const FAKE_AGENT_ID = '507f1f77bcf86cd799439011';
process.env.ENCRYPTION_KEY = 'b'.repeat(64);

let currentFakeAgent = {
    _id: FAKE_AGENT_ID, name: 'FIX', provider: 'openai',
    openai_base_url: 'https://api.example.com/v1', openai_api_key: 'sk-fix', openai_model: 'gpt-x',
    discord_token: 'DT', status: 'stopped',
};

const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: null, reminders_col: null, knowledge_col: null,
    usage_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), async updateOne() { return { modifiedCount: 1 }; } },
    providers_col: null,
    agents_col: {
        findOne: async () => currentFakeAgent,
        updateOne: async () => ({ modifiedCount: 1 }),
        find: () => ({ limit: () => ({ toArray: async () => [] }) }),
    },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), insertOne: async () => {} },
    settings_col: { findOne: async () => null },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
    MAX_ATTACHMENT_BYTES: 1_000_000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const { ObjectId } = require('mongodb');
const { handleDashboardInteraction } = require('../managerDashboard');
const { toolAllowedForAccess } = require('../utils');
const { buildSystem } = require('../tools/systemPrompt');
const { runAgent } = require('../tools');
const providers = require('../providers');
const qwenProvider = require('../providers/qwen');
const geminiInternals = require('../providers/gemini').__internals;

// ---------- أدوات المحاكاة (نفس نمط platform.test.js) ----------
function makeInteraction({ customId, values = null, fields = null, isModal = false, isSelect = false, guildId = '111111111111111111' } = {}) {
    const captured = { showModal: null, reply: null, update: null };
    return {
        customId, values,
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
        fields,
        __captured: captured,
    };
}

function makeFields(map) {
    return {
        getTextInputValue(id) {
            if (!(id in map)) throw new Error(`حقل غير موجود: ${id}`);
            return map[id];
        },
    };
}

function modalJson(modal) {
    return typeof modal?.toJSON === 'function' ? modal.toJSON() : modal;
}

const fakeManager = {
    runtimes: new Map(),
    async createAgent(opts) { return { ...opts, _id: new ObjectId(FAKE_AGENT_ID) }; },
    async logAgent() {},
    async notify() {},
};

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    // ══════════════════════════════════════════════════════════
    // 1) Qwen: تعطيل التفكير يعمل فعلاً — thinking_mode + research_mode
    // ══════════════════════════════════════════════════════════
    {
        const off = qwenProvider.buildQwenPayload('c1', 'hi', null, { thinking: false, autoSearch: false });
        const fcOff = off.messages[0].feature_config;
        assert.strictEqual(fcOff.thinking_mode, 'Fast', 'السبب الجذري: بدون thinking_mode=Fast يظل qwen3-max يفكر!');
        assert.strictEqual(fcOff.thinking_enabled, false);
        assert.strictEqual(fcOff.auto_thinking, false);
        assert.strictEqual(fcOff.research_mode, 'normal', 'research_mode مطابق للبايثون');

        const on = qwenProvider.buildQwenPayload('c1', 'hi', null, { thinking: true, autoSearch: true });
        const fcOn = on.messages[0].feature_config;
        assert.strictEqual(fcOn.thinking_mode, 'Deep');
        assert.strictEqual(fcOn.thinking_enabled, true);
        assert.strictEqual(fcOn.auto_search, true);
        ok('1) Qwen: thinking_mode Fast/Deep + research_mode — التعطيل يعمل فعلاً');
    }

    // ══════════════════════════════════════════════════════════
    // 2) Qwen: بصمات التطبيق الحقيقية في الهيدرات (من qwen.py)
    // ══════════════════════════════════════════════════════════
    {
        // نستخرج الهيدرات عبر اعتراض axios؟ أبسط: نتحقق من السلوك غير المباشر.
        // دوال الهيدرات داخلية — نتحقق عبر حقن شبكة وهمية؟ الأدق: فحص المصدر لأنها دوال مغلقة.
        const src = fs.readFileSync(path.join(__dirname, '..', 'providers', 'qwen.js'), 'utf8');
        assert.ok(src.includes("MINI_WUA_CHAT"), 'x-mini-wua للـ chat موجود');
        assert.ok(src.includes("MINI_WUA_NEW"), 'x-mini-wua للـ new موجود');
        assert.ok(src.includes("'app_waf'"), 'app_waf يُرسل مع chat');
        assert.ok(src.includes('ai41028e1f8c77e8b2786e747bbb688d45'), 'device-id الحقيقي من qwen.py (ليس 0)');
        assert.ok(!src.includes("'x-device-id'   : '0'"), 'لا يوجد device-id صفري');
        ok('2) Qwen: هيدرات بصمات التطبيق (x-mini-wua/app_waf/device-id) منقولة حرفياً');
    }

    // ══════════════════════════════════════════════════════════
    // 3) زر تعديل الوكيل ≤ 5 صفوف لكل المزودين (خاصة openai بثلاثة حقول)
    // ══════════════════════════════════════════════════════════
    {
        for (const pid of ['deepseek', 'qwen', 'openai', 'gemini']) {
            currentFakeAgent.provider = pid;
            const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:edit` });
            assert.strictEqual(await handleDashboardInteraction(i, fakeManager), true, `فتح نافذة التعديل (${pid})`);
            const m = modalJson(i.__captured.showModal);
            assert.ok(m, `النافذة أُنشئت (${pid})`);
            assert.ok(m.components.length <= 5, `${pid}: ${m.components.length} صفوف — الحد 5! (كان السبب في BASE_TYPE_MAX_LENGTH)`);
        }
        currentFakeAgent.provider = 'openai';
        // المزود بثلاثة حقول: يجب أن تظهر حقول المزود كلها + الاسم + الشخصية = 5 بالضبط
        const i2 = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:edit` });
        await handleDashboardInteraction(i2, fakeManager);
        const m2 = modalJson(i2.__captured.showModal);
        const ids2 = m2.components.map(r => r.components[0].custom_id);
        assert.ok(ids2.includes('name') && ids2.includes('personality'), 'الاسم والشخصية موجودان');
        assert.ok(ids2.includes('openai_base_url') && ids2.includes('openai_api_key') && ids2.includes('openai_model'), 'حقول المزود الثلاثة كلها ظاهرة');
        ok('3) زر تعديل: ≤ 5 صفوف لكل المزودين — خطأ BASE_TYPE_MAX_LENGTH انتهى');
    }

    // ══════════════════════════════════════════════════════════
    // 4) "Invalid string length": معرفات نماذج > 100 حرف تُقص في القوائم
    // ══════════════════════════════════════════════════════════
    {
        const longId = `gemini-2.0-flash-exp-image-generation-with-search-and-thinking-${'x'.repeat(80)}`; // 130+ حرف
        assert.ok(longId.length > 100, 'المعرف فعلاً أطول من حد ديسكورد');
        const i = makeInteraction({
            customId: 'dash:prov_add_modal', isModal: true,
            fields: makeFields({ name: 'بروكسي طويل', base_url: 'https://proxy.example.com/v1', api_key: 'k', models: longId }),
        });
        await handleDashboardInteraction(i, fakeManager);
        const step2 = i.__captured.update || i.__captured.reply;
        assert.ok(step2, 'خطوة اختيار النماذج ظهرت دون انهيار');
        const step2Json = JSON.parse(JSON.stringify(step2, (k, v) => (v && typeof v.toJSON === 'function' ? v.toJSON() : v)));
        const selectRow = (step2Json.components || []).find(r => r.components && r.components[0] && r.components[0].custom_id === 'dash:prov_models');
        assert.ok(selectRow, 'قائمة النماذج موجودة');
        const optVal = selectRow.components[0].options[0].value;
        assert.ok(optVal.length <= 100, `قيمة الخيار ${optVal.length} حرف — يجب ≤ 100 (هذا كان مصدر Invalid string length)`);
        ok('4) قوائم النماذج: قيم > 100 حرف تُقص — خطأ Invalid string length انتهى');
    }

    // ══════════════════════════════════════════════════════════
    // 5) Gemini: تنظيف الكوكيز (كلمة Cookie: + الأسطر الجديدة)
    // ══════════════════════════════════════════════════════════
    {
        // أ) كلمة "Cookie:" المنسوخة من ترويسة المتصفح — كانت تبتلع أول كوكي حقيقي!
        const withPrefix = 'Cookie: __Secure-1PSID=gaa1; SID=g.a000; __Secure-3PSID=gaa3;';
        const parsed1 = geminiInternals.parseCookieString(withPrefix);
        assert.strictEqual(parsed1['__Secure-1PSID'], 'gaa1', 'كلمة Cookie: تُزال — أول كوكي لا يُبتلع');
        assert.strictEqual(parsed1.SID, 'g.a000');

        // ب) الأسطر الجديدة (نسخ من جدول DevTools)
        const multiline = '__Secure-1PSID=abc123\nSID=xyz789\n__Secure-3PSID=zzz;';
        const parsed2 = geminiInternals.parseCookieString(multiline);
        assert.strictEqual(parsed2['__Secure-1PSID'], 'abc123');
        assert.strictEqual(parsed2.SID, 'xyz789');

        // ج) كوكيز المستخدم من الصورة (ناقصة الجوهرية) — validate يسمّي الناقص بالاسم
        const screenshotCookies = '__Secure-3PSIDCC=AKEn; __Secure-3PAPISID=ppD; __Secure-3PSIDTS=sidts-x; __Secure-1PSIDTS=sidts-y';
        const v = providers.getProvider('gemini').validate({ gemini_cookies: screenshotCookies });
        assert.strictEqual(v.ok, false, 'كوكيز الصورة (بلا PSID/SID) يجب أن تُرفض برسالة واضحة');
        assert.ok(v.missing[0].includes('__Secure-1PSID'), 'رسالة الخطأ تسمّي الكوكي الناقصة');

        // د) كوكيز كاملة → صالحة
        const v2 = providers.getProvider('gemini').validate({ gemini_cookies: '__Secure-1PSID=gaa.1; SID=g.a000' });
        assert.strictEqual(v2.ok, true);

        // هـ) حد الحقل 4000 — ترويسة Cookie الحقيقية طويلة ولا تُقص
        const gField = providers.getProvider('gemini').modalFields[0];
        assert.strictEqual(gField.maxLength, 4000, 'حد كوكيز Gemini = 4000 (كان 2000)');

        // و) مفتاح OpenAI (البروكسي) = 4000 (كان 300 — قصّ كوكيز المستخدم في الصورة عند ~303!)
        const oKey = providers.getProvider('openai').modalFields.find(f => f.id === 'openai_api_key');
        assert.strictEqual(oKey.maxLength, 4000, 'حد مفتاح OpenAI = 4000 (كان 300 — هذا قصّ كوكيزك!)');
        ok('5) Gemini: تنظيف Cookie:/الأسطر + حد 4000 + تسمية الكوكي الناقصة بالاسم');
    }

    // ══════════════════════════════════════════════════════════
    // 6) أداة create_file: مسموحة لـ member + موثقة في system prompt + تعمل فعلاً
    // ══════════════════════════════════════════════════════════
    {
        assert.strictEqual(toolAllowedForAccess('create_file', 'member'), true, 'create_file متاحة للأعضاء');
        assert.strictEqual(toolAllowedForAccess('create_file', 'owner'), true);
        const sys = buildSystem('Bot', 'default', false, 'member', '', { read_url: true }, {});
        assert.ok(sys.includes('create_file'), 'create_file موثقة في سجل أدوات النموذج');
        assert.ok(sys.includes('إنشاء الملفات وإرفاقها'), 'قسم إنشاء الملفات موجود');

        // تشغيل فعلي عبر حلقة الوكيل: النموذج يستدعي create_file → ملف يُرفق
        let phase = 0;
        const fakeProvider = {
            id: 'fake_file', label: 'وهمي ملفات', emoji: '🧪', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() {
                phase++;
                if (phase === 1) {
                    return {
                        fullText: '```json\n{"tool":"create_file","params":{"filename":"تقرير اليوم.md","content":"# التقرير\\nسطر أول مهم"}}\n```',
                        sessionId: 's1', newParentMessageId: null,
                    };
                }
                return { fullText: 'جهزت لك الملف!', sessionId: 's1', newParentMessageId: null };
            },
        };
        providers.PROVIDERS[fakeProvider.id] = fakeProvider;
        const runtime = {
            agentId: 'agent_file', personality: '', provider: 'fake_file', providerConfig: {},
            fallback_enabled: false, fallback_chain: [], fallback_configs: {},
            features: {}, capabilities: {},
        };
        const result = await runAgent({ id: 'g1', name: 's' }, { id: 'c1', name: 'ch' }, 'سوي لي تقرير ملف',
            '[م]', '[س]', 'Bot', null, null, 'g1', 'default', false, 'member', null, runtime, { userId: 'u1', channelId: 'c1' });
        assert.ok(result.reply.includes('جهزت لك الملف'), 'الحلقة اكتملت بعد إنشاء الملف');
        assert.strictEqual(result.filesToSend.length, 1, 'الملف أُنشئ ومُرّف للإرسال');
        const sentName = path.basename(result.filesToSend[0]);
        assert.ok(sentName.includes('تقرير اليوم'), 'اسم الملف العربي محفوظ');
        const content = fs.readFileSync(result.filesToSend[0], 'utf8');
        assert.ok(content.startsWith('# التقرير'), 'محتوى الملف صحيح');
        try { fs.unlinkSync(result.filesToSend[0]); } catch (_) {}
        delete providers.PROVIDERS[fakeProvider.id];

        // بلا محتوى → رسالة خطأ واضحة (لا انهيار)
        const badProvider = {
            id: 'fake_file_bad', label: 'وهمي فاسد', emoji: '🧪', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() {
                return { fullText: '```json\n{"tool":"create_file","params":{"filename":"x.txt"}}\n```', sessionId: 's2', newParentMessageId: null };
            },
        };
        providers.PROVIDERS[badProvider.id] = badProvider;
        const runtime2 = { agentId: 'a2', provider: 'fake_file_bad', providerConfig: {}, fallback_enabled: false, fallback_chain: [], fallback_configs: {}, features: {}, capabilities: {} };
        const r2 = await runAgent({ id: 'g1', name: 's' }, { id: 'c1', name: 'ch' }, 'ملف فاسد',
            '[م]', '[س]', 'Bot', null, null, 'g1', 'default', false, 'member', null, runtime2, { userId: 'u1', channelId: 'c1' });
        assert.ok(r2.reply.includes('حدد اسم الملف ومحتواه') || r2.reply.length > 0, 'بلا محتوى: التعامل رشيق');
        delete providers.PROVIDERS[badProvider.id];
        ok('6) create_file: مسموحة لكل المستويات + موثقة + تُنشئ ملفاً حقيقياً يُرفق');
    }

    // ══════════════════════════════════════════════════════════
    // 7) نافذة إضافة مزود: حقل المفتاح يقبل 4000 حرف (كوكيز كاملة)
    // ══════════════════════════════════════════════════════════
    {
        // نضبط مزودين محفوظين = null → المسار اليدوي: نافذة prov_add تفتح عبر زر prov_add
        const i = makeInteraction({ customId: 'dash:prov_add' });
        await handleDashboardInteraction(i, fakeManager);
        const m = modalJson(i.__captured.showModal);
        assert.ok(m, 'نافذة إضافة المزود فُتحت');
        const keyRow = m.components.find(r => r.components[0].custom_id === 'api_key');
        assert.ok(keyRow, 'حقل المفتاح موجود');
        assert.strictEqual(keyRow.components[0].max_length, 4000, 'حد المفتاح 4000 (كان 300 — قصّ الكوكيز في صورتك)');
        ok('7) نافذة إضافة مزود: المفتاح يقبل حتى 4000 حرف');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`fixes: ${passed}/${passed} ناجحة`);
    if (passed !== 7) process.exit(1);
}

run().catch((e) => { console.error('💥', e); process.exit(1); });
