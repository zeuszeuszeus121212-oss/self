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
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
    mongoClient: null,
    connectMongo: async () => {},
    channel_sessions: new Map(),
    allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() },
    agents_col: {
        findOne: async () => currentFakeAgent,
        updateOne: async (q, u) => {
            capturedAgentUpdates.push(u);
            if (u.$set && currentFakeAgent) Object.assign(currentFakeAgent, u.$set);
            return { modifiedCount: 1 };
        },
        find: () => ({ limit: () => ({ toArray: async () => [] }) }),
    },
    logs_col: {
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
        insertOne: async () => {},
    },
    settings_col: { findOne: async () => null },
    // 📚 معرفة وهمية
    knowledge_col: {
        docs: [],
        async deleteMany(q) { const before = this.docs.length; this.docs = this.docs.filter(d => d.agent_id !== q.agent_id || d.source !== q.source); return { deletedCount: before - this.docs.length }; },
        async insertMany(arr) { for (const d of arr) this.docs.push({ ...d }); return { insertedCount: arr.length }; },
        find(q) {
            const arr = this.docs.filter(d => d.agent_id === q.agent_id && (!q.source || d.source === q.source));
            return { limit: () => ({ toArray: async () => arr }), toArray: async () => arr };
        },
        async countDocuments(q) { return this.docs.filter(d => d.agent_id === q.agent_id).length; },
        async distinct(field, q) { return [...new Set(this.docs.filter(d => d.agent_id === q.agent_id).map(d => d[field]))]; },
        aggregate(pipeline) {
            const $match = pipeline.find(s => s.$match)?.$match || {};
            const $limit = pipeline.find(s => s.$limit)?.$limit;
            let arr = this.docs.filter(d => d.agent_id === $match.agent_id);
            const groups = new Map();
            for (const d of arr) {
                if (!groups.has(d.source)) groups.set(d.source, { source: d.source, chunks: 0, chars: 0, added_at: d.created_at });
                groups.get(d.source).chunks++;
                groups.get(d.source).chars += d.size || 0;
            }
            arr = [...groups.values()].map(g => ({ ...g, _id: g.source }));
            if ($limit) arr = arr.slice(0, $limit);
            return { toArray: async () => arr };
        },
    },
    // 📊 استخدام وهمي
    usage_col: {
        find() { return { sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }; },
        async updateOne() { return { modifiedCount: 1 }; },
    },
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const { ObjectId } = require('mongodb');
const {
    handleDashboardInteraction,
    renderAgent,
    renderAgentSettings,
    renderAgentKnowledge,
    renderAgentUsage,
    renderAgentProactive,
    handleKnowledgeUploadMessage,
} = require('../managerDashboard');
const secrets = require('../secrets');

// الوكيل الوهمي الحالي — تتحكم به الاختبارات
let currentFakeAgent = {
    _id: FAKE_AGENT_ID,
    name: 'TEST',
    provider: 'qwen',
    qwen_token: 'tok',
    status: 'stopped',
};

// سجل التحديثات على الوكيل الوهمي
const capturedAgentUpdates = [];

// ---------- 2) أدوات المحاكاة ----------
function makeInteraction({ customId, values = null, fields = null, isModal = false, isSelect = false, isChannelSelect = false, guildId = null }) {
    const captured = { showModal: null, reply: null, update: null, followUps: [] };
    return {
        customId,
        values,
        user: { id: '656783724662226963' },
        guildId,
        member: null,
        channel: null,
        channelId: '222222222222222222',
        isChatInputCommand: () => false,
        isStringSelectMenu: () => isSelect,
        isModalSubmit: () => isModal,
        isButton: () => false,
        isChannelSelectMenu: () => isChannelSelect,
        isRoleSelectMenu: () => false,
        async showModal(modal) { captured.showModal = modal; },
        async reply(payload) { captured.reply = payload; },
        async update(payload) { captured.update = payload; },
        async followUp(payload) { captured.followUps.push(payload); },
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

// جمع كل المعرفات من صفحة (أزرار + قوائم منسدلة + قوائم قنوات)
function collectAllIds(payload) {
    const ids = [];
    for (const row of payload?.components || []) {
        const comps = row.components || [];
        for (const c of comps) {
            ids.push(c.data?.custom_id || c.customId || c.custom_id);
        }
    }
    return ids.filter(Boolean);
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

    // ══════════════════════════════════════════════════════════
    // اختبار 8: زر POW مخفي لوكلاء Qwen وOpenAI — ظاهر لـ DeepSeek فقط
    // ══════════════════════════════════════════════════════════
    {
        const collectBtnIds = (payload) => {
            const ids = [];
            for (const row of payload?.components || []) {
                for (const comp of row.components || []) ids.push(comp.data?.custom_id || comp.customId);
            }
            return ids;
        };

        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'QW', provider: 'qwen', qwen_token: 'tok', status: 'stopped' };
        const qwenPage = await renderAgent(fakeManager, FAKE_AGENT_ID);
        const qwenBtns = collectBtnIds(qwenPage);
        assert.ok(!qwenBtns.includes('dash:agent:' + FAKE_AGENT_ID + ':provider'),
            `وكيل Qwen يجب ألا يرى زر مزود POW — الأزرار: ${qwenBtns}`);

        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'OA', provider: 'openai', openai_api_key: 'k', status: 'stopped' };
        const oaPage = await renderAgent(fakeManager, FAKE_AGENT_ID);
        assert.ok(!collectBtnIds(oaPage).includes('dash:agent:' + FAKE_AGENT_ID + ':provider'),
            'وكيل OpenAI يجب ألا يرى زر مزود POW');

        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'DS', provider: 'deepseek', deepseek_token: 'tok', status: 'stopped' };
        const dsPage = await renderAgent(fakeManager, FAKE_AGENT_ID);
        assert.ok(collectBtnIds(dsPage).includes('dash:agent:' + FAKE_AGENT_ID + ':provider'),
            'وكيل DeepSeek يجب أن يرى زر مزود POW (كما كان)');

        // وكيل قديم بدون حقل provider = deepseek — الزر يبقى ظاهراً (توافق قديم)
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'OLD', deepseek_token: 'tok', status: 'stopped' };
        const oldPage = await renderAgent(fakeManager, FAKE_AGENT_ID);
        assert.ok(collectBtnIds(oldPage).includes('dash:agent:' + FAKE_AGENT_ID + ':provider'),
            'الوكيل القديم (بدون provider) يُعامل كـ DeepSeek — زر POW يبقى');

        passed++; console.log('✅ 8) زر POW: مخفي لـ Qwen/OpenAI — ظاهر لـ DeepSeek والوكلاء القدامى');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 9: صفحة الإعدادات — لا أسرار خام، أقنعة، أزرار كشف وتعديل وميزات
    // ══════════════════════════════════════════════════════════
    {
        const DS_SECRET = 'sk-DEEPSEEK-CORE-SECRET-a1b2';
        const DISCORD_SECRET = 'MTA cracked-token-VALUE-z9y8';
        currentFakeAgent = {
            _id: FAKE_AGENT_ID, name: 'SECRET-AG', provider: 'deepseek',
            deepseek_token: DS_SECRET, discord_token: DISCORD_SECRET,
            personality: 'شخصية قصيرة', status: 'stopped',
        };
        const page = await renderAgentSettings(FAKE_AGENT_ID, '111111111111111111');
        const text = JSON.stringify(page);
        assert.ok(!text.includes('sk-DEEPSEEK-CORE-SECRET'), 'التوكن الخام يجب ألا يظهر في الصفحة');
        assert.ok(!text.includes('cracked-token-VALUE'), 'توكن ديسكورد الخام يجب ألا يظهر');
        assert.ok(text.includes('••••••••'), 'يجب أن تظهر الأقنعة');
        const ids = collectAllIds(page);
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:reveal:deepseek_token`), 'زر كشف توكن DeepSeek');
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:reveal:discord_token`), 'زر كشف توكن ديسكورد');
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:edit_identity`), 'زر تعديل الاسم/الشخصية');
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:edit_creds`), 'زر تعديل بيانات المزود');
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:features_toggle:web_search`), 'زر تبديل web_search');
        assert.ok(text.includes('🟢 مفعّل'), 'web_search الافتراضي مفعّل (توافق قديم)');
        passed++; console.log('✅ 9) صفحة الإعدادات: أسرار مقنّعة + أزرار كشف/تعديل/ميزات');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 10: زر الكشف — يعرض القيمة الحقيقية في رسالة ephemeral
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:reveal:deepseek_token` });
        const handled = await handleDashboardInteraction(i, fakeManager);
        assert.strictEqual(handled, true);
        const reply = i.__captured.reply || i.__captured.followUps[0];
        assert.ok(reply, 'الكشف يجب أن يرد برسالة');
        assert.ok(reply.content.includes('sk-DEEPSEEK-CORE-SECRET-a1b2'), 'الرسالة يجب أن تحوي القيمة الحقيقية');
        assert.strictEqual(reply.ephemeral, true, 'الرسالة يجب أن تكون ephemeral');
        passed++; console.log('✅ 10) كشف السر: قيمة حقيقية في رسالة ephemeral فقط');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 11: تبديل web_search — DB + runtime حي معاً
    // ══════════════════════════════════════════════════════════
    {
        capturedAgentUpdates.length = 0;
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'FT', provider: 'qwen', qwen_token: 't', status: 'stopped' };
        const liveRuntime = { runtimeSettings: { features: { web_search: true } } };
        fakeManager.runtimes.set(FAKE_AGENT_ID, liveRuntime);

        // تعطيل
        const i1 = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:features_toggle:web_search` });
        await handleDashboardInteraction(i1, fakeManager);
        const u1 = capturedAgentUpdates.find(u => u.$set && u.$set.features);
        assert.ok(u1, 'يجب أن يُحفظ features في قاعدة البيانات');
        assert.strictEqual(u1.$set.features.web_search, false, 'بعد التبديل الأول: معطّل');
        assert.strictEqual(liveRuntime.runtimeSettings.features.web_search, false, 'تحديث حي: معطّل');

        // تفعيل مجدداً
        const i2 = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:features_toggle:web_search` });
        await handleDashboardInteraction(i2, fakeManager);
        const u2 = capturedAgentUpdates.filter(u => u.$set && u.$set.features).pop();
        assert.strictEqual(u2.$set.features.web_search, true, 'التبديل الثاني يعيده مفعّلاً');
        fakeManager.runtimes.delete(FAKE_AGENT_ID);
        passed++; console.log('✅ 11) تبديل web_search: يُخزن ويُحدّث الـ runtime الحي');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 12: صفحة المعرفة + بدء رفع + التقاط ملف حقيقي عبر HTTP محلي
    // ══════════════════════════════════════════════════════════
    {
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'KN', provider: 'qwen', qwen_token: 't', status: 'stopped' };
        fakeConfig.knowledge_col.docs = [];

        const page = await renderAgentKnowledge(FAKE_AGENT_ID, '111111111111111111');
        assert.ok(JSON.stringify(page).includes('قاعدة المعرفة'), 'عنوان صفحة المعرفة');
        const ids = collectAllIds(page);
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:knowledge_upload_start`), 'زر إضافة ملفات');

        // بدء الرفع — يفتح نافذة زمنية للمستخدم
        const i = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:knowledge_upload_start`, guildId: '111111111111111111' });
        await handleDashboardInteraction(i, fakeManager);
        const startPayload = i.__captured.update || i.__captured.reply;
        assert.ok(startPayload, 'بدء الرفع يرسل تعليمات الرفع');
        assert.ok(JSON.stringify(startPayload).includes('رفع ملفات المعرفة'), 'التعليمات تظهر للمستخدم');

        // خادم HTTP محلي يحاكي CDN ديسكورد
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('سياسة الاسترجاع: 14 يوماً كاملة لكل العملاء بدون أسئلة.');
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;

        const replies = [];
        const message = {
            guild: { id: '111111111111111111' },
            author: { id: '656783724662226963', bot: false },
            attachments: new Map([[
                'policies.txt',
                { name: 'policies.txt', size: 200, contentType: 'text/plain', url: `http://127.0.0.1:${port}/policies.txt` },
            ]]),
            reply: async (p) => { replies.push(p); },
        };
        const processed = await handleKnowledgeUploadMessage(message, fakeManager);
        assert.strictEqual(processed, true, 'الرسالة يجب أن تُعالج كرفع معرفة');
        await new Promise(r => server.close(r));

        assert.strictEqual(replies.length, 1, 'رد تأكيد واحد');
        assert.ok(JSON.stringify(replies[0]).includes('policies.txt'), 'التأكيد يذكر اسم الملف');
        assert.ok(fakeConfig.knowledge_col.docs.length >= 1, 'قطع أُدخلت فعلاً للمعرفة');
        assert.ok(fakeConfig.knowledge_col.docs.every(d => d.agent_id === FAKE_AGENT_ID && d.source === 'policies.txt'));

        // رسالة عادية بلا مرفقات → لا معالجة
        const processed2 = await handleKnowledgeUploadMessage(
            { guild: { id: '111111111111111111' }, author: { id: '656783724662226963', bot: false }, attachments: new Map(), reply: async () => {} },
            fakeManager,
        );
        assert.strictEqual(processed2, false);
        passed++; console.log('✅ 12) المعرفة: صفحة + بدء رفع + التقاط ملف حقيقي وإدخال قطع');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 13: صفحة الإحصائيات — تُعرض بنطاقات الأيام
    // ══════════════════════════════════════════════════════════
    {
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'US', provider: 'qwen', qwen_token: 't', status: 'stopped' };
        for (const days of [1, 7, 30]) {
            const page = await renderAgentUsage(FAKE_AGENT_ID, days);
            assert.ok(JSON.stringify(page).includes(`آخر ${days} يوم`), `عنوان بنطاق ${days}`);
        }
        const page7 = await renderAgentUsage(FAKE_AGENT_ID, 7);
        const ids = collectAllIds(page7);
        for (const d of [1, 7, 30]) {
            assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:usage:${d}`), `زر نطاق ${d} يوم`);
        }
        passed++; console.log('✅ 13) صفحة الإحصائيات: نطاقات 1/7/30 يوم وأزرارها');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 14: صفحة الاستباقية — تعطيل/تفعيل + إضافة قناة بنافذة كلمات
    // ══════════════════════════════════════════════════════════
    {
        capturedAgentUpdates.length = 0;
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'PR', provider: 'qwen', qwen_token: 't', status: 'stopped', proactive_enabled: false };

        const page = await renderAgentProactive(FAKE_AGENT_ID, '111111111111111111');
        const ids = collectAllIds(page);
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:proactive_toggle`), 'زر تفعيل/تعطيل');
        assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:proactive_channel_add`), 'قائمة إضافة قناة');

        // اختيار قناة → نافذة كلمات مفتاحية
        const iSel = makeInteraction({
            customId: `dash:agent:${FAKE_AGENT_ID}:proactive_channel_add`,
            values: ['333333333333333333'],
            isChannelSelect: true,
        });
        await handleDashboardInteraction(iSel, fakeManager);
        const modal = iSel.__captured.showModal;
        assert.ok(modal, 'اختيار القناة يفتح نافذة الكلمات');
        const modalIds = collectComponentIds(modal);
        assert.ok(modalIds.some(s => s.includes(`dash:proactive_modal:${FAKE_AGENT_ID}:333333333333333333`)), `معرف نافذة الاستباقية: ${modalIds}`);
        assert.ok(modalIds.includes('keywords') && modalIds.includes('cooldown'));

        // إرسال النافذة → حفظ الإدخال
        const iModal = makeInteraction({
            customId: `dash:proactive_modal:${FAKE_AGENT_ID}:333333333333333333`,
            isModal: true,
            fields: makeFields({ keywords: 'سعر، الخصم', cooldown: '15' }),
        });
        await handleDashboardInteraction(iModal, fakeManager);
        const u = capturedAgentUpdates.find(x => x.$set && x.$set.proactive_channels);
        assert.ok(u, 'يجب حفظ proactive_channels');
        assert.strictEqual(u.$set.proactive_channels[0].channel_id, '333333333333333333');
        assert.deepStrictEqual(u.$set.proactive_channels[0].keywords, ['سعر', 'الخصم']);
        assert.strictEqual(u.$set.proactive_channels[0].cooldown_minutes, 15);
        passed++; console.log('✅ 14) الاستباقية: صفحة + نافذة كلمات + حفظ الإدخال المطبّع');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 15: نوافذ التعديل المجزأة — هوية وتوكن وبيانات مزود
    // ══════════════════════════════════════════════════════════
    {
        currentFakeAgent = {
            _id: FAKE_AGENT_ID, name: 'EDIT', provider: 'openai',
            openai_base_url: 'https://api.old.com/v1', openai_api_key: 'sk-OLD',
            openai_model: 'gpt-x', personality: 'قديمة', status: 'stopped',
        };
        // نافذة الهوية
        const i1 = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:edit_identity` });
        await handleDashboardInteraction(i1, fakeManager);
        const m1 = i1.__captured.showModal;
        assert.ok(m1 && collectComponentIds(m1).some(s => s.includes('dash:edit_identity_modal:')), 'نافذة الهوية');
        assert.ok(JSON.stringify(m1).includes('قديمة'), 'الشخصية الحالية معبأة في النافذة');

        // إرسال الهوية
        capturedAgentUpdates.length = 0;
        const i2 = makeInteraction({
            customId: `dash:edit_identity_modal:${FAKE_AGENT_ID}`,
            isModal: true,
            fields: makeFields({ name: 'اسم-جديد', personality: 'شخصية جديدة' }),
        });
        await handleDashboardInteraction(i2, fakeManager);
        const u2 = capturedAgentUpdates.find(x => x.$set && x.$set.name);
        assert.ok(u2 && u2.$set.name === 'اسم-جديد' && u2.$set.personality === 'شخصية جديدة', 'الهوية تُحفظ');

        // نافذة بيانات المزود — حقول openai فقط
        const i3 = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:edit_creds` });
        await handleDashboardInteraction(i3, fakeManager);
        const m3 = i3.__captured.showModal;
        const m3Ids = collectComponentIds(m3);
        assert.ok(m3Ids.includes('openai_api_key') && m3Ids.includes('openai_base_url'), 'حقول openai في النافذة');
        assert.ok(!m3Ids.includes('qwen_token'), 'لا حقول مزودين آخرين');
        assert.ok(JSON.stringify(m3).includes('api.old.com'), 'base_url الحالي معبأ');
        assert.ok(!JSON.stringify(m3).includes('sk-OLD'), 'المفتاح السري القديم لا يُعرض في النافذة');

        // إرسال بيانات جديدة — السر يُشفّر أو يبقى نصاً بلا مفتاح (passthrough) والقيم تُحفظ
        capturedAgentUpdates.length = 0;
        const i4 = makeInteraction({
            customId: `dash:edit_creds_modal:${FAKE_AGENT_ID}`,
            isModal: true,
            fields: makeFields({ openai_api_key: 'sk-NEW-KEY', openai_model: 'gpt-4o' }),
        });
        await handleDashboardInteraction(i4, fakeManager);
        const u4 = capturedAgentUpdates.find(x => x.$set && x.$set.openai_api_key);
        assert.ok(u4, 'بيانات المزود تُحفظ');
        assert.strictEqual(u4.$set.openai_api_key, 'sk-NEW-KEY');
        assert.strictEqual(u4.$set.openai_model, 'gpt-4o');
        passed++; console.log('✅ 15) نوافذ التعديل المجزأة: هوية/توكن/بيانات مزود — عرض آمن وحفظ صحيح');
    }

    // ══════════════════════════════════════════════════════════
    // اختبار 16: صفحة الوكيل تحتوي الأزرار الجديدة الأربعة
    // ══════════════════════════════════════════════════════════
    {
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'NAV', provider: 'qwen', qwen_token: 't', status: 'stopped' };
        const page = await renderAgent(fakeManager, FAKE_AGENT_ID);
        const ids = collectAllIds(page);
        for (const suffix of ['settings', 'knowledge', 'usage:7', 'proactive']) {
            assert.ok(ids.includes(`dash:agent:${FAKE_AGENT_ID}:${suffix}`), `زر ${suffix} مفقود`);
        }
        assert.ok(ids.length <= 25, 'لا نتجاوز حد ديسكورد للمكونات (5 صفوف × 5)');
        passed++; console.log('✅ 16) صفحة الوكيل: أزرار الإعدادات/المعرفة/الإحصائيات/الاستباقية موجودة');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`النتيجة: ${passed}/16 اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌ E2E FAILED:', e.message); process.exit(1); });
