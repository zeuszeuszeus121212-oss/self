/**
 * tests/e2e_create_flow.js — اختبار E2E حقيقي لتدفق إنشاء الوكيل متعدد المزودين
 * ═══════════════════════════════════════════════════════════════════════════════
 * يحاكي حرفياً ما يفعله المستخدم في ديسكورد:
 *   الخطوة 1: dash:create_type        → اختيار نوع الوكيل
 *   الخطوة 2: dash:create_provider:bot → اختيار المزود (qwen / openai / deepseek)
 *   الخطوة 3: dash:create_modal:<type>:<provider> → إرسال النموذج
 *
 * الهدف: إثبات أن اختيار Qwen يفتح نموذج Qwen ويُنشئ وكيل Qwen (وليس DeepSeek).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- 1) حقن config.js وهمي في require cache (بدون MongoDB حقيقي) ----------
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const FAKE_AGENT_ID = '507f1f77bcf86cd799439011';
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n,
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
    TEXT_EXTENSIONS: new Set(),
    TEXT_CONTENT_TYPES: new Set(),
    mongoClient: null,
    connectMongo: async () => {},
    channel_sessions: new Map(),
    allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() },
    agents_col: {
        findOne: async () => ({
            _id: FAKE_AGENT_ID,
            name: 'TEST',
            provider: 'qwen',
            qwen_token: 'tok',
            status: 'stopped',
        }),
    },
    logs_col: {
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    },
    settings_col: { findOne: async () => null },
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const { ObjectId } = require('mongodb');
const { handleDashboardInteraction } = require('../managerDashboard');

// ---------- 2) أدوات المحاكاة ----------
function makeInteraction({ customId, values = null, fields = null, isModal = false, isSelect = false }) {
    const captured = { showModal: null, reply: null, update: null };
    return {
        customId,
        values,
        user: { id: '656783724662226963' },
        guildId: null,
        member: null,
        channel: null,
        isChatInputCommand: () => false,
        isStringSelectMenu: () => isSelect,
        isModalSubmit: () => isModal,
        isButton: () => false,
        isChannelSelectMenu: () => false,
        isRoleSelectMenu: () => false,
        async showModal(modal) { captured.showModal = modal; },
        async reply(payload) { captured.reply = payload; },
        async update(payload) { captured.update = payload; },
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

// كل مكونات discord.js builders — نحوّلها إلى JSON ثم نستخرج المعرفات
function collectComponentIds(payload) {
    const ids = [];
    const data = typeof payload?.toJSON === 'function' ? payload.toJSON() : (payload || {});
    if (data.custom_id) ids.push('__modalId__:' + data.custom_id);
    if (data.title) ids.push('__title__:' + data.title);
    for (const row of data.components || []) {
        for (const comp of row.components || []) {
            if (comp.custom_id) ids.push(comp.custom_id);
        }
    }
    return ids;
}

// Manager وهمي — يسجل createAgent ولا يلمس قاعدة بيانات
const capturedCreates = [];
const fakeManager = {
    runtimes: new Map(),
    async createAgent(opts) {
        capturedCreates.push(opts);
        return { ...opts, _id: new ObjectId(FAKE_AGENT_ID) };
    },
    async logAgent() {},
    async notify() {},
};

let passed = 0;
async function run() {
    // ══════════════════════════════════════════════════════════
    // اختبار 1: اختيار Qwen يجب أن يفتح نموذج Qwen (الخطأ الأصلي)
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: 'dash:create_provider:bot', values: ['qwen'], isSelect: true });
        const handled = await handleDashboardInteraction(i, fakeManager);
        const modal = i.__captured.showModal;
        assert.strictEqual(handled, true, 'التفاعل يجب أن يُعالج');
        assert.ok(modal, 'يجب أن تُفتح نافذة (showModal) بعد اختيار المزود');
        const ids = collectComponentIds(modal);
        assert.ok(ids.some(s => s === '__modalId__:dash:create_modal:bot:qwen'),
            `معرف النافذة يجب أن يكون dash:create_modal:bot:qwen — وجدنا: ${ids}`);
        assert.ok(ids.includes('qwen_token'), 'نموذج Qwen يجب أن يحتوي حقل qwen_token');
        assert.ok(!ids.includes('deepseek_token'), 'نموذج Qwen يجب ألا يحتوي حقل deepseek_token');
        assert.ok(ids.some(s => s.startsWith('__title__') && s.includes('Qwen')), `العنوان يجب أن يذكر Qwen: ${ids}`);
        passed++; console.log('✅ 1) اختيار Qwen → نموذج Qwen (modalId + حقول + عنوان)');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 2: اختيار OpenAI يجب أن يفتح نموذج OpenAI
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: 'dash:create_provider:bot', values: ['openai'], isSelect: true });
        await handleDashboardInteraction(i, fakeManager);
        const modal = i.__captured.showModal;
        assert.ok(modal, 'يجب أن تُفتح نافذة OpenAI');
        const ids = collectComponentIds(modal);
        assert.ok(ids.some(s => s === '__modalId__:dash:create_modal:bot:openai'), `معرف نافذة OpenAI خاطئ: ${ids}`);
        assert.ok(ids.includes('openai_base_url'), 'نموذج OpenAI يجب أن يحتوي openai_base_url');
        assert.ok(ids.includes('openai_api_key'), 'نموذج OpenAI يجب أن يحتوي openai_api_key');
        assert.ok(!ids.includes('deepseek_token'), 'نموذج OpenAI يجب ألا يحتوي deepseek_token');
        passed++; console.log('✅ 2) اختيار OpenAI → نموذج OpenAI (حقول مختلفة تماماً)');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 3: DeepSeek يبقى كما هو (regression)
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: 'dash:create_provider:bot', values: ['deepseek'], isSelect: true });
        await handleDashboardInteraction(i, fakeManager);
        const modal = i.__captured.showModal;
        assert.ok(modal, 'يجب أن تُفتح نافذة DeepSeek');
        const ids = collectComponentIds(modal);
        assert.ok(ids.some(s => s === '__modalId__:dash:create_modal:bot:deepseek'), `معرف نافذة DeepSeek خاطئ: ${ids}`);
        assert.ok(ids.includes('deepseek_token'), 'نموذج DeepSeek يجب أن يحتوي deepseek_token');
        assert.ok(!ids.includes('qwen_token'), 'نموذج DeepSeek يجب ألا يحتوي qwen_token');
        passed++; console.log('✅ 3) اختيار DeepSeek → نموذج DeepSeek كما هو (بدون تغيير)');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 4: إرسال نموذج Qwen → إنشاء وكيل provider=qwen (وليس deepseek)
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({
            customId: 'dash:create_modal:bot:qwen',
            isModal: true,
            fields: makeFields({
                name: 'وكيل قwen',
                discord_token: 'DISCORD_TOKEN_XYZ',
                qwen_token: 'QWEN_BEARER_TOKEN',
                qwen_model: 'qwen3.8-max',
                personality: 'مساعد عربي',
            }),
        });
        let renderThrew = null;
        try { await handleDashboardInteraction(i, fakeManager); } catch (e) { renderThrew = e; }
        assert.ok(!renderThrew, `إرسال النموذج رفع خطأ غير متوقع: ${renderThrew?.message}`);
        assert.strictEqual(capturedCreates.length, 1, 'createAgent يجب أن يُستدعى مرة واحدة');
        const opts = capturedCreates[0];
        assert.strictEqual(opts.provider, 'qwen', `المزود يجب أن يكون qwen — وجدنا: ${opts.provider}`);
        assert.strictEqual(opts.providerConfig.qwen_token, 'QWEN_BEARER_TOKEN', 'qwen_token يجب أن يُحفظ');
        assert.strictEqual(opts.providerConfig.qwen_model, 'qwen3.8-max', 'qwen_model يجب أن يُحفظ');
        assert.ok(!opts.providerConfig.deepseek_token, 'يجب ألا يُحفظ deepseek_token لوكيل Qwen');
        assert.strictEqual(opts.name, 'وكيل قwen');
        assert.ok(i.__captured.reply, 'يجب أن يرد برسالة نجاح وصفحة الوكيل');
        passed++; console.log('✅ 4) إرسال نموذج Qwen → createAgent({provider: qwen}) + إعدادات Qwen');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 5: إرسال نموذج OpenAI → وكيل openai بإعداداته
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({
            customId: 'dash:create_modal:bot:openai',
            isModal: true,
            fields: makeFields({
                name: 'OA',
                discord_token: 'DISCORD_TOKEN_XYZ',
                openai_base_url: 'https://api.example.com/v1',
                openai_api_key: 'sk-test',
                openai_model: 'gpt-4o',
            }),
        });
        await handleDashboardInteraction(i, fakeManager);
        const opts = capturedCreates[1];
        assert.strictEqual(opts.provider, 'openai', `المزود يجب أن يكون openai — وجدنا: ${opts.provider}`);
        assert.strictEqual(opts.providerConfig.openai_base_url, 'https://api.example.com/v1');
        assert.strictEqual(opts.providerConfig.openai_api_key, 'sk-test');
        assert.strictEqual(opts.providerConfig.openai_model, 'gpt-4o');
        passed++; console.log('✅ 5) إرسال نموذج OpenAI → createAgent({provider: openai}) + إعدادات OpenAI');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 6: توافق قديم — نموذج بدون مزود في المعرف = deepseek
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({
            customId: 'dash:create_modal:bot', // صيغة قديمة بدون مزود
            isModal: true,
            fields: makeFields({ name: 'Old', discord_token: 'D', deepseek_token: 'DS' }),
        });
        await handleDashboardInteraction(i, fakeManager);
        const opts = capturedCreates[2];
        assert.strictEqual(opts.provider, 'deepseek', 'الصيغة القديمة يجب أن تظل deepseek');
        assert.strictEqual(opts.providerConfig.deepseek_token, 'DS');
        passed++; console.log('✅ 6) التوافق القديم: dash:create_modal:bot بدون مزود → deepseek');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 7: للوكيل user أيضاً — dash:create_provider:user مع qwen
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: 'dash:create_provider:user', values: ['qwen'], isSelect: true });
        await handleDashboardInteraction(i, fakeManager);
        const modal = i.__captured.showModal;
        const ids = collectComponentIds(modal);
        assert.ok(ids.some(s => s === '__modalId__:dash:create_modal:user:qwen'), `نافذة user/qwen خاطئة: ${ids}`);
        assert.ok(ids.includes('qwen_token'));
        passed++; console.log('✅ 7) وكيل User Account مع Qwen → dash:create_modal:user:qwen');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`النتيجة: ${passed}/7 اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌ E2E FAILED:', e.message); process.exit(1); });
