/**
 * tests/games_voting.test.js — جولة التصويت الحقيقية (v7.19)
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالح المحمي حرفياً:
 *  «انا عامله اجتماعي لكنه لا يستطيع اللعب مثلا تصويت على طرد في جولة
 *   التصويت او طرد اذا كان مافيا. او اذا دكتور لانه حاليا تصله النتيجة
 *   فقط لا يعرف في جولات التصويت من صوت على من وخيار له لكي يصوت على
 *   احد لماذا؟»
 *
 *  1) صياغة تصويت غير معروفة («صوتوا الآن على من سيخرج») → يصوّت فعلاً
 *     (الكود القديم: VOTE_TEXT خمس صيغ فقط → لا تصويت أبداً)
 *  2) رسالة تصويت تحتوي «مافيا» → لا تُفهم لوبياً (لا ضغط عشوائي) ويصوّت صح
 *  3) الخيارات (أسماء الأزرار) تصل لعقل الوكيل في الصندوق الحي
 *     (الكود القديم: النص فقط — «وخيار له لكي يصوت» مفقود)
 *  4) عدّاد الأصوات (تعديل الرسالة «أحمد (2)») يُسجل ويصل عقله
 *     («لا يعرف في جولات التصويت من صوت على من»)
 *  5) بطاقة الطبيب تُصنّف حماية لا قتلاً (كانت قتلاً — عقلة بذهنية مافيا)
 *  6) المافيا تصوّت بذهنية مافيا: زميله معلّم «لا تختاره أبداً»
 *  7) زملاء المافيا من بطاقة الدور يُسجّلون ويصلون للسياق («ومن معه»)
 *  8) بطاقة قتل ظاهرة بالقناة (ليست سرية) → يختار ضحيته فعلاً
 *  9) الوضع الاجتماعي يعلن تصويته بالشات — التلقائي صامت تماماً
 * 10) قُتل → متفرج: لا تصويت ولا حركات (وزر «تحديث» ليس ضحية أبداً)
 * 11) parseVoteLabel: «خالد (2)» و«سالم - 3» و«عمر ٢»
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
        game_players_col: {
            findOne: async () => null,
            updateOne: async () => ({ ok: 1 }),
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
const eventsMod = require('../games/events');
const mafia = require('../games/mafia');

const AGENT = 'd4000000000000000000000dd';
const GUILD = 'g888888888888888888';
const CHANNEL = 'c999999999999999999';
const AGENT_USER_ID = '888000111222333666';
const AGENT_NAME = 'وكيلنا';
const BOT_ID = '2508592252220477652';
const P1 = '777000111222333811'; // خالد
const P2 = '777000111222333822'; // سالم
const ALLY_ID = '777000111222333833'; // أحمد — زميل المافيا

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

function withMafia({ mode = 'auto', socialEnabled = true } = {}) {
    const base = store.defaultSettings();
    base.enabled = true;
    base.social = { enabled: socialEnabled };
    base.engines.mafia = { enabled: true, mode, delay: 0, roundTimeout: 300 };
    overrides.set(`${AGENT}:${GUILD}`, base);
    return base;
}

function makeClient() {
    const sent = [];
    return {
        __selfbotRuntime: true,
        user: { id: AGENT_USER_ID },
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر التصويت' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (c) => ({ content: c }) }) },
        __sent: sent,
        __clicks: [],
    };
}

function makeMessage(client, overridesMsg = {}) {
    return {
        id: overridesMsg.id || `m${Math.random().toString(36).slice(2)}`,
        guild: { id: GUILD, name: 'سيرفر التصويت' },
        channel: {
            id: CHANNEL,
            send: async (c) => { client.__sent.push(typeof c === 'string' ? c : (c && c.content) || ''); return { content: c }; },
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
    return [{ components: defs.map(([label, id]) => ({ type: 2, style: 1, label, customId: id, disabled: false })) }];
}

/** جلسة مافيا حية جاهزة */
function freshMafiaSession(client, { players = [], role = null } = {}) {
    sessions.__reset();
    const session = sessions.startSession(AGENT, GUILD, {
        engineId: 'mafia', channelId: CHANNEL, botId: BOT_ID,
        gameName: 'مافيا', guildName: 'سيرفر التصويت',
    });
    sessions.setMe(AGENT, GUILD, { id: AGENT_USER_ID, name: AGENT_NAME });
    if (players.length) sessions.mafiaSetPlayers(AGENT, GUILD, players);
    if (role) { session.mafia.role = role; sessions.mafiaSetRole(AGENT, GUILD, role); }
    return session;
}

const settle = (ms = 120) => new Promise(r => setTimeout(r, ms));

async function run() {
    player.agentReady({ client: makeClient(), agentId: AGENT, agentName: AGENT_NAME, tokenType: 'user', kind: 'agent' });

    // ═══ 1) صياغة تصويت غير معروفة → يصوّت فعلاً ═══
    {
        const client = makeClient();
        withMafia({ mode: 'auto' });
        prompts.length = 0; aiReply = 'خالد';
        freshMafiaSession(client, { players: [{ id: P1, name: 'خالد' }, { id: P2, name: 'سالم' }] });
        const vote = makeMessage(client, {
            content: '🗳️ صوتوا الآن على من سيخرج من اللعبة!',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2000);
        assert.strictEqual(client.__clicks.length, 1, 'صوّت فعلاً بصياغة غير معروفة');
        assert.deepStrictEqual(client.__clicks, ['btn_k'], 'ضغط اختيار عقله');
        assert.ok(prompts.length >= 1 && prompts[0].includes('تصوت'), 'استُشير عقله بالتصويت');
        console.log('✅ 1) صياغة تصويت غير معروفة: صوّت فعلاً (الكود القديم كان يتجاهلها كلياً)');
    }

    // ═══ 2) رسالة تصويت فيها «مافيا» — لا لوبي ولا ضغط عشوائي زائد ═══
    {
        const client = makeClient();
        withMafia({ mode: 'auto' });
        prompts.length = 0; aiReply = 'سالم';
        freshMafiaSession(client);
        const vote = makeMessage(client, {
            content: '🕵️ المافيا بينكم… صوتوا على من تظنونه مافيا',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2000);
        assert.strictEqual(client.__clicks.length, 1, 'ضغطة تصويت واحدة فقط');
        assert.deepStrictEqual(client.__clicks, ['btn_s'], 'ضغط من اختاره عقله — لا زر انضمام ولا حقيبة');
        console.log('✅ 2) تصويت يحتوي «مافيا»: لم يُفهم لوبياً وصوّت صح');
    }

    // ═══ 3) الخيارات (أسماء الأزرار) تصل لعقل الوكيل ═══
    {
        const client = makeClient();
        withMafia({ mode: 'auto' });
        freshMafiaSession(client);
        const vote = makeMessage(client, {
            id: 'vote_opts_1',
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s'], ['تحديث', 'btn_refresh']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        const session = sessions.getSession(AGENT, GUILD);
        const lastInbox = session.inbox[session.inbox.length - 1];
        assert.ok(lastInbox.text.includes('الخيارات'), 'سطر الخيارات في الصندوق الحي');
        assert.ok(lastInbox.text.includes('[خالد]') && lastInbox.text.includes('[سالم]'), 'أسماء الخيارات حرفياً');
        const ctx = sessions.contextSummary(session);
        assert.ok(ctx.includes('[خالد]'), 'الخيارات في سياق الذكاء أيضاً');
        console.log('✅ 3) الخيارات (أزرار التصويت) وصلت لعقل الوكيل — «وخيار له لكي يصوت»');
    }

    // ═══ 4) عدّاد الأصوات من تعديل الرسالة — «من صوت على من» ═══
    {
        const client = makeClient();
        withMafia({ mode: 'auto' });
        prompts.length = 0; aiReply = 'خالد';
        freshMafiaSession(client);
        const voteId = 'vote_tally_msg';
        const vote = makeMessage(client, {
            id: voteId,
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['أحمد', 'btn_a'], ['خالد', 'btn_k']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2000);
        // عدّاد يتعدل مرتين — الأصوات تتغير
        const upd1 = makeMessage(client, {
            id: voteId,
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['أحمد (2)', 'btn_a'], ['خالد (1)', 'btn_k']),
        });
        await player.handleMessageUpdate({ client, message: upd1, agentId: AGENT, runtimeSettings });
        const upd2 = makeMessage(client, {
            id: voteId,
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['أحمد (3)', 'btn_a'], ['خالد (1)', 'btn_k']),
        });
        await player.handleMessageUpdate({ client, message: upd2, agentId: AGENT, runtimeSettings });
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.voteCounts.get('أحمد'), 3, 'عدد أصوات أحمد من العدّاد');
        assert.strictEqual(session.mafia.voteCounts.get('خالد'), 1, 'عدد أصوات خالد');
        assert.ok(session.events.some(e => e.text.includes('لوحة الأصوات')), 'سجل الوعي يوثق الأصوات');
        const ctx = sessions.contextSummary(session);
        assert.ok(ctx.includes('لوحة الأصوات') && ctx.includes('أحمد (3)'), 'لوحة الأصوات تصل عقله في السياق');
        console.log('✅ 4) عدّاد الأصوات يُقرأ من التعديلات — «من صوت على من» يعرف الآن');
    }

    // ═══ 5) بطاقة الطبيب = حماية لا قتل ═══
    {
        assert.strictEqual(mafia.detectChoiceKind('اختر شخصاً لحمايته'), 'save', 'بطاقة الطبيب حماية');
        assert.strictEqual(mafia.detectChoiceKind('اختار شخصا لحمايته'), 'save', 'صيغة أخرى للطبيب');
        assert.strictEqual(mafia.detectChoiceKind('اختار شخصا لاغتياله'), 'kill', 'بطاقة المافيا قتل');
        assert.strictEqual(mafia.detectChoiceKind('انتظر الطبيب لاختيار شخص لحمايته'), 'save', 'إعلان الطبيب');
        console.log('✅ 5) تصنيف البطاقات: الطبيب = حماية (كان يُصنّف قتلاً بعقل مافيا)');
    }

    // ═══ 6) المافيا تصوّت بذهنية مافيا — زميله «لا تختاره أبداً» ═══
    {
        const client = makeClient();
        withMafia({ mode: 'ai' });
        prompts.length = 0; aiReply = 'خالد';
        const session = freshMafiaSession(client, {
            players: [{ id: P1, name: 'خالد' }, { id: ALLY_ID, name: 'أحمد' }],
            role: 'mafia',
        });
        sessions.mafiaAddAllies(AGENT, GUILD, [ALLY_ID]);
        const vote = makeMessage(client, {
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['أحمد', 'btn_a'], ['خالد', 'btn_k']),
        });
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(2000);
        assert.deepStrictEqual(client.__clicks, ['btn_k'], 'لم يصوّت على زميله المافيا');
        const votePrompt = prompts.find(p => p.includes('تصوّت') || p.includes('تصوت'));
        assert.ok(votePrompt, 'برومبت التصويت صدر');
        assert.ok(votePrompt.includes('مافيا وتصوّت'), 'برومبت بذهنية مافيا (إسقاط بريء)');
        assert.ok(votePrompt.includes('زميلك في المافيا — لا تختاره أبداً'), 'الزميل معلّم في البرومبت');
        console.log('✅ 6) مافيا تصوّت بذهنية مافيا — زميله محمي في القرار (كان «صوّت على من تشك أنه مافيا»!)');
    }

    // ═══ 7) زملاء المافيا من بطاقة الدور — «ومن معه» ═══
    {
        const client = makeClient();
        withMafia({ mode: 'auto' });
        prompts.length = 0;
        freshMafiaSession(client);
        const card = makeDm(client, {
            content: `🔪 دورك هو المافيا — زملاؤك في الفريق: <@${P1}> <@${ALLY_ID}>`,
        });
        await player.handleMessage({ client, message: card, agentId: AGENT, runtimeSettings });
        await settle();
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.role, 'mafia', 'الدور سُجل');
        assert.ok(session.mafia.allies.has(P1) && session.mafia.allies.has(ALLY_ID), 'الزملاء سُجلوا من البطاقة');
        const ctx = sessions.contextSummary(session);
        assert.ok(ctx.includes('زملاؤك في المافيا'), 'الزملاء في سياق الذكاء');
        assert.strictEqual(client.__clicks.length, 0, 'بطاقة دور بلا أزرار = لا ضغطات');
        console.log('✅ 7) زملاء المافيا من بطاقة الدور سُجلوا — «ومن معه» يعرفهم');
    }

    // ═══ 8) بطاقة قتل ظاهرة بالقناة → يختار ضحيته فعلاً ═══
    {
        const client = makeClient();
        withMafia({ mode: 'ai' });
        prompts.length = 0; aiReply = 'خالد';
        freshMafiaSession(client, { role: 'mafia', players: [{ id: P1, name: 'خالد' }, { id: P2, name: 'سالم' }] });
        const killCard = makeMessage(client, {
            content: '🔪 جاري انتظار المافيا لاختيار شخص لقتله — امسك الطرف واختر ضحيتك',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s']),
        });
        await player.handleMessage({ client, message: killCard, agentId: AGENT, runtimeSettings });
        await settle(2000);
        assert.deepStrictEqual(client.__clicks, ['btn_k'], 'اختار ضحيته من بطاقة ظاهرة (كان لا أحد يختار)');
        const session = sessions.getSession(AGENT, GUILD);
        assert.ok(session.events.some(e => e.text.includes('ضحية المافيا')), 'الحركة السرية في الوعي');
        console.log('✅ 8) بطاقة القتل الظاهرة بالقناة: اختار هو نفسه (كانت تُستهلك بلا قرار)');
    }

    // ═══ 9) الاجتماعي يعلن تصويته — التلقائي صامت ═══
    {
        // اجتماعي: يعلن
        const client = makeClient();
        withMafia({ mode: 'social', socialEnabled: true });
        prompts.length = 0; aiReply = 'أصوت على خالد، ساكت من أول الجولة';
        freshMafiaSession(client, { players: [{ id: P1, name: 'خالد' }, { id: P2, name: 'سالم' }] });
        const vote1 = makeMessage(client, {
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s']),
        });
        await player.handleMessage({ client, message: vote1, agentId: AGENT, runtimeSettings });
        await settle(300);
        assert.strictEqual(client.__clicks.length, 1, 'صوّت فعلاً');
        assert.ok(client.__sent.length >= 1, 'أعلن تصويته في الشات (الوضع الاجتماعي)');
        const announce = client.__sent.join(' ');
        assert.ok(announce.includes('صوت'), 'نص الإعلان عن التصويت ظاهر');

        // تلقائي: صامت تماماً
        const client2 = makeClient();
        withMafia({ mode: 'auto', socialEnabled: false });
        prompts.length = 0; aiReply = 'خالد';
        sessions.__reset();
        freshMafiaSession(client2, { players: [{ id: P1, name: 'خالد' }, { id: P2, name: 'سالم' }] });
        const vote2 = makeMessage(client2, {
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s']),
        });
        await player.handleMessage({ client: client2, message: vote2, agentId: AGENT, runtimeSettings });
        await settle(300);
        assert.strictEqual(client2.__clicks.length, 1, 'التلقائي يصوّت أيضاً');
        assert.strictEqual(client2.__sent.length, 0, 'التلقائي لا يعلن — صمت تام');
        console.log('✅ 9) الاجتماعي يعلن تصويته بالشات — التلقائي يصوّت بصمت (فرق حقيقي)');
    }

    // ═══ 10) قُتل → متفرج + زر «تحديث» ليس ضحية أبداً ═══
    {
        const client = makeClient();
        withMafia({ mode: 'auto' });
        prompts.length = 0; aiReply = 'خالد';
        freshMafiaSession(client, { players: [{ id: AGENT_USER_ID, name: AGENT_NAME }, { id: P1, name: 'خالد' }] });
        const kill = makeMessage(client, {
            content: `⚰️ | نجحت عملية المافيا وتم قتل <@${AGENT_USER_ID}> وهذا الشخص كان **مواطن**`,
        });
        await player.handleMessage({ client, message: kill, agentId: AGENT, runtimeSettings });
        await settle();
        // الطبقة الأولى: النتيجة أغلقت الجلسة — رسالة التصويت بلا جلسة = لا ضغطات
        assert.strictEqual(sessions.getSession(AGENT, GUILD), null, 'الجلسة أُغلقت عند الموت');
        const vote = makeMessage(client, {
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['خالد', 'btn_k'], ['تحديث', 'btn_refresh']),
        });
        const clicksBefore = client.__clicks.length;
        await player.handleMessage({ client, message: vote, agentId: AGENT, runtimeSettings });
        await settle(500);
        assert.strictEqual(client.__clicks.length, clicksBefore, 'ميت (بلا جلسة) = لا تصويت');
        // الطبقة الثانية: جلسة باقية لكن موته مُسجل (meDead) — متفرج بلا حركات
        sessions.__reset();
        const session2 = freshMafiaSession(client, { players: [{ id: P1, name: 'خالد' }] });
        sessions.mafiaMarkMeDead(AGENT, GUILD);
        assert.strictEqual(session2.mafia.meDead, true, 'meDead مُسجل');
        const vote2 = makeMessage(client, {
            content: '🗳️ صوتوا على من سيخرج',
            components: buttonsOf(['خالد', 'btn_k'], ['سالم', 'btn_s']),
        });
        await player.handleMessage({ client, message: vote2, agentId: AGENT, runtimeSettings });
        await settle(500);
        assert.strictEqual(client.__clicks.length, clicksBefore, 'ميت (جلسة حية + meDead) = لا تصويت أيضاً');
        // زر تحديث ليس مرشحاً حتى للأحياء
        const cands = mafia.candidateButtons(
            [{ label: 'خالد', customId: 'b1', disabled: false }, { label: 'تحديث', customId: 'b2', disabled: false }],
            { agentName: AGENT_NAME },
        );
        assert.strictEqual(cands.length, 1, 'زر تحديث مستبعد من المرشحين');
        console.log('✅ 10) الميت متفرج (طبقتا الحماية) وزر «تحديث» ليس ضحية أبداً');
    }

    // ═══ 11) parseVoteLabel — صيغ العدّاد ═══
    {
        assert.deepStrictEqual(eventsMod.parseVoteLabel('خالد (2)'), { name: 'خالد', count: 2 });
        assert.deepStrictEqual(eventsMod.parseVoteLabel('سالم - 3'), { name: 'سالم', count: 3 });
        assert.deepStrictEqual(eventsMod.parseVoteLabel('عمر ٢'), { name: 'عمر', count: 2 });
        assert.deepStrictEqual(eventsMod.parseVoteLabel('مجرد اسم'), { name: 'مجرد اسم', count: null });
        assert.ok(eventsMod.looksLikeVote('صوتوا على من تريدون طرده'), 'كشف موسّع يعمل');
        assert.ok(eventsMod.looksLikeVote('لديكم 15 ثانية لاختيار شخص لطرده'), 'الصيغ القديمة ما زالت تعمل');
        assert.strictEqual(eventsMod.looksLikeVote('لديكم 15 ثانية للتحقق بين اللاعبين'), false, 'النقاش ليس تصويتاً');
        console.log('✅ 11) قراءة عدّاد الأصوات: (2) و- 3 و٢ العربية — كل الصيغ');
    }

    console.log('\n🏆 games_voting: كل المجموعات خضراء');
}

run().catch((error) => {
    console.error('❌ games_voting.test.js فشل:', error);
    process.exit(1);
});
