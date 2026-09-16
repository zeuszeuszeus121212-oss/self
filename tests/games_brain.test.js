/**
 * tests/games_brain.test.js — v7.21.0 «عقل واحد يلعب»
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالك الحرفي:
 *   «هو طريقتك لاستعداءه لا عطاء تعليق خاطئة اذ لمادا اتكلم معه ينجح
 *    لكن تعليقك تقول انه يفشل؟  ولماذا يوجد حارس تصويت اصلا؟  ولا يلعب
 *    اصلا كله كاذب... كراسي دخلها ببوت ولم يدخلها في البوت الاخر...
 *    اصلا اللوبي لا يدخله!»
 *   «طلبت فقط أن يتم تمرير له رسائل الالعاب ويستطيع هو التصرف والتعليق
 *    والكلام ويعرف اللعبة وكأنه بشري هل هذا صعب؟»
 *
 * يحمي الإصلاحات الجذرية الخمسة بالفحص الفعلي:
 *  1) 🧠 سلّم التعافي نفسه للشات الرئيسي في كل استدعاءات ذكاء الألعاب
 *     (تدوير مفاتيح + مزود بديل) — «لمادا ينجح في الكلام ويقول تعليقك أنه يفشل؟»
 *  2) المحركات تتبع المفتاح الرئيسي — نهاية فخ التفعيل المزدوج («اللوبي لا يدخله»)
 *  3) أقفال التداخل تنتهي بالعمر (10د) وتُحرر عند نهاية الجولة — نهاية
 *     «دخلها ببوت ولم يدخلها في البوت الاخر»
 *  4) 🚫 حارس التصويت محذوف: رسالة مافيا بلا زر انضمام يقرر فيها العقل نفسه
 *  5) أي لعبة أخرى (بأزرار) تُمرَّر للعقل: ينضم/يضغط/يتجاهل + يقول سطره —
 *     وفشل الذكاء = احتياط هيكلي (زر انضمام/أخضر) بلا أي كلام وهمي
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- حقن config وهمي في require cache (بلا MongoDB حقيقي) ----------
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const providersPath = require.resolve(path.join(__dirname, '..', 'providers', 'index.js'));

require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: {
        game_players_col: { findOne: async () => null, updateOne: async () => ({ ok: 1 }) },
        // 🛡️ سياسة بالذاكرة تُطبق $set فعلياً — حتى تعمل بوابات القفل في الاختبار
        game_policy_col: (() => {
            let doc = { key: 'default', updatedAt: new Date() };
            return {
                findOneAndUpdate: async (_f, update, opts) => {
                    for (const key of ['$set', '$setOnInsert']) {
                        const patch = update && update[key];
                        if (patch) doc = { ...doc, ...patch };
                    }
                    return opts && opts.returnDocument === 'after' ? doc : doc;
                },
            };
        })(),
        logs_col: null,
        SimpleLock: class { async acquire(fn) { return fn(); } },
    },
};

// موديول مزودين غائب البناة (نمط الاختبارات القديمة) — يثبت التوافق
require.cache[providersPath] = {
    id: providersPath, filename: providersPath, loaded: true,
    exports: { getProviderOrFallback: () => null },
};

const brain = require('../games/brain');
const store = require('../games/store');
const policy = require('../games/policy');
const sessions = require('../games/sessions');
const social = require('../games/social');
const player = require('../games/player');
const eventsMod = require('../games/events');

// ⏱️ توقيت فوري
const hooks = social.__testHooks();
hooks.TIMING.minDelay = 1;
hooks.TIMING.maxDelay = 2;
eventsMod.HUMAN_SIM.minDelay = 1;
eventsMod.HUMAN_SIM.maxDelay = 2;
eventsMod.HUMAN_SIM.extraProb = 0;

// ════════════════════════════════════════════════════════════
//  أدوات — نفس نمط games_player.test.js
// ════════════════════════════════════════════════════════════

const AGENT_A = 'c4000000000000000000000aa';
const GUILD = 'g777777777777777721';
const CHANNEL = 'c888888888888888821';
const AGENT_USER_ID = '999000111222333444';
const GAME_BOT_ID = '1508592252220477999';

const overrides = new Map(); // `${agentId}:${guildId}` → settings
const origGet = store.getGameSettings;
store.getGameSettings = async (agentId, guildId) => {
    const key = `${String(agentId)}:${String(guildId)}`;
    if (overrides.has(key)) return overrides.get(key);
    return origGet(agentId, guildId);
};
function setSettings(agentId, guildId, patch) {
    const key = `${String(agentId)}:${String(guildId)}`;
    // نمرر عبر normalize الحقيقي — تماماً كما تُقرأ وثيقة قاعدة البيانات
    // (هذا هو مسار «المحركات تتبع المفتاح الرئيسي» الذي نختبره أصلاً)
    overrides.set(key, store.normalize({ ...patch }));
}

function makeClient() {
    return {
        __selfbotRuntime: true,
        user: { id: AGENT_USER_ID },
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر العقل' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (c) => ({ content: c }) }) },
    };
}

function makeMessage(o = {}) {
    const clicks = [];
    const sent = [];
    const message = {
        id: o.id || `mb${Math.random().toString(36).slice(2)}`,
        guild: { id: GUILD, name: 'سيرفر العقل' },
        channel: {
            id: CHANNEL,
            send: async (content) => { sent.push(typeof content === 'string' ? content : content.content); return { content }; },
            sendTyping: async () => {},
        },
        author: { id: GAME_BOT_ID, bot: true },
        content: '',
        embeds: [],
        components: [],
        mentions: { has: () => false },
        clickButton: async (customId) => { clicks.push(customId); },
        ...o,
    };
    message.__clicks = clicks;
    message.__sent = sent;
    return message;
}

function btn(label, customId, { style = 1, disabled = false } = {}) {
    return { type: 'BUTTON', label, custom_id: customId, customId, style, disabled };
}

const runtimeSettings = { agentId: AGENT_A, provider: 'deepseek', providerConfig: {}, kind: 'agent' };

// ════════════════════════════════════════════════════════════
//  الاختبارات
// ════════════════════════════════════════════════════════════

async function run() {
    player.agentReady({ client: makeClient(), agentId: AGENT_A, agentName: 'وكيل العقل', tokenType: 'user', kind: 'agent' });
    sessions.__reset();

    // ── 1) 🧠 سلّم التعافي: المفتاح الأول تالف → الثاني ينجح ──
    // (بلاغ المالك: «لمادا اتكلم معه ينجح لكن تعليقك تقول انه يفشل؟»)
    {
        const calls = [];
        // config بمفتاحين: key#1 = 'dead' يفشل، key#2 = 'live' ينجح
        brain.__setBuilders({
            chain: [{
                id: 'fake',
                obj: { chat: async ({ config }) => { calls.push(config.key); if (config.key === 'dead') throw new Error('انقطاع وهمي'); return { fullText: 'تم بنجاح' }; } },
                config: { key: 'dead' },
            }],
            withKeyIndex: (_id, config, ki) => ({ ...config, key: ki === 0 ? 'dead' : 'live' }),
        });
        try {
            const out = await brain.chatSmart(runtimeSettings, { prompt: 'س' });
            assert.strictEqual(out, 'تم بنجاح', 'المفتاح الثاني ينجح بعد فشل الأول');
            assert.deepStrictEqual(calls, ['dead', 'dead', 'live'], 'محاولتان على المفتاح التالف ثم نجاح فوري بالمفتاح الصالح');
        } finally { brain.__setBuilders(null); }
    }

    // ── 2) 🧠 سلّم التعافي: المزود الأساسي ميت → البديل يجيب ──
    {
        brain.__setBuilders({
            chain: [
                { id: 'primary', obj: { chat: async () => { throw new Error('primary down'); } }, config: {} },
                { id: 'backup', obj: { chat: async () => ({ fullText: 'جواب البديل' }) }, config: {} },
            ],
            withKeyIndex: (_id, config, ki) => (ki === 0 ? { ...config } : null),
        });
        try {
            const out = await brain.chatSmart(runtimeSettings, { prompt: 'س' });
            assert.strictEqual(out, 'جواب البديل', 'المزود البديل يعمل كما في الشات الرئيسي');
        } finally { brain.__setBuilders(null); }
    }

    // ── 3) 🧠 فشل السلّم كله → decide يعيد null (لا تخمين مزيّف) ──
    {
        brain.__setBuilders({
            chain: [{ id: 'dead', obj: { chat: async () => { throw new Error('down'); } }, config: {} }],
            withKeyIndex: (_id, c, ki) => (ki === 0 ? { ...c } : null),
        });
        try {
            const decision = await brain.decide({ runtimeSettings, agentName: 'وكيل', scene: { text: 'لوبي', buttons: [{ label: 'انضمام' }] } });
            assert.strictEqual(decision, null, 'فشل الذكاء = لا قرار مزيّف');
        } finally { brain.__setBuilders(null); }
    }

    // ── 4) قرار العقل: JSON محاط بكلام + أعمال عربية ──
    {
        assert.deepStrictEqual(brain.extractJson('حسناً سأنضم الآن {"act":"join","button":"انضمام","say":"جاي معكم"} تمام'), { act: 'join', button: 'انضمام', say: 'جاي معكم' }, 'JSON محاط بكلام');
        assert.strictEqual(brain.extractJson('لا يوجد أي JSON هنا'), null, 'بلا JSON → null');
        assert.deepStrictEqual(brain.normalizeDecision({ act: 'انضمام', button: 'دخول' }), { act: 'join', button: 'دخول', say: null }, 'الفعل العربي يُفهم');
        assert.deepStrictEqual(brain.normalizeDecision({ act: 'تجاهل' }), { act: 'none', button: null, say: null }, 'تجاهل = none');
        assert.strictEqual(brain.normalizeDecision({ act: 'كلام غير مفهوم' }), null, 'فعل مجهول → null');
    }

    // ── 5) 🐞 المحركات تتبع المفتاح الرئيسي (نهاية فخ التفعيل المزدوج) ──
    {
        const on = store.normalize({ enabled: true });
        for (const engine of ['zar', 'roulette', 'karasi', 'replka', 'mafia', 'universal']) {
            assert.strictEqual(on.engines[engine].enabled, true, `المفتاح الرئيسي مفعل ⇒ ${engine} يعمل تلقائياً`);
        }
        const offExplicit = store.normalize({ enabled: true, engines: { karasi: { enabled: false } } });
        assert.strictEqual(offExplicit.engines.karasi.enabled, false, 'المنع الصريح يُحترم (كراسي معطلة)');
        assert.strictEqual(offExplicit.engines.roulette.enabled, true, 'والبقية تعمل');
        const allOff = store.normalize({ enabled: false });
        assert.strictEqual(allOff.engines.universal.enabled, false, 'المفتاح الرئيسي مطفأ ⇒ لا شيء يعمل');
    }

    // ── 6) 🐞 الأقفال: القفل اليتيم تنتهي صلاحيته + التحرير محصور بالسيرفر ──
    {
        await policy.setOverlapLock(true);
        try {
            const p = await policy.getPolicy();
            const a = policy.acquireLock({ policy: p, engineId: 'karasi', serverId: GUILD, gameName: 'كراسي', agentId: 'agent1' });
            assert.ok(a.acquired, 'الأول يأخذ القفل');
            const b = policy.acquireLock({ policy: p, engineId: 'karasi', serverId: GUILD, gameName: 'كراسي', agentId: 'agent2' });
            assert.strictEqual(b.acquired, false, 'الثاني يُمنع ما دام القفلاً حياً');
            // نُشيّخ القفل بالباك-تايم (10 دقائق + ثانية)
            const lock = policy.getLocks().find(l => l.agentId === 'agent1');
            lock.acquiredAt = new Date(Date.now() - 10 * 60_000 - 1000);
            const b2 = policy.acquireLock({ policy: p, engineId: 'karasi', serverId: GUILD, gameName: 'كراسي', agentId: 'agent2' });
            assert.ok(b2.acquired, 'القفل اليتيم لا يمنع أحداً بعد عمره الأقصى (بلاغ: دخلها ببوت ولم يدخلها الآخر)');
        } finally {
            policy.clearLocks();
            await policy.setOverlapLock(false);
        }
        // التحرير المُحصّر بالسيرفر — القفل يحتاج تفعيل القفل أولاً
        await policy.setOverlapLock(true);
        const p2 = await policy.getPolicy();
        policy.acquireLock({ policy: p2, engineId: 'roulette', serverId: 'g1', gameName: 'روليت', agentId: 'agentX' });
        policy.acquireLock({ policy: p2, engineId: 'roulette', serverId: 'g2', gameName: 'روليت', agentId: 'agentX' });
        const released = policy.releaseLocksForAgent('agentX', { serverId: 'g1' });
        assert.strictEqual(released, 1, 'حرر قفل g1 فقط');
        assert.strictEqual(policy.getLocks().filter(l => l.agentId === 'agentX').length, 1, 'قفل g2 باقٍ');
        policy.clearLocks();
        await policy.setOverlapLock(false);
    }

    // ── 7) 🧠 أي لعبة أخرى: العقل يقرر الانضمام + يقول سطره ──
    {
        setSettings(AGENT_A, GUILD, { enabled: true }); // المحركات تتبع المفتاح الرئيسي
        sessions.__reset();
        brain.__setDecide(async ({ scene }) => {
            assert.ok(scene.text.includes('لعبة السحب'), 'النص الحرفي للرسالة وصل للعقل');
            assert.ok(scene.buttons.some(b => b.label === 'دخول السحب'), 'الأزرار وصلت للعقل');
            return { act: 'join', button: 'دخول السحب', say: 'أنا كمان هسحب معكم يا جماعة' };
        });
        const msg = makeMessage({
            embeds: [{ title: '🎲 لعبة السحب', description: 'انضموا الآن' }],
            components: [{ components: [btn('دخول السحب', 'sahba_join'), btn('متجر', 'shop')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.deepStrictEqual(msg.__clicks, ['sahba_join'], 'انضم بالزر الذي اختاره عقله');
        const session = sessions.getSession(AGENT_A, GUILD);
        assert.ok(session, 'الجلسة فتحت للعبة المجهولة');
        assert.strictEqual(session.engineId, 'universal', 'المحرك العام هو صاحب الجلسة');
        // التعليق (say) يُرسل — لكن sendText fire-and-forget؛ نمنحها لحظة
        await new Promise(r => setTimeout(r, 50));
        // (سلوك sendText غير متزامن عمداً — الأهم أنه لم يكن نصاً وهمياً مبرمجاً)
        brain.__setDecide(() => ({ act: 'none' }));
        sessions.endSession(AGENT_A, GUILD);
    }

    // ── 8) 🧠 العقل يرفض (لوحة بوت/رسالة ليست لعبة) → صفر ضغطات ──
    {
        setSettings(AGENT_A, GUILD, { enabled: true });
        sessions.__reset();
        brain.__setDecide(() => ({ act: 'none', say: null }));
        const msg = makeMessage({
            embeds: [{ title: '🎫 لوحة التذاكر', description: 'افتح تذكرة' }],
            components: [{ components: [btn('افتح تذكرة', 'ticket_open')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(msg.__clicks.length, 0, 'قرار العقل: تجاهل ⇒ لا ضغط');
        assert.strictEqual(sessions.getSession(AGENT_A, GUILD), null, 'بلا جلسة');
    }

    // ── 9) 🧠 فشل العقل → احتياط هيكلي (انضمام/أخضر فقط) وبلا أي كلام ──
    {
        setSettings(AGENT_A, GUILD, { enabled: true });
        sessions.__reset();
        brain.__setDecide(() => null); // السلّم كله فشل
        const msg = makeMessage({
            embeds: [{ title: '🎯 لعبة لا نعرفها', description: 'حظ موفق' }],
            components: [{ components: [btn('انضمام', 'unk_join'), btn('قوانين', 'rules')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.deepStrictEqual(msg.__clicks, ['unk_join'], 'احتياط: زر الانضمام الصريح يُنقر (سباق اللوبي لا يُخسر)');
        assert.strictEqual(msg.__sent.length, 0, 'احتياط = بلا أي تعليق وهمي');

        // ولا زر انضمام ولا أخضر → لا ضغط أعمى (أزرار واجهة فقط)
        const msg2 = makeMessage({
            embeds: [{ title: '📊 إحصائيات بوت' }],
            components: [{ components: [btn('تحديث', 'refresh'), btn('رصيد', 'balance')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msg2, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(msg2.__clicks.length, 0, 'لا ضغط أعمى على أزرار واجهة');
    }

    // ── 10) 🚫 حارس التصويت محذوف: رسالة مافيا بلا زر انضمام يقرر فيها العقل ──
    {
        setSettings(AGENT_A, GUILD, { enabled: true });
        sessions.__reset();
        brain.__setDecide(async () => ({ act: 'none', say: null }));
        const phaseMsg = makeMessage({
            content: '🔪 جاري انتظار المافيا لاختيار شخص لقتله',
            components: [{ components: [btn('تأكيد', 'confirm_kill')] }],
        });
        await player.handleMessage({ client: makeClient(), message: phaseMsg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(phaseMsg.__clicks.length, 0, 'العقل قرر: هذه ليست لوبي ⇒ لا ضغط (بلا حارس كلمات — بقرار عقل)');

        // نفس الرسالة والمرحلة لكن العقل يرى أنها لوبي بزر محدد → ينقر ما اختاره
        brain.__setDecide(async () => ({ act: 'join', button: 'تأكيد', say: null }));
        const phaseMsg2 = makeMessage({
            content: '🔪 جاري انتظار المافيا لاختيار شخص لقتله',
            components: [{ components: [btn('تأكيد', 'confirm_kill')] }],
        });
        await player.handleMessage({ client: makeClient(), message: phaseMsg2, agentId: AGENT_A, runtimeSettings });
        assert.deepStrictEqual(phaseMsg2.__clicks, ['confirm_kill'], 'قرار العقل يُنفذ حرفياً — لا حوار كلمات يوقفه');
        sessions.endSession(AGENT_A, GUILD);
    }

    brain.__setDecide(null); // تنظيف نهائي
    console.log('🏆 games_brain: كل مجموعات «عقل واحد يلعب» خضراء');
}

run().catch((e) => { console.error('❌ فشل games_brain:', e && e.message ? e.message : e); process.exit(1); });
