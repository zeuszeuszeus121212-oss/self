/**
 * tests/agent_kinds.test.js — اختبارات نوعي الوكيل + التبديل الحر للمزود
 * ═══════════════════════════════════════════════════════════════════════
 * يغطي:
 *   1) نوع «محادثة»: برومبت بأدوات أساسية صامتة فقط (ذاكرة/تذكيرات/قراءة)
 *      بلا أي ذكر لأدوات الإدارة/التنفيذ + قاعدة الصمت المطلق عن الآلية.
 *   2) نوع «محادثة» في الحلقة: أدواته الأساسية تعمل، وكل هلوسة إدارية
 *      (execute أو أداة خارج القائمة) تُحجب محايداً بلا تنفيذ.
 *   3) نوع «وكيل»: يبقى كما هو تماماً — حلقة الأدوات تعمل (regression).
 *   4) Fallback يعمل في مسار المحادثة.
 *   5) createAgent يخزن kind (توافق قديم: بلا kind = agent).
 *   6) معالج الإنشاء 4 خطوات والصيغ القديمة.
 *   7) 🔓 تبديل المزود حر دائماً.
 *   8) مبدّل الوضع kind_set: قاعدة بيانات + runtime حي.
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const FAKE_AGENT_ID = '507f1f77bcf86cd799439011';

let currentFakeAgent = {
    _id: FAKE_AGENT_ID,
    name: 'TEST',
    provider: 'qwen',
    kind: 'agent',
    qwen_token: 'tok',
    status: 'stopped',
};
const capturedAgentUpdates = [];
const capturedCreates = [];

const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n,
    MONGODB_URI: null, DISCORD_TOKEN: null, USER_TOKEN: null, DEEPSEEK_TOKEN: null,
    CONTROL_ROLE_NAME: '', RAILWAY_URL: '', POW_PROXY_TELEGRAM: '', DEFAULT_POW_PROVIDER: 'railway',
    MAX_CHANNELS_PER_GUILD: 5, MAX_ATTACHMENT_BYTES: 1000000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']), TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
    mongoClient: null, connectMongo: async () => {},
    memories_col: null, reminders_col: null, knowledge_col: null, providers_col: null,
    agents_col: {
        findOne: async () => currentFakeAgent,
        updateOne: async (q, u) => {
            capturedAgentUpdates.push(u);
            if (u.$set && currentFakeAgent) Object.assign(currentFakeAgent, u.$set);
            return { modifiedCount: 1 };
        },
        insertOne: async (doc) => ({ insertedId: doc._id || 'new' }),
        find: () => ({ limit: () => ({ toArray: async () => [] }) }),
        countDocuments: async () => 1,
    },
    logs_col: {
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
        insertOne: async () => {},
    },
    settings_col: { findOne: async () => null },
    usage_col: { find() { return { sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }; }, async updateOne() { return { modifiedCount: 1 }; } },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() },
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const { ObjectId } = require('mongodb');
const providers = require('../providers');
const { runAgent } = require('../tools');
const { CHAT_MODE_TOOLS } = require('../tools/agent');
const { buildSystem } = require('../tools/systemPrompt');
const { createAgent } = require('../bot');
const {
    handleDashboardInteraction,
    renderAgentSettings,
} = require('../managerDashboard');

// ── أدوات المحاكاة (نفس نمط e2e_create_flow) ──
function makeInteraction({ customId, values = null, fields = null, isModal = false, isSelect = false, isButton = false }) {
    const captured = { showModal: null, reply: null, update: null, followUps: [] };
    return {
        customId,
        values,
        user: { id: '656783724662226963' },
        guildId: '111111111111111111',
        member: null,
        channel: null,
        channelId: '222222222222222222',
        isChatInputCommand: () => false,
        isStringSelectMenu: () => isSelect,
        isModalSubmit: () => isModal,
        isButton: () => isButton,
        isChannelSelectMenu: () => false,
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

function collectAllIds(payload) {
    const ids = [];
    (function walk(comp) {
        if (!comp || typeof comp !== 'object') return;
        const cid = comp.data?.custom_id || comp.customId || comp.custom_id;
        if (cid) ids.push(cid);
        for (const child of comp.components || []) walk(child);
    })(payload);
    return ids.filter(Boolean);
}

function payloadText(payload) {
    let out = '';
    (function walk(comp) {
        if (!comp || typeof comp !== 'object') return;
        const c = (typeof comp.content === 'string') ? comp.content
            : (comp.data && typeof comp.data.content === 'string') ? comp.data.content : null;
        if (c) out += c + '\n';
        for (const child of comp.components || []) walk(child);
    })(payload);
    return out;
}

// ── مزود وهمي يحسب استدعاءاته ──
let providerCalls = [];
const fakeChatProvider = {
    id: 'fake_kind', label: 'وهمي الأنواع', emoji: '🧪', description: 'w',
    modalFields: [{ id: 'fake_kind_token', label: 'توكن', required: true, maxLength: 300 }],
    validate: () => ({ ok: true, missing: [] }),
    describe: () => 'w',
    async testConnection() { return 'ok'; },
    async chat({ prompt }) {
        providerCalls.push(prompt);
        const scripted = fakeChatProvider.script;
        const fullText = typeof scripted === 'function' ? scripted(prompt) : scripted;
        return { fullText, sessionId: `fake_sid_${providerCalls.length}`, newParentMessageId: null };
    },
};

const fakeBackupProvider = {
    id: 'fake_kind_backup', label: 'وهمي احتياطي', emoji: '🧪', description: 'w',
    modalFields: [],
    validate: () => ({ ok: true, missing: [] }),
    describe: () => 'w',
    async testConnection() { return 'ok'; },
    async chat() { return { fullText: 'رد الاحتياطي', sessionId: 'bak_sid', newParentMessageId: 'bak_pm' }; },
};

// Manager وهمي مع runtime حي واحد
const fakeRuntimeSettings = { kind: 'agent', provider: 'qwen', providerConfig: {} };
const fakeRuntime = { runtimeSettings: fakeRuntimeSettings, channel_sessions: new Map() };
const fakeManager = {
    runtimes: new Map([[FAKE_AGENT_ID, fakeRuntime]]),
    async createAgent(opts) { capturedCreates.push(opts); return { ...opts, _id: new ObjectId(FAKE_AGENT_ID) }; },
    async logAgent() {},
    async notify() {},
};

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    // حقن المزودات الوهمية في السجل
    providers.PROVIDERS[fakeChatProvider.id] = fakeChatProvider;
    providers.PROVIDERS[fakeBackupProvider.id] = fakeBackupProvider;

    // ══════════════════════════════════════════════════════════
    // 1) برومبت «محادثة»: أدوات أساسية صامتة فقط + قاعدة الصمت
    // ══════════════════════════════════════════════════════════
    {
        const chat = buildSystem('TestBot', 'default', false, 'member', '', {}, {}, 'chat');
        const agent = buildSystem('TestBot', 'default', false, 'owner', '', {}, {}, 'agent');
        // ممنوع في برومبت المحادثة: أي أداة إدارة/تنفيذ/ويب أو آلية الحلقة
        // (المعرفة أصبحت حاسّة صامتة معتمدة في المحادثة منذ v7.10 — ليست محظورة)
        const banned = ['execute', 'read_url', 'generate_image', 'create_file',
            'clone_server', 'kick_member', 'delete_channel', 'TOOL_RESULT', 'executeAction'];
        const leaked = banned.filter(n => chat.includes(n));
        assert.deepStrictEqual(leaked, [], `برومبت المحادثة يجب ألا يذكر أدوات الإدارة/التنفيذ — تسرب: ${leaked}`);
        // كل أداة من القائمة الأساسية موثقة في البرومبت
        const missing = CHAT_MODE_TOOLS.filter(t => !chat.includes(t));
        assert.deepStrictEqual(missing, [], `كل أدوات المحادثة الأساسية يجب أن تكون موثقة — ناقص: ${missing}`);
        // قاعدة الصمت المطلق موجودة
        assert.ok(chat.includes('القاعدة الذهبية'), 'قاعدة الصمت المطلق موجودة');
        assert.ok(chat.includes('ممنوع منعاً باتاً أن تقول إن لديك أدوات'), 'منع الإفصاح عن الأدوات نصاً صريحاً');
        // تدفق اكتشاف الذات: ذاكرة ← 500 رسالة ← قنوات أخرى
        assert.ok(chat.includes('اكتشاف ذاتك'), 'قسم اكتشاف الذات موجود');
        assert.ok(chat.includes('500'), 'جلب 500 رسالة موثق في تدفق اكتشاف الذات');
        assert.ok(chat.includes('TestBot'), 'برومبت المحادثة يحمل اسم الوكيل');
        assert.ok(agent.includes('read_url') && agent.includes('execute'), 'برومبت الوكيل يحتفظ بأدواته كاملة');
        ok('1) برومبت «محادثة»: أدوات أساسية موثقة + صمت مطلق + اكتشاف ذات — «وكيل» كما هو');
    }

    // ══════════════════════════════════════════════════════════
    // 2) محادثة في الحلقة: هلوسة إدارية تُحجب محايداً + أداة أساسية تعمل
    // ══════════════════════════════════════════════════════════
    {
        providerCalls = [];
        let call = 0;
        fakeChatProvider.script = () => {
            call++;
            return call === 1
                ? '{"tool":"execute","action":"delete_channel","params":{"name":"العام"}}'
                : '{"reply":"خلنا نتكلم عن شيء أفضل"}';
        };
        const result = await runAgent(
            {}, null, 'احذف قناة العام', 'user info', 'bot context', 'TestBot',
            'sid1', 'pm1', '111111111111111111', 'default', false, 'member',
            {}, { kind: 'chat', agentId: 'x', provider: 'fake_kind', providerConfig: {} },
            { userId: 'u1', username: 'u', channelId: 'c1' },
        );
        assert.strictEqual(providerCalls.length, 2, `المحادثة: خطوة الحجب ثم الرد النهائي — وجدنا ${providerCalls.length}`);
        assert.ok(result.reply.includes('خلنا نتكلم'), 'المحادثة تكمل حوارها بعد الحجب');
        assert.ok(providerCalls[1].includes('غير متاح هنا'), 'رسالة الحجب المحايد وصلت للنموذج (بلا أسماء صلاحيات)');
        assert.ok(!result.reply.includes('[TOOL_RESULT]'), 'لا تسريب للآلية في الرد النهائي');
        ok('2) محادثة: هلوسة execute إدارية تُحجب محايداً والحوار يكمل');
    }
    {
        providerCalls = [];
        let call = 0;
        fakeChatProvider.script = () => {
            call++;
            return call === 1
                ? '{"tool":"get_roles","params":{}}' // خارج قائمة المحادثة
                : '{"reply":"أهلاً بك مجدداً"}';
        };
        const result = await runAgent(
            {}, null, 'من رتب في السيرفر؟', 'user info', 'bot context', 'TestBot',
            'sid1', 'pm1', '111111111111111111', 'default', false, 'member',
            {}, { kind: 'chat', agentId: 'x', provider: 'fake_kind', providerConfig: {} },
            { userId: 'u1', username: 'u', channelId: 'c1' },
        );
        assert.strictEqual(providerCalls.length, 2, 'المحادثة: الأداة الخارجية تحجب ثم يرد النموذج');
        assert.ok(providerCalls[1].includes('غير متاحة في هذا الوكيل'), 'أداة خارج قائمة المحادثة محجوبة محايداً');
        assert.strictEqual(result.reply, 'أهلاً بك مجدداً', 'الرد النهائي حوار طبيعي');
        ok('2-ب) محادثة: أداة قراءة خارج القائمة البيضاء محجوبة (لا تنفيذ)');
    }
    {
        providerCalls = [];
        let call = 0;
        fakeChatProvider.script = () => {
            call++;
            return call === 1
                ? '{"tool":"recall","params":{}}' // داخل قائمة المحادثة — يعمل
                : '{"reply":"تذكرت الآن قصتنا"}';
        };
        const result = await runAgent(
            {}, null, 'هل تذكرني؟', 'user info', 'bot context', 'TestBot',
            'sid1', 'pm1', '111111111111111111', 'default', false, 'member',
            {}, { kind: 'chat', agentId: 'x', provider: 'fake_kind', providerConfig: {} },
            { userId: 'u1', username: 'u', channelId: 'c1' },
        );
        assert.strictEqual(providerCalls.length, 2, 'المحادثة: أداة أساسية (recall) تنفذ ثم رد نهائي');
        assert.ok(providerCalls[1].includes('TOOL_RESULT'), 'نتيجة الأداة الأساسية وصلت للنموذج');
        assert.strictEqual(result.reply, 'تذكرت الآن قصتنا', 'الحوار يكمل بعد الاستدعاء الصامت');
        ok('2-ج) محادثة: الأدوات الأساسية (recall) تعمل فعلاً داخل الحلقة');
    }
    // ══════════════════════════════════════════════════════════
    // 2-د) 📚 محادثة: حاسّة المعرفة الصامتة — search_knowledge تعمل
    //      للعضو العادي (v7.10: بيانات الفريق المرفوعة لعلم الوكيل)
    // ══════════════════════════════════════════════════════════
    {
        // 📚 معرفة وهمية: مستند مصطلحات ترجمة مانهوا (حالة استخدام المالك)
        const fakeKnowledgeCol = {
            find: () => ({
                limit: () => ({
                    toArray: async () => [{
                        agent_id: 'x', source: 'glossary.txt', chunk_index: 0,
                        content: 'مصطلحات الترجمة المعتمدة: مانها = رجل صالح، غيلد = نقابة المغامرين.',
                        tokens: ['مصطلحات', 'الترجمه', 'مانها', 'غيلد', 'نقابه'], size: 80,
                    }],
                }),
            }),
        };
        const knowledge = require('../knowledge');
        fakeConfig.knowledge_col = fakeKnowledgeCol; // حقن مؤقت — knowledge.js يقرأه حياً
        try {
            providerCalls = [];
            let call = 0;
            fakeChatProvider.script = () => {
                call++;
                return call === 1
                    ? '{"tool":"search_knowledge","params":{"query":"مصطلحات الترجمة","limit":4}}' // ضمن حواس المحادثة — تعمل
                    : '{"reply":"حسب مصطلحاتنا المعتمدة، غيلد تعني نقابة المغامرين"}';
            };
            const result = await runAgent(
                {}, null, 'كيف نترجم كلمة غيلد؟', 'user info', 'bot context', 'TestBot',
                'sid1', 'pm1', '111111111111111111', 'default', false, 'member',
                {}, { kind: 'chat', agentId: 'x', provider: 'fake_kind', providerConfig: {} },
                { userId: 'u1', username: 'u', channelId: 'c1' },
            );
            assert.strictEqual(providerCalls.length, 2, 'المحادثة: استدعاء المعرفة ثم الرد النهائي');
            assert.ok(providerCalls[1].includes('TOOL_RESULT'), 'نتيجة البحث في المعرفة وصلت للنموذج');
            assert.ok(providerCalls[1].includes('نقابة المغامرين'), 'محتوى المعرفة المرفوعة وصل فعلاً (مصطلحات الترجمة)');
            assert.strictEqual(result.reply, 'حسب مصطلحاتنا المعتمدة، غيلد تعني نقابة المغامرين', 'الحوار يكمل بمعرفة المستندات');
            ok('2-د) محادثة: حاسّة المعرفة الصامتة تعمل — بيانات الفريق المرفوعة تصبح علمه (v7.10)');
        } finally {
            fakeConfig.knowledge_col = null;
        }
    }

    // ══════════════════════════════════════════════════════════
    // 3) مسار المحادثة: Fallback يعمل عند فشل الأساسي (داخل الحلقة)
    // ══════════════════════════════════════════════════════════
    {
        const failProvider = { ...fakeChatProvider, id: 'fake_kind_fail', label: 'فاشل', async chat() { throw new Error('انفجار'); } };
        providers.PROVIDERS[failProvider.id] = failProvider;
        const result = await runAgent(
            {}, null, 'مرحبا', 'user info', 'bot context', 'TestBot',
            null, null, '111111111111111111', 'default', false, 'member',
            {}, { kind: 'chat', agentId: 'x', provider: 'fake_kind_fail', providerConfig: {}, fallback_enabled: true, fallback_chain: ['fake_kind_backup'], fallback_configs: {} },
            { userId: 'u1', username: 'u' },
        );
        assert.ok(result.reply.includes('رد الاحتياطي'), `الفallback يعمل في المحادثة — وجدنا: ${result.reply}`);
        ok('3) مسار المحادثة: Fallback تلقائي للمزود البديل');
        delete providers.PROVIDERS[failProvider.id];
    }

    // ══════════════════════════════════════════════════════════
    // 4) مسار الوكيل (regression): حلقة الأدوات تعمل كما هي
    // ══════════════════════════════════════════════════════════
    {
        providerCalls = [];
        let call = 0;
        fakeChatProvider.script = () => {
            call++;
            return call === 1
                ? '{"tool":"recall","params":{}}'
                : '{"reply":"تم بنجاح"}';
        };
        const result = await runAgent(
            {}, null, 'اذكر ذكرياتي', 'user info', 'bot context', 'TestBot',
            'sid1', 'pm1', '111111111111111111', 'default', false, 'member',
            {}, { kind: 'agent', agentId: 'x', provider: 'fake_kind', providerConfig: {} },
            { userId: 'u1', username: 'u', channelId: 'c1' },
        );
        assert.strictEqual(providerCalls.length, 2, 'الوكيل: استدعاء الأداة ثم الرد النهائي = استدعاءان');
        assert.strictEqual(result.reply, 'تم بنجاح', 'الوكيل يكمل حتى الرد النهائي بعد الأداة');
        ok('4) مسار الوكيل (regression): حلقة الأدوات تعمل كما هي');
    }

    // ══════════════════════════════════════════════════════════
    // 5) createAgent يخزن kind — والافتراضي agent
    // ══════════════════════════════════════════════════════════
    {
        const chatDoc = await createAgent({ name: 'دردشة', discord_token: 'D', kind: 'chat', provider: 'qwen', providerConfig: { qwen_token: 't' }, allowIncomplete: false });
        assert.strictEqual(chatDoc.kind, 'chat', 'createAgent(kind=chat) يخزن chat');
        const defDoc = await createAgent({ name: 'افتراضي', discord_token: 'D', provider: 'qwen', providerConfig: { qwen_token: 't' } });
        assert.strictEqual(defDoc.kind, 'agent', 'createAgent بلا kind = agent (توافق قديم)');
        ok('5) createAgent يخزن kind — بلا kind = agent');
    }

    // ══════════════════════════════════════════════════════════
    // 6) معالج الإنشاء 4 خطوات كامل لوكيل «محادثة»
    // ══════════════════════════════════════════════════════════
    {
        // الخطوة 1: اختيار الطبيعة → عرض نوع الحساب مع kind في المعرف
        const s1 = makeInteraction({ customId: 'dash:create_kind', values: ['chat'], isSelect: true });
        await handleDashboardInteraction(s1, fakeManager);
        const ids1 = collectAllIds(s1.__captured.update);
        assert.ok(ids1.includes('dash:create_type:chat'), `خطوة الحساب يجب أن تحمل kind=chat — وجدنا: ${ids1}`);

        // الخطوة 2: اختيار الحساب → عرض المزود مع kind
        const s2 = makeInteraction({ customId: 'dash:create_type:chat', values: ['bot'], isSelect: true });
        await handleDashboardInteraction(s2, fakeManager);
        const ids2 = collectAllIds(s2.__captured.update);
        assert.ok(ids2.includes('dash:create_provider:bot:chat'), `خطوة المزود يجب أن تحمل kind — وجدنا: ${ids2}`);

        // الخطوة 3: اختيار المزود → نافذة الإنشاء تحمل kind
        const s3 = makeInteraction({ customId: 'dash:create_provider:bot:chat', values: ['qwen'], isSelect: true });
        await handleDashboardInteraction(s3, fakeManager);
        const modal = s3.__captured.showModal;
        assert.ok(modal, 'يجب أن تفتح نافذة الإنشاء');
        const modalJson = modal.toJSON();
        assert.strictEqual(modalJson.custom_id, 'dash:create_modal:bot:chat:qwen', `معرف النافذة يجب أن يحمل kind — وجدنا: ${modalJson.custom_id}`);

        // الخطوة 4: إرسال النافذة → createAgent(kind='chat')
        const s4 = makeInteraction({
            customId: 'dash:create_modal:bot:chat:qwen',
            isModal: true,
            fields: makeFields({ name: 'رفيق', discord_token: 'D', qwen_token: 'T', personality: 'لطيف' }),
        });
        await handleDashboardInteraction(s4, fakeManager);
        const opts = capturedCreates[capturedCreates.length - 1];
        assert.strictEqual(opts.kind, 'chat', 'createAgent يجب أن يستلم kind=chat');
        assert.strictEqual(opts.provider, 'qwen');
        ok('6) معالج الإنشاء 4 خطوات: الطبيعة ← الحساب ← المزود ← نافذة تحمل kind → createAgent(kind=chat)');
    }

    // ══════════════════════════════════════════════════════════
    // 7) توافق قديم: نافذة الصيغة القديمة dash:create_modal:bot:qwen = agent
    // ══════════════════════════════════════════════════════════
    {
        const s = makeInteraction({
            customId: 'dash:create_modal:bot:qwen',
            isModal: true,
            fields: makeFields({ name: 'قديم', discord_token: 'D', qwen_token: 'T' }),
        });
        await handleDashboardInteraction(s, fakeManager);
        const opts = capturedCreates[capturedCreates.length - 1];
        assert.strictEqual(opts.kind, 'agent', 'الصيغة القديمة = وكيل بأدوات');
        ok('7) توافق قديم: نافذة بلا kind = agent');
    }

    // ══════════════════════════════════════════════════════════
    // 8) 🔓 تبديل المزود بنواقص: لا حجب — تبديل + تعليم ناقص + أزرار إكمال
    // ══════════════════════════════════════════════════════════
    {
        capturedAgentUpdates.length = 0;
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'TEST', provider: 'qwen', kind: 'agent', qwen_token: 'tok', status: 'stopped' };
        const s = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:aiprovider_set`, values: ['gemini'], isSelect: true });
        await handleDashboardInteraction(s, fakeManager);
        const switchUpdate = capturedAgentUpdates.find(u => u.$set && u.$set.provider === 'gemini');
        assert.ok(switchUpdate, 'يجب أن يتم التبديل فعلياً في قاعدة البيانات');
        assert.strictEqual(switchUpdate.$set.config_incomplete, true, 'الوكيل يُعلَّم ناقص الإعدادات');
        assert.deepStrictEqual(switchUpdate.$set.missing_provider_fields, ['gemini_cookies']);
        assert.strictEqual(fakeRuntimeSettings.provider, 'gemini', 'التبديل حي على الـ runtime');
        const payloadTextAll = payloadText(s.__captured.update);
        assert.ok(payloadTextAll.includes('تم التبديل إلى') || payloadTextAll.includes('أكمل بياناته'), 'تنبيه النواقص ظاهر');
        const btnIds = collectAllIds(s.__captured.update);
        assert.ok(btnIds.includes(`dash:agent:${FAKE_AGENT_ID}:edit_creds`), 'زر إدخال بيانات المزود ظاهر');
        assert.ok(!payloadTextAll.includes('لا يمكن التبديل'), 'لا رسالة حجب أبداً');
        ok('8) تبديل المزود بنواقص: نجح التبديل + علم ناقص + أزرار إكمال (لا حجب)');
    }

    // ══════════════════════════════════════════════════════════
    // 9) 🔓 تبديل المزود ببيانات جاهزة: صفحة المزود مباشرة بلا تنبيه
    // ══════════════════════════════════════════════════════════
    {
        capturedAgentUpdates.length = 0;
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'TEST', provider: 'qwen', kind: 'agent', qwen_token: 'tok', deepseek_token: 'ds', status: 'stopped' };
        const s = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:aiprovider_set`, values: ['deepseek'], isSelect: true });
        await handleDashboardInteraction(s, fakeManager);
        const switchUpdate = capturedAgentUpdates.find(u => u.$set && u.$set.provider === 'deepseek');
        assert.ok(switchUpdate, 'التبديل تم');
        assert.strictEqual(switchUpdate.$set.config_incomplete, false, 'بيانات DeepSeek جاهزة — لا ناقص');
        const text = payloadText(s.__captured.update);
        assert.ok(!text.includes('أكمل بياناته'), 'لا تنبيه نواقص عند الاكتمال');
        ok('9) تبديل المزود ببيانات جاهزة: نظيف وبلا تنبيه');
    }

    // ══════════════════════════════════════════════════════════
    // 10) مبدّل الوضع kind_set: قاعدة بيانات + runtime حي معاً
    // ══════════════════════════════════════════════════════════
    {
        capturedAgentUpdates.length = 0;
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'TEST', provider: 'qwen', kind: 'agent', qwen_token: 'tok', status: 'stopped' };
        fakeRuntimeSettings.kind = 'agent';
        const s = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:kind_set`, values: ['chat'], isSelect: true });
        await handleDashboardInteraction(s, fakeManager);
        const kindUpdate = capturedAgentUpdates.find(u => u.$set && u.$set.kind);
        assert.ok(kindUpdate, 'يجب أن يُحفظ kind في قاعدة البيانات');
        assert.strictEqual(kindUpdate.$set.kind, 'chat');
        assert.strictEqual(fakeRuntimeSettings.kind, 'chat', 'التبديل حي على الـ runtime');
        const pageIds = collectAllIds(s.__captured.update);
        assert.ok(pageIds.includes(`dash:agent:${FAKE_AGENT_ID}:kind_set`), 'صفحة الإعدادات تعاد بعد التبديل');
        ok('10) مبدّل الوضع: DB + runtime حي + إعادة عرض الإعدادات');
    }

    // ══════════════════════════════════════════════════════════
    // 11) صفحة الإعدادات تعرض الوضع الحالي (محادثة)
    // ══════════════════════════════════════════════════════════
    {
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'TEST', provider: 'qwen', kind: 'chat', qwen_token: 'tok', status: 'stopped' };
        const page = await renderAgentSettings(FAKE_AGENT_ID, '111111111111111111');
        const text = payloadText(page);
        assert.ok(text.includes('محادثة'), 'الوضع «محادثة» ظاهر في صفحة الإعدادات');
        assert.ok(text.includes('صامتة') || text.includes('حوار طبيعي'), 'وصف الوضوح للوضع الجديد (أدوات أساسية صامتة)');
        ok('11) صفحة الإعدادات تعرض وضع الوكيل بوضوح');
    }

    console.log(`\n🎉 agent_kinds: ${passed}/${passed} اختباراً ناجحاً`);
}

run().catch((e) => {
    console.error('❌ فشل اختبار أنواع الوكلاء:', e);
    process.exit(1);
});
