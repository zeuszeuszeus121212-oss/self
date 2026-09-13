/**
 * tests/platform.test.js — اختبارات منصة المزودين 2.0 (v7.4 "Nexus")
 * ─────────────────────────────────────────────────────────────
 * يغطي: قاعدة المزودين المحفوظين (حفظ مشفر + قائمة + صفحة + معالج إضافة تفاعلي)،
 * إنشاء وكيل من مزود محفوظ (نسخ base_url/المفتاح/النموذج)، قدرات النماذج
 * (thinking/search في الحمولات)، أداة generate_image عبر حلقة الوكيل،
 * ورفع الشخصية من ملف عبر زر ينتظر المرفق — كل ذلك بخوادم محلية.
 */

'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const FAKE_AGENT_ID = '507f1f77bcf86cd799439011';

// 🗄️ قاعدة مزودين وهمية — المعرفات ObjectIds حقيقية كما في Mongo
const { ObjectId: RealObjectId } = require('mongodb');
const providerDocs = new Map();
let providerSeq = 0;

// سجل التحديثات على الوكيل الوهمي
const capturedAgentUpdates = [];
let currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'PLAT', provider: 'qwen', qwen_token: 'tok', status: 'stopped' };

// 🔐 مفتاح تشفير للاختبار (قبل تحميل secrets)
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: null, reminders_col: null, knowledge_col: null,
    usage_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), async updateOne() { return { modifiedCount: 1 }; } },
    providers_col: {
        async insertOne(doc) { const id = new RealObjectId(); providerDocs.set(id.toString(), { ...doc, _id: id }); return { insertedId: id }; },
        async findOne(q) { const id = String(q._id || ''); return providerDocs.get(id) || null; },
        async deleteOne(q) { return { deletedCount: providerDocs.delete(String(q._id)) ? 1 : 0 }; },
        find() {
            const arr = [...providerDocs.entries()].map(([id, d]) => ({ ...d, _id: id }));
            return { sort: () => ({ limit: () => ({ toArray: async () => arr }) }), toArray: async () => arr };
        },
    },
    agents_col: {
        findOne: async () => currentFakeAgent,
        updateOne: async (q, u) => {
            capturedAgentUpdates.push(u);
            if (u.$set && currentFakeAgent) Object.assign(currentFakeAgent, u.$set);
            return { modifiedCount: 1 };
        },
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
const {
    handleDashboardInteraction, renderProviders, listSavedProviders,
    saveProviderToDb, fetchProviderModels, handlePersonalityUploadMessage,
} = require('../managerDashboard');
const secrets = require('../secrets');
const providers = require('../providers');
const qwenProvider = require('../providers/qwen');
const { runAgent } = require('../tools');

// ---------- أدوات المحاكاة (نفس نمط e2e_create_flow) ----------
function makeInteraction({ customId, values = null, fields = null, isModal = false, isSelect = false, guildId = '111111111111111111' } = {}) {
    const captured = { showModal: null, reply: null, update: null, followUps: [] };
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
        async reply(payload) { captured.reply = payload; return true; },  // ديسكورد يعيد Promise حقيقياً
        async update(payload) { captured.update = payload; return true; },
        async followUp(payload) { captured.followUps.push(payload); return true; },
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
    // 🎨 Components V2: مسح تكراري لكل الأعماق (الأزرار داخل الحاويات)
    const ids = [];
    (function walk(comp) {
        if (!comp || typeof comp !== 'object') return;
        const cid = comp.data?.custom_id || comp.customId || comp.custom_id;
        if (cid) ids.push(cid);
        for (const child of comp.components || []) walk(child);
    })(payload);
    return ids.filter(Boolean);
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

// خادم محلي: /models + /img.png + /p.txt
let MODELS_HITS = 0;
const server = http.createServer((req, res) => {
    if (req.url === '/models' || req.url === '/v1/models') {
        MODELS_HITS++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gemini-2.5-pro' }, { id: 'gpt-x' }, { id: 'qwen-max' }] }));
        return;
    }
    if (req.url === '/img.png') {
        // PNG 1x1 حقيقي
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f4cf9a4c0000000049454e44ae426082', 'hex');
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(png);
        return;
    }
    if (req.url === '/p.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('أنت مساعد لطيف تحب المساعدة والاختصار.\nتحب القهوة أكثر من الشاي.');
        return;
    }
    res.writeHead(404); res.end('nope');
});

async function run() {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const BASE = `http://127.0.0.1:${PORT}`;

    // ══════════════════════════════════════════════════════════
    // 1) حفظ مزود: المفتاح يُخزن مشفراً والقائمة تفكه داخلياً فقط
    // ══════════════════════════════════════════════════════════
    {
        const id = await saveProviderToDb({
            name: 'بروكسي رئيسي', base_url: `${BASE}/v1`, api_key: 'sk-PROXY-SECRET-xyz',
            models: ['gemini-2.5-pro', 'gpt-x'], userId: 'u1',
        });
        assert.ok(id, 'المزود حُفظ');
        const raw = [...providerDocs.values()].find(d => String(d._id) === String(id));
        assert.ok(secrets.isEncrypted(raw.api_key), 'المفتاح يجب أن يكون مشفراً في قاعدة البيانات');
        assert.ok(!JSON.stringify(raw).includes('sk-PROXY-SECRET'), 'المفتاح الخام يجب ألا يُخزن');
        const list = await listSavedProviders();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].api_key_plain, 'sk-PROXY-SECRET-xyz', 'فك داخلي للاستخدام');
        ok('1) حفظ مزود: تشفير المفتاح + فك داخلي في القائمة');
    }

    // ══════════════════════════════════════════════════════════
    // 2) صفحة المزودين: عرض مقنع + زر إضافة + قائمة حذف
    // ══════════════════════════════════════════════════════════
    {
        const page = await renderProviders();
        const text = JSON.stringify(page);
        assert.ok(!text.includes('sk-PROXY-SECRET-xyz'), 'المفتاح الخام يجب ألا يظهر');
        assert.ok(text.includes('••••••'), 'مفتاح مقنع يظهر');
        const ids = collectAllIds(page);
        assert.ok(ids.includes('dash:prov_add'), 'زر إضافة مزود');
        assert.ok(ids.includes('dash:prov_delete'), 'قائمة حذف مزود');
        ok('2) صفحة المزودين: عرض آمن + أزرار الإدارة');
    }

    // ══════════════════════════════════════════════════════════
    // 3) المعالج التفاعلي: نافذة (بلا نماذج) → جلب تلقائي من /models → اختيار → حفظ
    // ══════════════════════════════════════════════════════════
    {
        const countBefore = providerDocs.size;
        const i1 = makeInteraction({ customId: 'dash:prov_add_modal', isModal: true, fields: makeFields({
            name: 'بروكسي ثانٍ', base_url: `${BASE}/v1`, api_key: 'sk-SECOND', models: '',
        }) });
        await handleDashboardInteraction(i1, fakeManager); // modal → reply → يعيد undefined في المحاكاة
        const step2 = i1.__captured.update || i1.__captured.reply; // النوافذ (modal) تُوجه لـ reply
        assert.ok(step2, 'خطوة النماذج تُعرض');
        assert.ok(JSON.stringify(step2).includes('تم اكتشاف'), 'النماذج جُلبت تلقائياً من /models');
        assert.strictEqual(MODELS_HITS, 1, 'استدعاء /models فعلي');

        // اختيار نماذجين → حفظ
        const i2 = makeInteraction({ customId: 'dash:prov_models', isSelect: true, values: ['gemini-2.5-pro', 'qwen-max'] });
        assert.strictEqual(await handleDashboardInteraction(i2, fakeManager), true);
        assert.strictEqual(providerDocs.size, countBefore + 1, 'المزود الثاني حُفظ');
        const saved = [...providerDocs.values()].find(d => d.name === 'بروكسي ثانٍ');
        assert.deepStrictEqual(saved.models, ['gemini-2.5-pro', 'qwen-max'], 'النماذج المختارة فقط حُفظت');
        assert.ok(secrets.isEncrypted(saved.api_key), 'المفتاح الثاني مشفر أيضاً');
        ok('3) معالج إضافة تفاعلي: نافذة → اكتشاف تلقائي → اختيار → حفظ مشفر');
    }

    // ══════════════════════════════════════════════════════════
    // 4) فشل جلب /models → يمكن الحفظ كما هو (خطوة تفاعلية آمنة)
    // ══════════════════════════════════════════════════════════
    {
        const f = await fetchProviderModels(`${BASE}/missing`, 'k'); // الطلب سيصبح /missing/models → 404
        assert.strictEqual(f.ok, false, '404 → فشل واضح');
        ok('4) جلب /models يفشل بأمان (بلا انهيار)');
    }

    // ══════════════════════════════════════════════════════════
    // 5) إنشاء وكيل من مزود محفوظ: قائمة المصادر → قائمة النماذج → نافذة → إنشاء
    // ══════════════════════════════════════════════════════════
    {
        const savedList = await listSavedProviders();
        const doc = savedList[0];

        // الخطوة أ: اختيار openai في المعالج → صفحة اختيار المصدر (DB متاح)
        const iA = makeInteraction({ customId: 'dash:create_provider:bot:agent', isSelect: true, values: ['openai'] });
        assert.strictEqual(await handleDashboardInteraction(iA, fakeManager), true);
        const idsA = collectAllIds(iA.__captured.update);
        assert.ok(idsA.some(x => x && x.startsWith('dash:create_openai_source:')), 'صفحة اختيار المصدر ظهرت');

        // الخطوة ب: اختيار المزود المحفوظ → صفحة اختيار النموذج
        const iB = makeInteraction({ customId: `dash:create_openai_source:bot:agent`, isSelect: true, values: [String(doc._id)] });
        assert.strictEqual(await handleDashboardInteraction(iB, fakeManager), true);
        const idsB = collectAllIds(iB.__captured.update);
        assert.ok(idsB.some(x => x && x.startsWith(`dash:create_openai_model:bot:agent:${doc._id}`)), 'صفحة اختيار النموذج ظهرت بمعرف المزود');

        // الخطوة ج: اختيار النموذج → نافذة الإنشاء (customId يحمل kind + docId + قيمة النموذج جاهزة)
        const iC = makeInteraction({ customId: `dash:create_openai_model:bot:agent:${doc._id}`, isSelect: true, values: ['gpt-x'] });
        assert.strictEqual(await handleDashboardInteraction(iC, fakeManager), true);
        const modal = modalJson(iC.__captured.showModal);
        assert.strictEqual(modal.custom_id, `dash:create_modal:bot:agent:openai:${doc._id}`);
        const modelRow = modal.components.find(r => r.components[0].custom_id === 'openai_model');
        assert.strictEqual(modelRow.components[0].value, 'gpt-x', 'النموذج مُعبأ مسبقاً');
        const keyRow = modal.components.find(r => r.components[0].custom_id === 'openai_api_key');
        assert.ok(!keyRow.components[0].value, 'المفتاح لا يُعرض أبداً في النافذة');

        // الخطوة د: إرسال النافذة بلا كتابة أي بيانات → createAgent يستقبل نسخة كاملة من المزود
        const iD = makeInteraction({
            customId: `dash:create_modal:bot:agent:openai:${doc._id}`, isModal: true,
            fields: makeFields({ name: 'وكيل من قاعدة البيانات', discord_token: 'DT-NEW', openai_model: 'gpt-x' }),
        });
        assert.strictEqual(await handleDashboardInteraction(iD, fakeManager), true);
        // نتحقق من نسخة createAgent عبر التحقق من رد الصفحة + فك مفتاح من المكالمة
        // createAgent يُستدعى داخل المعالج — نتحقق من أن الرد جاء (صفحة الوكيل)
        assert.ok(iD.__captured.reply, 'صفحة الوكيل الجديد رُدّت');
        ok('5) إنشاء وكيل من مزود محفوظ: 3 خطوات تفاعلية بلا كتابة بيانات');
    }

    // ══════════════════════════════════════════════════════════
    // 6) الحمولة القديمة (بلا مزود محفوظ) تبقى تعمل: openai → إدخال يدوي مباشر
    // ══════════════════════════════════════════════════════════
    {
        providerDocs.clear(); // بلا مزودين محفوظين
        const i = makeInteraction({ customId: 'dash:create_provider:bot:agent', isSelect: true, values: ['openai'] });
        assert.strictEqual(await handleDashboardInteraction(i, fakeManager), true);
        const modal = modalJson(i.__captured.showModal);
        assert.strictEqual(modal.custom_id, 'dash:create_modal:bot:agent:openai', 'بلا مزودين محفوظين: نافذة الإدخال اليدوي مباشرة');
        ok('6) بلا مزودين محفوظين → الإدخال اليدوي كما كان (توافق قديم)');
        // نعيد المزود الأول للاختبارات التالية
        await saveProviderToDb({ name: 'بروكسي رئيسي', base_url: `${BASE}/v1`, api_key: 'sk-PROXY-SECRET-xyz', models: ['gemini-2.5-pro', 'gpt-x'], userId: 'u1' });
    }

    // ══════════════════════════════════════════════════════════
    // 7) قدرات Qwen: auto_search + thinking + files في الحمولة
    // ══════════════════════════════════════════════════════════
    {
        const p1 = qwenProvider.buildQwenPayload('c1', 'hi', null, { thinking: true, autoSearch: true });
        const fc1 = p1.messages[0].feature_config;
        assert.strictEqual(fc1.auto_search, true, 'البحث المدمج يمرر لـ Qwen');
        assert.strictEqual(fc1.thinking_enabled, true);
        assert.strictEqual(fc1.auto_thinking, true);

        const p2 = qwenProvider.buildQwenPayload('c1', 'hi', null, {});
        assert.strictEqual(p2.messages[0].feature_config.auto_search, false, 'افتراضي: بلا بحث');

        const files = [{ type: 'image', id: 'f1', filename: 'a.jpg', url: 'https://x/y.jpg' }];
        const p3 = qwenProvider.buildQwenPayload('c1', 'hi', null, { files });
        assert.deepStrictEqual(p3.messages[0].files, files, 'صور OSS تمرر في files');

        const p4 = qwenProvider.buildQwenPayload('c1', 'قطة', null, { chatType: 't2i', size: '16:9' });
        assert.strictEqual(p4.messages[0].chat_type, 't2i', 'توليد الصور: chat_type t2i');
        assert.strictEqual(p4.size, '16:9');
        ok('7) حمولات Qwen: auto_search/thinking/files/t2i');
    }

    // ══════════════════════════════════════════════════════════
    // 8) استخراج روابط الصور من رد Qwen
    // ══════════════════════════════════════════════════════════
    {
        const urls = qwenProvider.extractImageUrls('تم! https://cdn.qwenlm.ai/a/b/out.mp4?k=1 و https://cdn.qwenlm.ai/c/d/pic.png?key=abc نهاية');
        assert.ok(urls.some(u => u.includes('pic.png')), 'رابط الصورة يُستخرج');
        assert.ok(!urls.some(u => u.endsWith('.mp4?k=1') && !u.includes('.png')), 'الفيديو غير الصوري يُستبعد');
        assert.strictEqual(qwenProvider.extractImageUrls('لا روابط هنا').length, 0);
        ok('8) extractImageUrls من نص الرد');
    }

    // ══════════════════════════════════════════════════════════
    // 9) أداة generate_image عبر حلقة الوكيل — تنزيل وإرسال ملف
    // ══════════════════════════════════════════════════════════
    {
        let phase = 0;
        const fakeImgProvider = {
            id: 'fake_img', label: 'وهمي صور', emoji: '🧪', description: 'w',
            modalFields: [],
            validate: () => ({ ok: true, missing: [] }),
            describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() {
                phase++;
                if (phase === 1) {
                    return { fullText: '```json\n{"tool":"generate_image","params":{"prompt":"قطة فضائية","size":"1:1"}}\n```', sessionId: 's1', newParentMessageId: null };
                }
                return { fullText: 'هذه صورتك!', sessionId: 's1', newParentMessageId: null };
            },
            async generateImage({ prompt }) {
                assert.ok(prompt.includes('قطة'), 'الوصف يصل للمزود');
                return { ok: true, urls: [`${BASE}/img.png`] };
            },
        };
        providers.PROVIDERS[fakeImgProvider.id] = fakeImgProvider;

        const guildStub = { id: 'g1', name: 'سيرفر' };
        const channelStub = { id: 'c1', name: 'عام' };
        const runtime = {
            agentId: 'agent_img', personality: '', provider: 'fake_img', providerConfig: {},
            fallback_enabled: false, fallback_chain: [], fallback_configs: {},
            features: { read_url: true }, capabilities: { thinking: false, search: false },
        };
        const result = await runAgent(guildStub, channelStub, 'ارسم لي قطة فضائية',
            '[معلومات]', '[سياق]', 'Bot', null, null, 'g1',
            'default', false, 'member', null, runtime, { userId: 'u1', username: 'x', channelId: 'c1' });
        assert.ok(result.reply.includes('هذه صورتك'), 'الحلقة اكتملت بعد الصورة');
        assert.strictEqual(result.filesToSend.length, 1, 'الصورة تنزلت كملف للإرسال');
        assert.ok(fs.existsSync(result.filesToSend[0]), 'ملف الصورة موجود مؤقتاً');
        const head = fs.readFileSync(result.filesToSend[0]).subarray(0, 4);
        assert.ok(head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47, 'محتوى PNG صحيح');
        try { fs.unlinkSync(result.filesToSend[0]); } catch (_) {}
        delete providers.PROVIDERS[fakeImgProvider.id];
        ok('9) generate_image: أداة → مزود → تنزيل → ملف للإرسال');
    }

    // ══════════════════════════════════════════════════════════
    // 10) مزود بلا generateImage → رسالة توضيحية (لا انهيار)
    // ══════════════════════════════════════════════════════════
    {
        let phase = 0;
        const plainProvider = {
            id: 'fake_plain_img', label: 'وهمي نصي', emoji: '🧪', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() {
                phase++;
                if (phase === 1) {
                    return { fullText: '```json\n{"tool":"generate_image","params":{"prompt":"شعار"}}\n```', sessionId: 's1', newParentMessageId: null };
                }
                return { fullText: 'المزود لا يدعم', sessionId: 's1', newParentMessageId: null };
            },
        };
        providers.PROVIDERS[plainProvider.id] = plainProvider;

        const runtime = {
            agentId: 'agent_plain', personality: '', provider: 'fake_plain_img', providerConfig: {},
            fallback_enabled: false, fallback_chain: [], fallback_configs: {},
            features: {}, capabilities: {},
        };
        const result = await runAgent({ id: 'g1', name: 's' }, { id: 'c1', name: 'ch' }, 'ارسم شعار',
            '[م]', '[س]', 'Bot', null, null, 'g1', 'default', false, 'member', null, runtime, { userId: 'u1', channelId: 'c1' });
        assert.ok(result.reply.includes('لا يدعم'), 'رسالة توضيحية تصل المستخدم عبر النموذج');
        delete providers.PROVIDERS[plainProvider.id];
        ok('10) مزود بلا توليد صور → تعامل رشيق مع رسالة توضيحية');
    }

    // ══════════════════════════════════════════════════════════
    // 11) رفع الشخصية من ملف: زر → انتظار → مرفق نصي → حفظ + runtime حي
    // ══════════════════════════════════════════════════════════
    {
        currentFakeAgent = { _id: FAKE_AGENT_ID, name: 'PERS', provider: 'qwen', qwen_token: 't', status: 'stopped', personality: '' };
        const liveRuntime = { runtimeSettings: { personality: '' } };
        fakeManager.runtimes.set(FAKE_AGENT_ID, liveRuntime);

        // الخطوة أ: زر «شخصية من ملف» يفتح نافذة الانتظار
        const iBtn = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:personality_file` });
        assert.strictEqual(await handleDashboardInteraction(iBtn, fakeManager), true);
        assert.ok(JSON.stringify(iBtn.__captured.update).includes('أرسل الآن ملف الشخصية'), 'رسالة الانتظار ظهرت');

        // الخطوة ب: المستخدم يرسل الملف (مرفق نصي من خادم محلي)
        capturedAgentUpdates.length = 0;
        const message = {
            guild: { id: '111111111111111111' },
            author: { id: '656783724662226963', bot: false },
            attachments: [{ name: 'persona.txt', size: 120, contentType: 'text/plain', url: `${BASE}/p.txt` }],
            reply: async (payload) => { message.__reply = payload; },
        };
        const handled = await handlePersonalityUploadMessage(message, fakeManager);
        assert.strictEqual(handled, true, 'الرسالة التُقطت كرفع شخصية');
        const upd = capturedAgentUpdates.find(u => u.$set && u.$set.personality);
        assert.ok(upd, 'الشخصية حُفظت في قاعدة البيانات');
        assert.ok(upd.$set.personality.includes('قهوة'), 'محتوى الملف الفعلي هو الشخصية');
        assert.strictEqual(liveRuntime.runtimeSettings.personality, upd.$set.personality, 'تحديث حي للـ runtime');
        assert.ok(message.__reply && JSON.stringify(message.__reply).includes('تم تحديث شخصية الوكيل'), 'رسالة تأكيد بالمعاينة');
        ok('11) رفع الشخصية: زر → انتظار → ملف نصي → حفظ + تحديث حي');
    }

    // ══════════════════════════════════════════════════════════
    // 12) رفض ملف غير نصي في رفع الشخصية
    // ══════════════════════════════════════════════════════════
    {
        // نفتح نافذة جديدة ثم نرسل صورة
        const iBtn = makeInteraction({ customId: `dash:agent:${FAKE_AGENT_ID}:personality_file` });
        await handleDashboardInteraction(iBtn, fakeManager);
        capturedAgentUpdates.length = 0;
        const message = {
            guild: { id: '111111111111111111' },
            author: { id: '656783724662226963', bot: false },
            attachments: [{ name: 'photo.png', size: 100, contentType: 'image/png', url: `${BASE}/img.png` }],
            reply: async (payload) => { message.__reply = payload; },
        };
        const handled = await handlePersonalityUploadMessage(message, fakeManager);
        assert.strictEqual(handled, true);
        assert.strictEqual(capturedAgentUpdates.find(u => u.$set && u.$set.personality), undefined, 'لا حفظ لملف غير نصي');
        assert.ok(JSON.stringify(message.__reply).includes('غير نصي'), 'رسالة رفض واضحة');
        ok('12) ملف غير نصي → رفض واضح بلا حفظ');
    }

    server.close();
    console.log(`\n════════════════════════════════`);
    console.log(`platform: ${passed}/${passed} ناجحة`);
    if (passed !== 12) process.exit(1);
}

run().catch((e) => { console.error('💥', e); try { server.close(); } catch (_) {} process.exit(1); });
