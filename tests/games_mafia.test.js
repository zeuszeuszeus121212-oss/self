/**
 * tests/games_mafia.test.js — لعبة المافيا + وضع الذكاء/التلقائي (v7.16)
 * ═══════════════════════════════════════════════════════════
 * بلاغات المالك المحمية حرفياً:
 *  1) صفر كسر: الافتراضي معطل → صفر ضغطات وكلام على كل رسائل المافيا
 *  2) لوبي المافيا: يدخل بالزر الصريح ويسجل اللاعبين — «يعرف من يلعب معه بالضبط وكذلك العدد»
 *  3) توزيع الرتب «✅ | تم توزيع الرتب...» → يتمنى مافيا / يلعن حظه (كلام محتمل)
 *  4) ليل القتل «🔪 | جاري انتظار المافيا...» → يرجى ألا يُقتل (المافيا نفسها صامتة)
 *  5) دور الطبيب «💊 | جاري انتظار الطبيب...» → «احميني»
 *  6) قتل صديق «⚰️ | نجحت عملية المافيا وتم قتل <@صديق>...» → يندب ويوعد بالثأر
 *  7) موته هو «تم قتل <@هو>» → خسارة صحيحة (لا خسائر مزيفة للوبي) + الجلسة تُغلق
 *  8) التصويت الذكي «لديكم 15 ثانية لاختيار شخص لطرده» + أزرار أسماء → يضغط الاسم
 *     الذي اختاره الذكاء — لا نفسه أبداً
 *  9) التصويت التلقائي (الافتراضي) → عشوائي كما كان
 * 10) لا تصويت مزدوج عندما تتعدل رسالة العداد
 * 11) رسالة سرية على الخاص «اختار شخصا لاغتياله» (مافيا) → يضغط الضحية + الدور يُسجل
 * 12) رسالة سرية على الخاص «اختار شخصا لحمايته» (طبيب) → يضغط المحمي
 * 13) خاص من بوت بلا جلسة مافيا → صفر تدخل (لا نقر أزرار أبحاث غريبة)
 * 14) إعلان الفائزين بقائمة منشنات → فوز صحيح
 * 15) قرار الشك: الصامت طوال الجولة يظهر للذكاء كمشتبه به
 * 16) تخزين الوضع: ai/auto يُحفظان والقيم الغريبة تُرفض (تبقى تلقائي)
 * 17) قاعدة صمت المافيا: صار مافيا → كلامه الاجتماعي يتقلص (×0.12)
 * 18) الروليت: الوضع الذكي → الذكاء يختار من يُطرد؛ التلقائي هو النظام الحالي
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- حقن config ومزود وهمي قبل أي تتطلب ----------

const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const providersPath = require.resolve(path.join(__dirname, '..', 'providers', 'index.js'));

// 🧠 مزود وهمي يلتقط الأوامط ويرد باسم نتحكم فيه
const prompts = [];
let aiReply = 'خالد';
const fakeProvider = {
    chat: async ({ prompt }) => { prompts.push(String(prompt)); return { fullText: aiReply }; },
};
require.cache[providersPath] = {
    id: providersPath, filename: providersPath, loaded: true,
    exports: { getProviderOrFallback: () => fakeProvider },
};

const updateCaptures = [];
require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: {
        game_players_col: {
            findOne: async () => null,
            updateOne: async (filter, update) => { updateCaptures.push(update); return { ok: 1 }; },
        },
        game_policy_col: { findOneAndUpdate: async () => ({}) },
        logs_col: null,
        SimpleLock: class { async acquire(fn) { return fn(); } },
    },
};

const store = require('../games/store');
const sessions = require('../games/sessions');
const social = require('../games/social');
const player = require('../games/player');
// 🧠 v7.21: عزل الاختبارات القديمة من نداءات المزود الحقيقية — العقل الافتراضي في هذه الملفات: تجاهل (والاختبارات المخصصة للعقل في games_brain.test.js)
require('../games/brain').__setDecide(() => ({ act: 'none' }));
const eventsMod = require('../games/events');
const mafia = require('../games/mafia');
const policy = require('../games/policy');

const AGENT = 'c3000000000000000000000cc';
const GUILD = 'g777777777777777777';
const CHANNEL = 'c888888888888888888';
const AGENT_USER_ID = '999000111222333777';
const AGENT_NAME = 'وكيلنا';
const BOT_ID = '1508592252220477651'; // بوت المافيا
const FRIEND_ID = '555000111222333701';
const P1 = '666000111222333711'; // خالد — ثرثار
const P2 = '666000111222333722'; // سالم — صامت

const runtimeSettings = { provider: 'deepseek', providerConfig: {}, kind: 'agent', personality: 'لاعب مرح' };

// ⏱️ توقيت فوري + احتمالات مؤكدة
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

function setSettings(agentId, patch) {
    overrides.set(`${String(agentId)}:${GUILD}`, { ...store.defaultSettings(), ...patch });
}

function withMafia(mode = 'auto') {
    const base = store.defaultSettings();
    base.enabled = true;
    base.social = { enabled: true };
    base.engines.mafia = { enabled: true, mode, delay: 0, roundTimeout: 300 };
    overrides.set(`${AGENT}:${GUILD}`, base);
    return base;
}

function makeClient() {
    const sent = [];
    return {
        __selfbotRuntime: true,
        user: { id: AGENT_USER_ID },
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر المافيا' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (c) => ({ content: c }) }) },
        __sent: sent,
        __clicks: [],
    };
}

/** رسالة بوت في قناة تلتقط الإرسال والضغطات */
function makeMessage(client, overridesMsg = {}) {
    return {
        id: overridesMsg.id || `m${Math.random().toString(36).slice(2)}`,
        guild: { id: GUILD, name: 'سيرفر المافيا' },
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

/** رسالة سرية على الخاص (بلا سيرفر) */
function makeDm(client, overridesMsg = {}) {
    return {
        id: overridesMsg.id || `d${Math.random().toString(36).slice(2)}`,
        guild: null,
        channel: { id: 'dm-channel' },
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
    return [{ components: defs.map(([label, id, disabled]) => ({ type: 2, style: 1, label, customId: id, disabled: Boolean(disabled) })) }];
}

/** جلسة مافيا حية جاهزة (كما لو انضم ووزعت الأدوار) */
function freshMafiaSession(client, { players = [], friends = [] } = {}) {
    sessions.__reset();
    const session = sessions.startSession(AGENT, GUILD, {
        engineId: 'mafia', channelId: CHANNEL, botId: BOT_ID,
        gameName: 'مافيا', guildName: 'سيرفر المافيا',
    });
    if (players.length) sessions.mafiaSetPlayers(AGENT, GUILD, players);
    for (const f of friends) sessions.addFriend(AGENT, GUILD, f);
    return session;
}

const settle = (ms = 90) => new Promise(r => setTimeout(r, ms));

async function run() {
    player.agentReady({ client: makeClient(), agentId: AGENT, agentName: AGENT_NAME, tokenType: 'user', kind: 'agent' });

    // ═══ 1) صفر كسر: الافتراضي معطل — كل رسائل المافيا بلا أي ضغطة ═══
    {
        sessions.__reset();
        const client = makeClient();
        overrides.delete(`${AGENT}:${GUILD}`); // الافتراضي المعطل
        const lobby = makeMessage(client, {
            content: '🎮 لوبي المافيا فتح! الانضمام متاح الآن',
            components: buttonsOf(['انضمام', 'join_btn'], ['حقيبتي', 'bag_btn']),
        });
        await player.handleMessage({ client, message: lobby, agentId: AGENT, runtimeSettings });
        const dm = makeDm(client, { content: 'دورك مافيا — اختار شخصا لاغتياله', components: buttonsOf(['سالم', 'x1']) });
        await player.handleMessage({ client, message: dm, agentId: AGENT, runtimeSettings });
        assert.strictEqual(client.__clicks.length, 0, 'الافتراضي معطل: صفر ضغطات');
        assert.strictEqual(client.__sent.length, 0, 'الافتراضي معطل: صفر كلام');
        console.log('✅ 1) صفر كسر: الافتراضي معطل تماماً');
    }

    // ═══ 2) لوبي المافيا — يدخل بالزر الصريح ويسجل اللاعبين ═══
    {
        sessions.__reset();
        const client = makeClient();
        withMafia('auto');
        const lobby = makeMessage(client, {
            content: '🎮 لوبي المافيا — 6 لاعبين مطلوبين! الانضمام متاح',
            components: buttonsOf(['حقيبتي', 'bag_btn'], ['انضمام', 'join_btn']),
            mentions: {
                has: () => false,
                users: new Map([
                    [P1, { id: P1, username: 'خالد', globalName: 'خالد' }],
                    [P2, { id: P2, username: 'سالم', globalName: 'سالم' }],
                ]),
            },
        });
        await player.handleMessage({ client, message: lobby, agentId: AGENT, runtimeSettings });
        await settle(2200); // تأخير الدخول البشري
        assert.deepStrictEqual(client.__clicks, ['join_btn'], 'ضغط زر الانضمام لا حقيبتي');
        const session = sessions.getSession(AGENT, GUILD);
        assert.ok(session, 'الجلسة بدأت');
        assert.strictEqual(session.engineId, 'mafia');
        assert.strictEqual(session.mafia.players.size, 2, 'سجل لاعبي اللوبي');
        assert.strictEqual(session.mafia.players.get(P1).name, 'خالد');
        console.log('✅ 2) اللوبي: دخل بالزر الصريح وسجل اللاعبين (يعرف من يلعب معه)');
    }

    // ═══ 3) توزيع الرتب — يتمنى مافيا (كلام محتمل) ═══
    {
        const client = makeClient();
        withMafia('auto');
        freshMafiaSession(client);
        const roles = makeMessage(client, {
            content: '✅ | تم توزيع الرتب على اللاعبين. ستبدأ الجولة الأولى في بضع ثواني...',
        });
        await player.handleMessage({ client, message: roles, agentId: AGENT, runtimeSettings });
        await settle();
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.phase, 'roles', 'المرحلة: توزيع');
        assert.ok(client.__sent.length >= 1, 'تكلم عند توزيع الرتب');
        console.log('✅ 3) توزيع الرتب: تفاعل (يتمنى مافيا/يلعن حظه) والمرحلة سُجلت');
    }

    // ═══ 4) ليل القتل — يرجى ألا يُقتل ═══
    {
        const client = makeClient();
        withMafia('auto');
        freshMafiaSession(client);
        const night = makeMessage(client, {
            content: '🔪 | جاري انتظار المافيا لاختيار شخص لقتله...',
        });
        await player.handleMessage({ client, message: night, agentId: AGENT, runtimeSettings });
        await settle();
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.phase, 'night_kill');
        assert.ok(client.__sent.length >= 1, 'رجاء ألا يُقتل');
        console.log('✅ 4) ليل القتل: رجاء يصل القناة والمرحلة سُجلت');
    }

    // ═══ 4.ب) المافيا نفسها لا ترجى في دورها (قاعدة الصمت) ═══
    {
        const client = makeClient();
        withMafia('auto');
        const session = freshMafiaSession(client);
        session.mafia.role = 'mafia';
        const night = makeMessage(client, {
            content: '🔪 | جاري انتظار المافيا لاختيار شخص لقتله...',
        });
        await player.handleMessage({ client, message: night, agentId: AGENT, runtimeSettings });
        await settle();
        assert.strictEqual(client.__sent.length, 0, 'المافيا صامتة في دورها');
        console.log('✅ 4.ب) صمت المافيا: لا ترجى أثناء دورها');
    }

    // ═══ 5) دور الطبيب — «احميني» ═══
    {
        const client = makeClient();
        withMafia('auto');
        freshMafiaSession(client);
        const save = makeMessage(client, {
            content: '💊 | جاري انتظار الطبيب لاختيار شخص لحمايته...',
        });
        await player.handleMessage({ client, message: save, agentId: AGENT, runtimeSettings });
        await settle();
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.phase, 'night_save');
        assert.ok(client.__sent.length >= 1, 'طلب حماية');
        console.log('✅ 5) دور الطبيب: طلب الحماية وصل والمرحلة سُجلت');
    }

    // ═══ 6) قتل صديق — يندب القاتل ويوعد بأخذ حقه ═══
    {
        const client = makeClient();
        withMafia('auto');
        freshMafiaSession(client, {
            players: [{ id: FRIEND_ID, name: 'صديقي' }],
            friends: [FRIEND_ID],
        });
        const kill = makeMessage(client, {
            content: `⚰️ | نجحت عملية المافيا وتم قتل <@${FRIEND_ID}> وهذا الشخص كان **مواطن**`,
        });
        await player.handleMessage({ client, message: kill, agentId: AGENT, runtimeSettings });
        await settle();
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.players.get(FRIEND_ID).alive, false, 'القتيل سُجل ميتاً');
        assert.strictEqual(session.mafia.phase, 'day');
        assert.ok(client.__sent.length >= 1, 'ندبة الثأر وصلت');
        const stats = store.statsFor(AGENT, GUILD);
        assert.strictEqual(stats.losses, 0, 'قتيل غيرنا ليس خسارتنا');
        console.log('✅ 6) قتل صديق: القتيل سُجل + ندبة ووعد بالثأر + لا خسارة مزيفة');
    }

    // ═══ 7) موته هو — «تم قتل <@هو>» خسارة حقيقية والجلسة تُغلق ═══
    {
        const client = makeClient();
        withMafia('auto');
        freshMafiaSession(client, { players: [{ id: AGENT_USER_ID, name: AGENT_NAME }] });
        const kill = makeMessage(client, {
            content: `⚰️ | نجحت عملية المافيا وتم قتل <@${AGENT_USER_ID}> وهذا الشخص كان **مواطن**`,
            mentions: { has: (id) => String(id) === AGENT_USER_ID, users: new Map() },
        });
        await player.handleMessage({ client, message: kill, agentId: AGENT, runtimeSettings });
        await settle();
        const stats = store.statsFor(AGENT, GUILD);
        assert.strictEqual(stats.losses, 1, 'موته = خسارة واحدة');
        assert.strictEqual(sessions.getSession(AGENT, GUILD), null, 'الجلسة أُغلقت');
        assert.ok(client.__sent.length >= 1, 'تعليق على موته');
        console.log('✅ 7) موته: خسارة صحيحة + إغلاق الجلسة + تعليق');
    }

    // ═══ 8) التصويت الذكي — يضغط الاسم الذي اختاره الذكاء (لا نفسه) ═══
    {
        const client = makeClient();
        withMafia('ai');
        prompts.length = 0;
        aiReply = 'خالد';
        freshMafiaSession(client, {
            players: [
                { id: P1, name: 'خالد' },
                { id: P2, name: 'سالم' },
            ],
        });
        const vote = makeMessage(client, {
            content: `لديكم **15 ثانية** لاختيار شخص لطرده من اللعبة`,
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem'], [AGENT_NAME, 'btn_me'], ['حقيبتي', 'btn_bag']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2200); // تأخير الضغط البشري
        assert.deepStrictEqual(client.__clicks, ['btn_khaled'], 'ضغط خالد الذي اختاره الذكاء');
        assert.ok(prompts.length >= 1 && prompts[0].includes('تصوت'), 'الذكاء استُشير بسياق التصويت');
        console.log('✅ 8) التصويت الذكي: ضغط «خالد» — لا نفسه ولا حقيبتي ولا عشوائي');
    }

    // ═══ 9) التصويت التلقائي (الافتراضي) — قرار الذكاء نفسه (v7.18) ═══
    {
        const client = makeClient();
        withMafia('auto');
        prompts.length = 0;
        aiReply = 'سالم';
        freshMafiaSession(client);
        const vote = makeMessage(client, {
            content: `لديكم **15 ثانية** لاختيار شخص لطرده من اللعبة`,
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem'], [AGENT_NAME, 'btn_me']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2200);
        assert.strictEqual(client.__clicks.length, 1, 'ضغطة واحدة');
        assert.deepStrictEqual(client.__clicks, ['btn_salem'], 'الوكيل اختار هو نفسه حتى في التلقائي — لا عشوائي');
        assert.ok(prompts.length >= 1 && prompts[0].includes('تصوت'), 'التلقائي يستشير عقله أيضاً (v7.18: لا يختار عشوائياً بعد اليوم)');
        console.log('✅ 9) التصويت التلقائي: قرار الوكيل نفسه بعقله — العشوائي احتياط فشل فقط');
    }

    // ═══ 10) لا تصويت مزدوج عند تعديل رسالة العداد ═══
    {
        const client = makeClient();
        withMafia('auto');
        freshMafiaSession(client);
        const voteId = 'vote_msg_1';
        const vote = makeMessage(client, {
            id: voteId,
            content: `لديكم **15 ثانية** لاختيار شخص لطرده من اللعبة`,
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2200);
        const edited = makeMessage(client, {
            id: voteId,
            content: `لديكم **0 ثانية** لاختيار شخص لطرده من اللعبة`,
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem']),
        });
        await player.handleMessageUpdate({ client, message: edited, agentId: AGENT, runtimeSettings });
        await settle(2200);
        assert.strictEqual(client.__clicks.length, 1, 'ضغطة واحدة فقط رغم التعديل');
        console.log('✅ 10) لا ازدواج: تعديل رسالة العداد لا يصوّت مرتين');
    }

    // ═══ 11) رسالة سرية على الخاص — اختيار ضحية المافيا ═══
    {
        const client = makeClient();
        withMafia('ai');
        prompts.length = 0;
        aiReply = 'سالم';
        store.resetSessionStats(AGENT, GUILD); // إحصائيات نظيفة لهذا الفحص
        freshMafiaSession(client);
        const dm = makeDm(client, {
            content: '🔪 دورك هو المافيا — اختار شخصا لاغتياله',
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem']),
        });
        await player.handleMessage({ client, message: dm, agentId: AGENT, runtimeSettings });
        await settle(2200);
        assert.deepStrictEqual(client.__clicks, ['btn_salem'], 'ضغط الضحية التي اختارها الذكاء');
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.role, 'mafia', 'الدور سُجل من الرسالة السرية');
        assert.ok(prompts.some(p => p.includes('مافيا')), 'الذكاء استُشير بدوره');
        // v7.18: رد الفعل على بطاقة الدور يخضع لقاعدة صمت المافيا ×0.12 —
        // المافيا لا تعلن دورها. نجعله صفراً حتمياً هنا ونقيس حركة القتل وحدها
        const savedRoleReact = hooks.CHANCES.role_react;
        hooks.CHANCES.role_react = 0;
        assert.strictEqual(store.statsFor(AGENT, GUILD).plays, 1, 'حركة القتل السرية محسوبة');
        hooks.CHANCES.role_react = savedRoleReact;
        console.log('✅ 11) الخاص (مافيا): ضغط الضحية + الدور سُجل + صمت المافيا على البطاقة');
    }

    // ═══ 12) رسالة سرية على الخاص — حماية الطبيب ═══
    {
        const client = makeClient();
        withMafia('ai');
        prompts.length = 0;
        aiReply = 'خالد';
        freshMafiaSession(client);
        const dm = makeDm(client, {
            content: '💊 دورك الطبيب — اختار شخصا لحمايته',
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem']),
        });
        await player.handleMessage({ client, message: dm, agentId: AGENT, runtimeSettings });
        await settle(2200);
        assert.deepStrictEqual(client.__clicks, ['btn_khaled'], 'ضغط المحمي');
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.role, 'doctor', 'دور الطبيب سُجل');
        console.log('✅ 12) الخاص (طبيب): اختار من يُحمى بالذكاء');
    }

    // ═══ 13) خاص من بوت بلا جلسة مافيا — صفر تدخل ═══
    {
        const client = makeClient();
        withMafia('ai');
        sessions.__reset(); // لا جلسة
        const dm = makeDm(client, {
            author: { id: '999888777666555444', bot: true },
            content: 'اختار شخصا لاغتياله',
            components: buttonsOf(['خالد', 'btn_khaled']),
        });
        const handled = await player.handleMessage({ client, message: dm, agentId: AGENT, runtimeSettings });
        assert.strictEqual(handled, false);
        assert.strictEqual(client.__clicks.length, 0, 'لا نقر أزرار أبحاث غريبة على الخاص');
        console.log('✅ 13) الخاص الغريب: بلا جلسة مافيا → صفر تدخل');
    }

    // ═══ 14) إعلان الفائزين بقائمة منشنات — فوز صحيح ═══
    {
        const client = makeClient();
        withMafia('auto');
        freshMafiaSession(client);
        const win = makeMessage(client, {
            content: `🎉 انتهت اللعبة! الفائزون بالمافيا: <@${P1}> <@${AGENT_USER_ID}>`,
            mentions: { has: (id) => String(id) === AGENT_USER_ID, users: new Map() },
        });
        await player.handleMessage({ client, message: win, agentId: AGENT, runtimeSettings });
        await settle();
        const stats = store.statsFor(AGENT, GUILD);
        assert.strictEqual(stats.wins, 1, 'فوز واحد');
        assert.strictEqual(sessions.getSession(AGENT, GUILD), null, 'الجلسة أُغلقت بعد الإعلان');
        console.log('✅ 14) الفائزون: قائمة منشنات فيها اسمه → فوز وإغلاق');
    }

    // ═══ 15) قرار الشك — الصامت يظهر للذكاء كمشتبه به ═══
    {
        const client = makeClient();
        prompts.length = 0;
        aiReply = 'سالم';
        const session = freshMafiaSession(client);
        sessions.mafiaSetPlayers(AGENT, GUILD, [
            { id: P1, name: 'خالد' },
            { id: P2, name: 'سالم' },
        ]);
        // خالد ثرثار (3 رسائل) وسالم صامت (0)
        sessions.bumpTalk(AGENT, GUILD, P1);
        sessions.bumpTalk(AGENT, GUILD, P1);
        sessions.bumpTalk(AGENT, GUILD, P1);
        const candidates = [
            { customId: 'btn_khaled', label: 'خالد' },
            { customId: 'btn_salem', label: 'سالم' },
        ];
        const target = await mafia.decideVote({
            runtimeSettings, agentName: AGENT_NAME, role: 'citizen', session, candidates,
        });
        assert.ok(target, 'قرار صدر');
        assert.strictEqual(target.customId, 'btn_salem', 'الذكاء اختار الصامت');
        const lastPrompt = prompts[prompts.length - 1];
        assert.ok(lastPrompt.includes('سالم') && lastPrompt.includes('صامتون'), 'الصامت ظهر كمشتبه به');
        assert.ok(lastPrompt.includes('تكلم 3 مرة'), 'عداد الكلام وصل للذكاء');
        console.log('✅ 15) محاكمة الصمت: الصامت ظهر للذكاء كمشتبه به واختاره');
    }

    // ═══ 16) تخزين الوضع — social/ai يُحفظان اجتماعي، القيم الغريبة تُرفض ═══
    {
        const STORE_AGENT = 'd4000000000000000000000dd';
        const col = require.cache[cfgPath].exports.game_players_col;
        updateCaptures.length = 0;
        await store.updateGameSettings(STORE_AGENT, GUILD, { engines: { mafia: { mode: 'social' } } });
        let last = updateCaptures[updateCaptures.length - 1];
        assert.strictEqual(last.$set['engines.mafia.mode'], 'social', 'وضع اجتماعي يُحفظ');
        await store.updateGameSettings(STORE_AGENT, GUILD, { engines: { mafia: { mode: 'ai' } } });
        last = updateCaptures[updateCaptures.length - 1];
        assert.strictEqual(last.$set['engines.mafia.mode'], 'social', 'توافق قديم: ai يُقرأ اجتماعي');
        await store.updateGameSettings(STORE_AGENT, GUILD, { engines: { mafia: { mode: 'bogus' } } });
        last = updateCaptures[updateCaptures.length - 1];
        assert.strictEqual(last.$set['engines.mafia.mode'], undefined, 'القيمة الغريبة تُرفض');
        const normalized = store.defaultSettings();
        assert.strictEqual(normalized.engines.mafia.mode, 'auto', 'الافتراضي تلقائي');
        console.log('✅ 16) التخزين: social/ai → اجتماعي — والافتراضي تلقائي');
    }

    // ═══ 17) قاعدة صمت المافيا — كلامه يتقلص عندما يصير مافيا ═══
    {
        const client = makeClient();
        const session = freshMafiaSession(client);
        session.mafia.role = 'mafia';
        const asMafia = social.effectiveChance(session, 'beg', 1.0);
        assert.ok(asMafia <= 0.12, `صمت المافيا: 1.0 → ${asMafia}`);
        session.mafia.role = 'citizen';
        const asCitizen = social.effectiveChance(session, 'beg', 1.0);
        assert.strictEqual(asCitizen, 1.0, 'المواطن يتكلم طبيعياً');
        console.log('✅ 17) قاعدة الصمت: مافيا ×0.12 — مواطن طبيعي');
    }

    // ═══ 18) الروليت: الوضع الذكي يختار من يُطرد ═══
    {
        const client = makeClient();
        const base = withMafia('auto');
        base.engines.roulette = { enabled: true, mode: 'ai', delay: 0, roundTimeout: 60 };
        prompts.length = 0;
        aiReply = 'سالم';
        sessions.__reset();
        sessions.startSession(AGENT, GUILD, {
            engineId: 'roulette', channelId: CHANNEL, botId: BOT_ID,
            gameName: 'روليت', guildName: 'سيرفر المافيا',
        });
        const turn = makeMessage(client, {
            content: `🎯 <@${AGENT_USER_ID}> دورك! اختر لاعباً لطرده من الجولة`,
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem']),
        });
        await player.handleMessage({ client, message: turn, agentId: AGENT, runtimeSettings });
        await settle(200);
        assert.deepStrictEqual(client.__clicks, ['btn_salem'], 'الذكاء اختار سالم');
        assert.ok(prompts[prompts.length - 1].includes('روليت'), 'استشارة بسياق الروليت');
        console.log('✅ 18) الروليت الذكية: الذكاء هو من يختار من يُطرد');
    }

    // ═══ 18.ب) الروليت التلقائية — قرار الوكيل بعقله (v7.18) ═══
    {
        const client = makeClient();
        const base = withMafia('auto');
        base.engines.roulette = { enabled: true, mode: 'auto', delay: 0, roundTimeout: 60 };
        prompts.length = 0;
        aiReply = 'خالد';
        sessions.__reset();
        sessions.startSession(AGENT, GUILD, {
            engineId: 'roulette', channelId: CHANNEL, botId: BOT_ID,
            gameName: 'روليت', guildName: 'سيرفر المافيا',
        });
        const turn = makeMessage(client, {
            content: `🎯 <@${AGENT_USER_ID}> دورك! اختر لاعباً لطرده من الجولة`,
            components: buttonsOf(['خالد', 'btn_khaled'], ['سالم', 'btn_salem']),
        });
        await player.handleMessage({ client, message: turn, agentId: AGENT, runtimeSettings });
        await settle(200);
        assert.deepStrictEqual(client.__clicks, ['btn_khaled'], 'الوكيل اختار هو نفسه حتى في التلقائي');
        assert.ok(prompts.length >= 1, 'التلقائي يستشير عقله (لا عشوائي صامت بعد اليوم)');
        console.log('✅ 18.ب) الروليت التلقائية: قرار الوكيل بعقله — لا عشوائي');
    }

    console.log('\n🏆 games_mafia: كل المجموعات خضراء');
}

run().then(() => {
    process.exit(0);
}).catch((error) => {
    console.error('\n❌ فشل اختبار المافيا:', error.message);
    console.error(error.stack);
    process.exit(1);
});
