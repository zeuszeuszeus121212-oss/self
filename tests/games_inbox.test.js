/**
 * tests/games_inbox.test.js — الصندوق الحي والأسماء والدور والهوية (v7.18)
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالك الحرفي (v7.18):
 *  «انا طلبت بأنه اي رساله من اللعبة يتم إرسالها للوكيل ليرد او لا —
 *   مثلا اللوبي يتم إرسالها ومع الأعضاء المشاركين وليس فقط النص —
 *   حاليا يتم ارسال النص للوبي لكن لا يتم ارسال اسماء اللاعبين في الجولة —
 *   لا اريده يحاكي انه يعرف ما يجري بل اريده فعلا يعرف ما يجري ومن يلعب معه
 *   لأنني حاليا لو سألته من في اللعبه او بمن تشك لا يعرف اصلا —
 *   فقط اول مرة اتكلم معه يتم ارفاق له رساله اللوبي —
 *   لدرجة فزت معه انا مافيا هو لا يعرف اصلا ويقول انه مواطن —
 *   لا يختار هو اصلا من يقتل او على من يصوت».
 *
 * المجموعات:
 *  1) الأسماء من الإيمبد نفسه — منشنات الإيمبد لا تصل message.mentions
 *     وكانت أسماء اللاعبين تضيع كلياً (بلاغ «لا يتم ارسال اسماء اللاعبين»)
 *  2) تعديل رسالة اللوبي (لاعبون انضموا لاحقاً) → القائمة تتحدث بالأسماء
 *  3) بطاقة الدور في حقل إيمبد (حقول كانت مستثناة — «يقول مواطن وهو مافيا»)
 *  4) الصندوق الحي: كل رسالة بوت اللعبة تُنسخ حرفياً لعقل الوكيل + لا تكرار
 *  5) قرار القتل السري بعقل الوكيل حتى في الوضع التلقائي + نص الرسالة في البرومبت
 *  6) الوضعان يختلفان فعلاً: تلقائي يكتم الشات/اجتماعي يتكلم + بوابة النوع
 *  7) رد على رسالة اللوبي نفسها (reply بميزة ديسكورد) في الوضع الاجتماعي
 *  8) «فقط أول مرة»: الجلسة حية بعد 20 دقيقة صمت (كانت تموت بعد 15) وتموت بعد 46
 *  9) الهوية: «أنت اللاعب X» في سياق المحادثة — لا «البوت فاز»
 * 10) العدد والأسماء في سياق المحادثة الرئيسية — «من في اللعبه؟» له جواب
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- حقن config ومزود وهمي قبل أي تتطلب ----------

const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const providersPath = require.resolve(path.join(__dirname, '..', 'providers', 'index.js'));

let aiReply = 'سالم';
const prompts = [];
const fakeProvider = {
    chat: async ({ prompt }) => { prompts.push(String(prompt || '')); return { fullText: aiReply }; },
};
require.cache[providersPath] = {
    id: providersPath, filename: providersPath, loaded: true,
    exports: { getProviderOrFallback: () => fakeProvider },
};

require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: {
        game_players_col: { __mock: true },
        game_policy_col: { findOneAndUpdate: async () => ({}) },
        logs_col: null,
        SimpleLock: class { async acquire(fn) { return fn(); } },
    },
};

const store = require('../games/store');
const sessions = require('../games/sessions');
const social = require('../games/social');
const player = require('../games/player');

const AGENT = 'ab24000000000000000000aa'; // 24 hex
const GUILD = 'g241111111111111111';
const CHANNEL = 'c242222222222222222';
const GAME_BOT_ID = '1508592252220477651';
const AGENT_USER_ID = '999000111222333244';
const AGENT_NAME = 'وكيل الصندوق';
const P1 = '555000111222333201'; // سامي
const P2 = '777000111222333202'; // خالد
const P3 = '777000111222333203'; // فهد
const NAMES = { [P1]: 'سامي', [P2]: 'خالد', [P3]: 'فهد' };

const hooks = social.__testHooks();
hooks.TIMING.minDelay = 1;
hooks.TIMING.maxDelay = 2;
for (const key of Object.keys(hooks.CHANCES)) hooks.CHANCES[key] = 1.0;

const overrides = new Map();
const origGet = store.getGameSettings;
store.getGameSettings = async (agentId, guildId) => {
    const key = `${String(agentId)}:${String(guildId)}`;
    if (overrides.has(key)) return overrides.get(key);
    return origGet(agentId, guildId);
};

function setSettings(patch) {
    overrides.set(`${AGENT}:${GUILD}`, {
        ...store.defaultSettings(),
        ...patch,
        engines: { ...store.defaultSettings().engines, ...(patch.engines || {}) },
    });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function makeClient() {
    return {
        __selfbotRuntime: true,
        user: { id: AGENT_USER_ID },
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر الصندوق' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (c) => ({ content: c }) }) },
    };
}

function btn(label, customId) {
    return { type: 'BUTTON', label, custom_id: customId, customId, style: 1, disabled: false };
}

function makeMessage(overridesMsg = {}, channelSends) {
    const clicks = [];
    const message = {
        id: overridesMsg.id || `m${Math.random().toString(36).slice(2)}`,
        guild: {
            id: GUILD, name: 'سيرفر الصندوق',
            members: { fetch: async (id) => ({ id, displayName: NAMES[id] || `عضو-${id}` }) },
        },
        channel: {
            id: CHANNEL,
            send: async (c) => { channelSends && channelSends.push(c); return { content: c }; },
        },
        author: { id: GAME_BOT_ID, bot: true },
        content: '',
        embeds: [],
        components: [],
        mentions: { has: () => false, users: new Map() },
        clickButton: async (customId) => { clicks.push(customId); },
        ...overridesMsg,
    };
    message.__clicks = clicks;
    return message;
}

function makeDm(overridesMsg = {}) {
    const clicks = [];
    const message = {
        id: overridesMsg.id || `d${Math.random().toString(36).slice(2)}`,
        guild: null,
        channel: { id: 'dm-channel' },
        author: { id: GAME_BOT_ID, bot: true },
        content: '',
        embeds: [],
        components: [],
        mentions: { has: () => false, users: new Map() },
        clickButton: async (customId) => { clicks.push(customId); },
        ...overridesMsg,
    };
    message.__clicks = clicks;
    return message;
}

const runtimeSettings = { agentId: AGENT, agentName: AGENT_NAME, provider: 'deepseek', providerConfig: {}, kind: 'agent' };

async function run() {
    player.agentReady({ client: makeClient(), agentId: AGENT, agentName: AGENT_NAME, tokenType: 'user', kind: 'agent' });
    setSettings({ enabled: true, social: { enabled: true }, engines: { mafia: { enabled: true, mode: 'social' } } });

    // ═══ 1) الأسماء من الإيمبد نفسه — الحالة المكسورة سابقاً ═══
    {
        sessions.__reset();
        prompts.length = 0;
        // منشنات داخل إيمبد فقط — mentions.users فارغ تماماً (هذا ما كان يضيع)
        const lobby = makeMessage({
            content: '🎮 لوبي المافيا — الانضمام متاح!',
            embeds: [{ title: 'المافيا', description: `اللاعبون (${3}):\n<@${P1}>\n<@${P2}>\n<@${P3}>` }],
            components: [{ components: [btn('انضمام', 'join_inbox_1')] }],
        });
        await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT, runtimeSettings });
        await wait(60);
        const session = sessions.getSession(AGENT, GUILD);
        assert.ok(session, 'الجلسة بدأت');
        assert.strictEqual(session.mafia.players.size, 3, `أسماء اللاعبين من الإيمبد سُجلت (كانت 0) — وجدنا ${session.mafia.players.size}`);
        assert.strictEqual(session.mafia.players.get(P1).name, 'سامي', 'الاسم محلول من السيرفر — لا معرفات');
        assert.strictEqual(session.mafia.players.get(P3).name, 'فهد', 'كل الأعضاء عضو عضو');
        console.log('✅ 1) الأسماء من الإيمبد نفسه: 3 لاعبين بأسمائهم — «وليس فقط النص»');
    }

    // ═══ 2) تعديل اللوبي (لاعب انضم لاحقاً) → القائمة تتحدث ═══
    {
        sessions.__reset();
        const lobby = makeMessage({
            id: 'lobby_edit_msg_1',
            content: '🎮 لوبي المافيا — الانضمام متاح!',
            embeds: [{ description: `اللاعبون: <@${P1}>` }],
            components: [{ components: [btn('انضمام', 'join_inbox_2')] }],
        });
        await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT, runtimeSettings });
        await wait(60);
        let session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.players.size, 1, 'لقطة الانضمام: لاعب واحد كان موجوداً');
        // بعدها انضم خالد وفهد فتعدلت رسالة اللوبي
        const edited = makeMessage({
            id: 'lobby_edit_msg_1',
            content: '🎮 لوبي المافيا — الانضمام متاح!',
            embeds: [{ description: `اللاعبون: <@${P1}> <@${P2}> <@${P3}>` }],
            components: [{ components: [btn('انضمام', 'join_inbox_2')] }],
        });
        await player.handleMessageUpdate({ client: makeClient(), message: edited, agentId: AGENT, runtimeSettings });
        await wait(60);
        session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.players.size, 3, `القائمة تتحدث عند تعديل اللوبي — أصبحت ${session.mafia.players.size}`);
        assert.ok(session.events.some(e => e.text.includes('تحديث اللوبي')), 'حدث التحديث في سجل الوعي');
        console.log('✅ 2) تعديل اللوبي: اللاعبون الجدد يُسجلون بالأسماء — لا تجميد على لقطة الانضمام');
    }

    // ═══ 3) بطاقة الدور في حقل إيمبد — «يقول مواطن وهو مافيا» ═══
    {
        sessions.__reset();
        prompts.length = 0;
        const lobby = makeMessage({
            content: '🎮 لوبي المافيا!',
            components: [{ components: [btn('انضمام', 'join_inbox_3')] }],
        });
        await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT, runtimeSettings });
        await wait(40);
        // الرسالة السرية: الدور داخل حقل إيمبد — كان نص القراءة يستثني الحقول
        const dm = makeDm({
            embeds: [{
                title: 'رسالتك السرية',
                fields: [{ name: 'دورك في الجولة', value: 'مافيا 🔪 — لا تكشف نفسك' }],
            }],
        });
        await player.handleMessage({ client: makeClient(), message: dm, agentId: AGENT, runtimeSettings });
        await wait(60);
        const session = sessions.getSession(AGENT, GUILD);
        assert.strictEqual(session.mafia.role, 'mafia', `الدور من حقل الإيمبد سُجل — ${session.mafia.role}`);
        assert.ok(session.events.some(e => e.text.includes('عرفت دورك')), 'بطاقة الدور في سجل الوعي');
        assert.ok(session.inbox.some(i => i.text.includes('رسالة سرية') && i.text.includes('مافيا')), 'الرسالة السرية نفسها في الصندوق الحي');
        console.log('✅ 3) الدور من حقل الإيمبد: صار مافيا ويعرف ذلك — لا «مواطن» بالتخمين');
    }

    // ═══ 4) الصندوق الحي: كل رسالة بوت اللعبة تُنسخ حرفياً + لا تكرار ═══
    {
        sessions.__reset();
        const lobby = makeMessage({
            content: '🎮 لوبي المافيا!',
            components: [{ components: [btn('انضمام', 'join_inbox_4')] }],
        });
        await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT, runtimeSettings });
        await wait(40);
        const phase = makeMessage({ id: 'phase_msg_4', content: '🔪 | جاري انتظار المافيا لاختيار شخص لقتله...' });
        await player.handleMessage({ client: makeClient(), message: phase, agentId: AGENT, runtimeSettings });
        await player.handleMessage({ client: makeClient(), message: phase, agentId: AGENT, runtimeSettings }); // نفس الرسالة مرتين
        const session = sessions.getSession(AGENT, GUILD);
        const copies = session.inbox.filter(i => i.text.includes('جاري انتظار المافيا'));
        assert.strictEqual(copies.length, 1, 'الرسالة الحرفية في الصندوق مرة واحدة — لا تكرار');
        assert.ok(session.inbox.some(i => i.text.includes('جاري انتظار المافيا')), 'النص حرفياً كما وصل — لا ملخصات');
        // السياق الرئيسي يبث الصندوق — «فعلا يعرف ما يجري»
        const ctx = player.buildLiveGameContext({ agentId: AGENT, guildId: GUILD });
        assert.ok(ctx.includes('رسائل اللعبة الأخيرة كما وصلت حرفياً'), 'السياق يبث الصندوق الحي');
        assert.ok(ctx.includes('جاري انتظار المافيا'), 'السياق يحوي النص الحرفي للرسالة');
        console.log('✅ 4) الصندوق الحي: كل رسالة اللعبة حرفياً في عقله — لا تكرار ولا ملخصات ناقصة');
    }

    // ═══ 5) قرار القتل السري بعقل الوكيل حتى في التلقائي + نص الرسالة في البرومبت ═══
    {
        sessions.__reset();
        setSettings({ enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'auto' } } });
        prompts.length = 0;
        aiReply = 'خالد';
        const lobby = makeMessage({
            content: '🎮 لوبي المافيا!',
            components: [{ components: [btn('انضمام', 'join_inbox_5')] }],
        });
        await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT, runtimeSettings });
        await wait(40);
        const dm = makeDm({
            content: '🔪 أنت المافيا — اختار شخصا لاغتياله',
            components: [{ components: [btn('خالد', 'kill_khalid'), btn('سالم', 'kill_salem')] }],
        });
        await player.handleMessage({ client: makeClient(), message: dm, agentId: AGENT, runtimeSettings });
        await wait(60);
        assert.deepStrictEqual(dm.__clicks, ['kill_khalid'], 'الوكيل اختار الضحية بعقله هو — لا عشوائي');
        assert.ok(prompts.some(p => p.includes('اختار شخصا لاغتياله')), 'نص رسالة الاختيار الحقيقية داخل البرومبت — «رساله الاختيار يتم إرسالها للوكيل»');
        assert.ok(prompts.some(p => p.includes('أنت المافيا: اختر الضحية')), 'البرومبت يوجهه بدوره');
        console.log('✅ 5) قرار القتل بعقله حتى في التلقائي + رسالة الاختيار نفسها في البرومبت');
        setSettings({ enabled: true, social: { enabled: true }, engines: { mafia: { enabled: true, mode: 'social' } } });
    }

    // ═══ 6) الوضعان يختلفان فعلاً — تلقائي يكتم الشات / اجتماعي يتكلم ═══
    {
        sessions.__reset();
        setSettings({ enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'auto' } } });
        let session = sessions.startSession(AGENT, GUILD, { engineId: 'mafia', channelId: CHANNEL, botId: GAME_BOT_ID, gameName: 'مافيا' });
        const settingsAuto = overrides.get(`${AGENT}:${GUILD}`);
        assert.strictEqual(social.speechGate(settingsAuto, session, 'suspect'), false, 'تلقائي: لا شك صاخب');
        assert.strictEqual(social.speechGate(settingsAuto, session, 'role_citizen'), true, 'تلقائي: رد الدور يعمل');
        // الاجتماعي: كل شيء يعمل
        setSettings({ enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'social' } } });
        const settingsSocial = overrides.get(`${AGENT}:${GUILD}`);
        assert.strictEqual(social.speechGate(settingsSocial, session, 'suspect'), true, 'اجتماعي: الشك يعمل');
        assert.strictEqual(social.speechGate(settingsSocial, session, 'beg'), true, 'اجتماعي: الترجي يعمل');
        assert.strictEqual(social.speechGate(settingsSocial, session, 'name_drop'), true, 'اجتماعي: الرد على ذكر اسمه يعمل');
        console.log('✅ 6) الوضعان مختلفان: تلقائي (يلعب بصمت) ≠ اجتماعي (يلعب ويتفاعل)');
    }

    // ═══ 7) رد على رسالة اللوبي نفسها (reply) في الوضع الاجتماعي ═══
    {
        sessions.__reset();
        setSettings({ enabled: true, social: { enabled: true }, engines: { mafia: { enabled: true, mode: 'social' } } });
        aiReply = 'جاهزين يا جماعة؟';
        const channelSends = [];
        const lobby = makeMessage({
            id: 'lobby_reply_msg_7',
            content: '🎮 لوبي المافيا — من يريد اللعب؟',
            components: [{ components: [btn('انضمام', 'join_inbox_7')] }],
        }, channelSends);
        await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT, runtimeSettings });
        await wait(120);
        const replySends = channelSends.filter(c => c && typeof c === 'object' && c.reply && c.reply.messageReference === 'lobby_reply_msg_7');
        assert.ok(replySends.length >= 1, `رد على رسالة اللوبي نفسها بميزة الرد — وجدنا ${replySends.length}`);
        console.log('✅ 7) رد اللوبي: جاء كرد على رسالة اللوبي نفسها (messageReference) — «يرد أو لا»');
    }

    // ═══ 8) «فقط أول مرة»: الجلسة لا تموت أثناء صمت مراحل الليل ═══
    {
        sessions.__reset();
        const session = sessions.startSession(AGENT, GUILD, { engineId: 'mafia', channelId: CHANNEL, botId: GAME_BOT_ID, gameName: 'مافيا' });
        // محاكاة: 20 دقيقة صمت قناتي (مراحل ليل على الخاص) — كانت تموت بعد 15
        session.lastSeenAt = Date.now() - 20 * 60 * 1000;
        assert.ok(sessions.getSession(AGENT, GUILD), 'بعد 20 دقيقة صمت الجلسة حية (كانت تموت — سبب «فقط أول مرة يعرف»)');
        // بعد 46 دقيقة: تنتهي طبيعياً (تنظيف كاسول بلا مؤقتات)
        session.lastSeenAt = Date.now() - 46 * 60 * 1000;
        assert.strictEqual(sessions.getSession(AGENT, GUILD), null, 'بعد 46 دقيقة تنتهي طبيعياً');
        console.log('✅ 8) العمر: 45 دقيقة بدل 15 — مراحل الليل لا تمحو وعيه («فقط أول مرة» انتهت)');
    }

    // ═══ 9) الهوية: «أنت اللاعب X» — لا يحسب نفسه بوتاً آخر ═══
    {
        sessions.__reset();
        const channelSends = [];
        const lobby = makeMessage({
            content: '🎮 لوبي المافيا!',
            components: [{ components: [btn('انضمام', 'join_inbox_9')] }],
        }, channelSends);
        await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT, runtimeSettings });
        await wait(40);
        const ctx = player.buildLiveGameContext({ agentId: AGENT, guildId: GUILD });
        assert.ok(ctx.includes(`أنت اللاعب «${AGENT_NAME}»`), 'الهوية الأولى: أنت اللاعب — لا بوت آخر');
        assert.ok(ctx.includes(AGENT_USER_ID), 'معرفه في السياق — كل منشن له يعني هو');
        const summary = sessions.contextSummary(sessions.getSession(AGENT, GUILD));
        assert.ok(summary.includes('أي منشن لك في اللعبة يعني أنت'), 'الملخص يشرح الهوية للذكاء');
        console.log('✅ 9) الهوية: «أنت اللاعب X ومعرفك ...» — لا «البوت فاز» بعد اليوم');
    }

    // ═══ 10) «من في اللعبة؟ بمن تشك؟» — السياق يجيب بالأسماء والعدد ═══
    {
        const session = sessions.getSession(AGENT, GUILD);
        sessions.mafiaSetPlayers(AGENT, GUILD, [
            { id: P1, name: 'سامي' }, { id: P2, name: 'خالد' }, { id: P3, name: 'فهد' },
        ]);
        sessions.mafiaMarkDead(AGENT, GUILD, P3);
        const ctx = player.buildLiveGameContext({ agentId: AGENT, guildId: GUILD });
        assert.ok(ctx.includes('لاعبو الجولة (4)') || ctx.includes('لاعبو الجولة (3)'), `العدد في السياق`);
        assert.ok(ctx.includes('سامي (حي)') && ctx.includes('خالد (حي)'), 'الأسماء بحالتها الحية');
        assert.ok(ctx.includes('فهد (ميت)'), 'الموتى معروفون — يعرف من قُتل');
        assert.ok(ctx.includes('إن سألك أحد «من في اللعبة؟»'), 'توجيه صريح: أسئلة اللعبة تُجاب من المعلومات');
        console.log('✅ 10) سؤال «من في اللعبة؟» له جواب حقيقي: أسماء + حالة + عدد');
    }

    // ── تنظيف ──
    player.agentStop(AGENT);
    overrides.clear();
    sessions.__reset();

    console.log('\n🏆 games_inbox: كل المجموعات خضراء');
}

run().then(() => {
    process.exit(0);
}).catch((error) => {
    console.error('❌ games_inbox.test.js فشل:', error);
    process.exit(1);
});
