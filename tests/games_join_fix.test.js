/**
 * tests/games_join_fix.test.js — انحدار v7.19.0 الذي أفقد الوكيل كل الألعاب (v7.20)
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالك الحرفي:
 *   «بعد تعديلك الاخير أصبح لا يدخل اي لعبة اصلا سواء مافيا او روليت وغيرها
 *    اي رسالة لوبي من الألعاب لا يدخلها
 *    ووليت بعض الأحيان دخل لكنه لا يلعب لا يستطيع الطرد اصلا»
 *
 * الجذور المُصلحة ويحميها هذا الملف:
 *  1) لوبي المافيا نصّه يذكر «التصويت/الطرد» (قواعد اللعبة) → كان يُرفض
 *     بحارس looksLikeVote فلا انضمام أبداً. الآن: زر انضمام صريح = لوبي مهما
 *     ذُكر في النص (التمييز هيكلي لا لفظي).
 *  2) رسالة تصويت أثناء جلسة حية → ضغطة تصويت واحدة (حارس الجلسة الحية
 *     يغني عن الرفض اللفظي — ورسالة التصويت بلا زر انضمام تبقى مرفوضة عن اللوبي).
 *  3) رسالة تصويت بلا جلسة → صفر ضغطات (لا نقر أسماء في جولة لسنا فيها).
 *  4) روليت: منشن الدور داخل الإيمبد → كان لا يُرى (فحص content فقط) فلا يلعب
 *     أبداً — الآن النص الكامل.
 *  5) فشل نقرة واحدة → إعادة محاولة (كان يُسقط الانضمام كله بلا محاولة ثانية).
 *  6) «انتهت اللعبة» تغلق الجلسة المعلقة → لوبي الجولة التالية ينضم.
 *  7) التشخيص المرئي: لوبي ظاهر ولم ننضم → سبب الرفض في سجل الأحداث (مرة/90ث).
 *  8) تعطل سياسة الألعاب → fail-open (كان يبتلع الخطأ فيتخطى كل الألعاب بصمت).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- حقن config ومزود وهمي قبل أي تتطلب ----------

const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const providersPath = require.resolve(path.join(__dirname, '..', 'providers', 'index.js'));

const prompts = [];
let aiReply = 'خالد';
const fakeProvider = {
    chat: async ({ prompt }) => { prompts.push(String(prompt)); return { fullText: aiReply }; },
};
require.cache[providersPath] = {
    id: providersPath, filename: providersPath, loaded: true,
    exports: { getProviderOrFallback: () => fakeProvider },
};

require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: {
        game_players_col: { findOne: async () => null, updateOne: async () => ({ ok: 1 }) },
        game_policy_col: { findOneAndUpdate: async () => ({}) },
        logs_col: null,
        SimpleLock: class { async acquire(fn) { return fn(); } },
    },
};

const store = require('../games/store');
const sessions = require('../games/sessions');
const social = require('../games/social');
const player = require('../games/player');
const eventsMod = require('../games/events');
const policy = require('../games/policy');

const AGENT = 'd400000000000000000000dd';
const GUILD = 'g999999999999999999';
const CHANNEL = 'c777777777777777777';
const AGENT_USER_ID = '999000111222333444';
const AGENT_NAME = 'وكيل الألعاب';
const BOT_ID = '1508592252220477651';
const P1 = '666000111222333711';
const P2 = '666000111222333722';

const runtimeSettings = { provider: 'deepseek', providerConfig: {}, kind: 'agent', personality: 'لاعب مرح', agentId: AGENT };

// ⏱️ توقيت فوري + احتمالات مؤكدة — اختبارات حتمية
const hooks = social.__testHooks();
hooks.TIMING.minDelay = 1;
hooks.TIMING.maxDelay = 2;
for (const key of Object.keys(hooks.CHANCES)) hooks.CHANCES[key] = 1.0;
eventsMod.HUMAN_SIM.skip = 0;
eventsMod.HUMAN_SIM.minDelay = 1;
eventsMod.HUMAN_SIM.maxDelay = 2;
eventsMod.HUMAN_SIM.extraProb = 0;

// ---------- إعدادات بالذاكرة ----------

const overrides = new Map();
const origGet = store.getGameSettings;
store.getGameSettings = async (agentId, guildId) => {
    const key = `${String(agentId)}:${String(guildId)}`;
    if (overrides.has(key)) return overrides.get(key);
    return origGet(agentId, guildId);
};

function setSettings(patch) {
    const base = store.defaultSettings();
    base.enabled = true;
    base.social = { enabled: false };
    base.engines.mafia = { enabled: true, mode: 'auto', delay: 0, roundTimeout: 300 };
    base.engines.roulette = { enabled: true, mode: 'auto', delay: 0, roundTimeout: 60 };
    overrides.set(`${AGENT}:${GUILD}`, { ...base, ...patch });
}

function makeClient() {
    const sent = [];
    const client = {
        __selfbotRuntime: true,
        user: { id: AGENT_USER_ID },
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر الإصلاح' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (c) => ({ content: c }) }) },
        __sent: sent,
        __clicks: [],
    };
    return client;
}

function makeMessage(client, overridesMsg = {}) {
    return {
        id: overridesMsg.id || `m${Math.random().toString(36).slice(2)}`,
        guild: { id: GUILD, name: 'سيرفر الإصلاح' },
        channel: {
            id: CHANNEL,
            send: async (c) => { client.__sent.push(c); return { content: c }; },
        },
        author: { id: BOT_ID, bot: true },
        content: '',
        embeds: [],
        components: [],
        mentions: { has: () => false, users: new Map() },
        clickButton: async (customId) => { client.__clicks.push(customId); return { ok: true }; },
        ...overridesMsg,
    };
}

function buttonsOf(...defs) {
    return [{ components: defs.map(([label, id]) => ({ type: 2, style: 1, label, customId: id, disabled: false })) }];
}

const settle = (ms = 120) => new Promise(r => setTimeout(r, ms));

async function run() {
    player.agentReady({ client: makeClient(), agentId: AGENT, agentName: AGENT_NAME, tokenType: 'user', kind: 'agent' });

    // ═══ 1) اللوبي الذي نصّه يذكر «التصويت/الطرد» + زر انضمام صريح → ينضم ═══
    // (بلاغ المالك: «اي رسالة لوبي من الألعاب لا يدخلها» — انحدار v7.19 حرفياً)
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        const lobby = makeMessage(client, {
            content: '🎮 لعبة المافيا بدأت! انضموا الآن — بعد الليل سيتم التصويت على طرد المشتبه به',
            embeds: [{ title: '🕵️ مافيا', description: 'قواعد: صوتوا لطرد المافيا قبل أن يقتلكم' }],
            components: buttonsOf(['انضمام', 'join_m1'], ['حقيبتي', 'bag1']),
        });
        await player.handleMessage({ client, message: lobby, agentId: AGENT, runtimeSettings });
        await settle(2600); // تأخير بشري 1-2ث + هامش
        assert.deepStrictEqual(client.__clicks, ['join_m1'], 'اللوبي بقواعد تصويت داخلها → انضم فعلاً (كان يُرفض بv7.19)');
        assert.ok(sessions.getSession(AGENT, GUILD), 'الانضمام فتح جلسة حية');
        console.log('✅ 1) لوبي نصّه يذكر التصويت/الطرد + زر انضمام → انضم فعلاً (انحدار v7.19 انتهى)');
    }

    // ═══ 2) تصويت أثناء جلسة حية → ضغطة تصويت واحدة (لا لوبي ولا ضغط عشوائي) ═══
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        sessions.startSession(AGENT, GUILD, { engineId: 'mafia', channelId: CHANNEL, botId: BOT_ID, gameName: 'مافيا' });
        sessions.setMe(AGENT, GUILD, { id: AGENT_USER_ID, name: AGENT_NAME });
        sessions.mafiaSetPlayers(AGENT, GUILD, [{ id: P1, name: 'خالد' }, { id: P2, name: 'سالم' }]);
        aiReply = 'سالم';
        const vote = makeMessage(client, {
            content: '🕵️ المافيا بينكم… صوتوا على من تظنونه مافيا',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2200);
        assert.deepStrictEqual(client.__clicks, ['btn_s'], 'ضغطة تصويت واحدة من عقله — الجلسة الحية تمنع فهمها لوبياً');
        console.log('✅ 2) تصويت أثناء جلسة حية: ضغطة واحدة (الحارس الهيكلي بديل الرفض اللفظي)');
    }

    // ═══ 3) تصويت بلا جلسة (لسنا في اللعبة) → صفر ضغطات ═══
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        const vote = makeMessage(client, {
            content: '🗳️ صوتوا على من سيُطرد من اللعبة!',
            components: buttonsOf(['خالد', 'k_nosess'], ['سالم', 's_nosess']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(400);
        assert.strictEqual(client.__clicks.length, 0, 'بلا جلسة: لا نقر أسماء في جولة لسنا فيها');
        console.log('✅ 3) تصويت لسنا فيه (بلا جلسة): صفر ضغطات');
    }

    // ═══ 4) روليت: منشن الدور داخل الإيمبد فقط → يلعب ويطرد ═══
    // (بلاغ المالك: «وليت بعض الأحيان دخل لكنه لا يلعب لا يستطيع الطرد اصلا»)
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        sessions.startSession(AGENT, GUILD, { engineId: 'roulette', channelId: CHANNEL, botId: BOT_ID, gameName: 'روليت' });
        sessions.setMe(AGENT, GUILD, { id: AGENT_USER_ID, name: AGENT_NAME });
        aiReply = 'خالد';
        const turn = makeMessage(client, {
            content: '',
            embeds: [{ title: '🎡 روليت', description: `<@${AGENT_USER_ID}> دورك! اختر لاعباً لطرده` }],
            components: buttonsOf(['خالد', 'p_k_embed'], ['سالم', 'p_s_embed']),
        });
        await player.handleMessage({ client, message: turn, agentId: AGENT, runtimeSettings });
        await settle(2200);
        assert.deepStrictEqual(client.__clicks, ['p_k_embed'], 'منشن داخل الإيمبد → لعب فعلاً واختار ضحية الطرد (كان لا يُرى أبداً)');
        assert.ok(prompts.some(p => p.includes('روليت')), 'استُشير عقله بقرار الطرد');
        console.log('✅ 4) روليت بمنشن داخل الإيمبد: لعب واختار من يُطرد (الفحص صار على النص الكامل)');
    }

    // ═══ 5) فشل النقرة مرة → إعادة محاولة → انضمام ═══
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        let failedOnce = false;
        const lobby = makeMessage(client, {
            content: '🎡 روليت — اللوبي مفتوح',
            components: buttonsOf(['انضمام', 'join_retry']),
            clickButton: async (customId) => {
                if (!failedOnce) { failedOnce = true; throw new Error('button stale'); }
                client.__clicks.push(customId);
                return { ok: true };
            },
        });
        await player.handleMessage({ client, message: lobby, agentId: AGENT, runtimeSettings });
        await settle(3600); // تأخير بشري + 700ms إعادة المحاولة
        assert.deepStrictEqual(client.__clicks, ['join_retry'], 'النقرة الفاشلة أعيدت فنجح الانضمام (كان يُسقط المعالج كله)');
        assert.ok(sessions.getSession(AGENT, GUILD), 'الجلسة فُتحت بعد إعادة المحاولة');
        console.log('✅ 5) فشل نقرة واحدة → إعادة محاولة → انضم («بعض الأحيان دخل» انتهى)');
    }

    // ═══ 6) «انتهت اللعبة» تغلق الجلسة المعلقة → اللوبي التالي ينضم ═══
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        sessions.startSession(AGENT, GUILD, { engineId: 'mafia', channelId: CHANNEL, botId: BOT_ID, gameName: 'مافيا' });
        const endMsg = makeMessage(client, { content: '🏁 انتهت اللعبة! شكراً للجميع' });
        await player.handleMessage({ client, message: endMsg, agentId: AGENT, runtimeSettings });
        await settle(200);
        assert.strictEqual(sessions.getSession(AGENT, GUILD), null, 'نهاية الجولة أغلقت الجلسة المعلقة (كانت تعيش 45د)');
        // اللوبي التالي ينضم فوراً
        const nextLobby = makeMessage(client, {
            content: '🎮 جولة مافيا جديدة! انضموا الآن',
            components: buttonsOf(['انضمام', 'join_next']),
        });
        await player.handleMessage({ client, message: nextLobby, agentId: AGENT, runtimeSettings });
        await settle(2600);
        assert.deepStrictEqual(client.__clicks, ['join_next'], 'اللوبي التالي بعد نهاية الجولة → انضم فوراً');
        console.log('✅ 6) «انتهت اللعبة» أغلقت الجلسة واللوبي التالي انضم فوراً');
    }

    // ═══ 7) التشخيص المرئي: لوبي ظاهر ولم ننضم → السبب في السجل (مرة/90ث) ═══
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        // رسالة روليت موجّهة للوكيل (تعبر بوابة rouletteJoin مبكراً) وبلا جلسة
        // (يمنع roulettePlay) → لا معالج يتحرك → كان صمتاً كلياً
        const ghost = makeMessage(client, {
            content: `🎡 روليت — <@${AGENT_USER_ID}> جاهز؟`,
            components: buttonsOf(['زر_غامض', 'ghost_btn']),
        });
        const before = store.getRecentEvents(AGENT).filter(e => String(e.text || '').includes('🩺 لوبي روليت')).length;
        await player.handleMessage({ client, message: ghost, agentId: AGENT, runtimeSettings });
        await settle(300);
        const after1 = store.getRecentEvents(AGENT).filter(e => String(e.text || '').includes('🩺 لوبي روليت')).length;
        assert.strictEqual(after1, before + 1, 'لوبي ظاهر ولم ننضم → سبب مرئي في السجل (كان صمتاً)');
        const ghost2 = makeMessage(client, {
            id: 'ghost2',
            content: `🎡 روليت — <@${AGENT_USER_ID}> جاهز مرة أخرى؟`,
            components: buttonsOf(['زر_غامض', 'ghost_btn2']),
        });
        await player.handleMessage({ client, message: ghost2, agentId: AGENT, runtimeSettings });
        await settle(300);
        const after2 = store.getRecentEvents(AGENT).filter(e => String(e.text || '').includes('🩺 لوبي روليت')).length;
        assert.strictEqual(after2, after1, 'التشخيص مقيّد بمرة كل 90ث — لا إزعاج');
        console.log('✅ 7) التشخيص المرئي للوبي غير المنضم + تقييد 90ث');
    }

    // ═══ 8) تعطل سياسة الألعاب → fail-open: الألعاب تعمل (كانت تُحجب كلها بصمت) ═══
    {
        sessions.__reset();
        setSettings({});
        const client = makeClient();
        const originalGetPolicy = policy.getPolicy;
        policy.getPolicy = async () => { throw new Error('mongo down'); };
        try {
            const lobby = makeMessage(client, {
                content: '🎡 روليت — دخول سريع',
                components: buttonsOf(['انضمام', 'join_policy']),
            });
            await player.handleMessage({ client, message: lobby, agentId: AGENT, runtimeSettings });
            await settle(2600);
            assert.deepStrictEqual(client.__clicks, ['join_policy'], 'تعطل السياسة → fail-open → انضم (كان كل الألعاب تُتخطى بصمت)');
            assert.ok(sessions.getSession(AGENT, GUILD), 'الجلسة فُتحت رغم تعطل السياسة');
        } finally {
            policy.getPolicy = originalGetPolicy;
        }
        console.log('✅ 8) تعطل سياسة الألعاب: fail-open مرئي بدل الحجب الصامت لكل الألعاب');
    }

    console.log('\n🏆 games_join_fix: كل مجموعات انحدار v7.19.0 خضراء — اللوبي يعود والروليت يلعب');
}

run().then(() => process.exit(0)).catch((error) => {
    console.error('\n❌ فشل games_join_fix:', error && error.message);
    process.exit(1);
});
