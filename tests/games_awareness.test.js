/**
 * tests/games_awareness.test.js — وعي الوكيل باللعبة (v7.17 + تحديثات v7.18)
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالك الحرفي: «إلى الآن هو فاشل — عند بدأ لعبة ويدخل لها اريد
 * رسالة اللوبي نفسها يتم إرسالها للوكيل وهو حاليا لا يفعل ذلك —
 * ووضع التلقائي او الاجتماعي لا يوجد اختلاف بيهم الاثنان لا يتفاعلون —
 * ولا يعرف اللعبة ولا اعرف انه الان يلعب — ولا يعرف ماذا يحصل بها —
 * ويحسب انه البوت الذي فاز وليس هو من فاز».
 *
 * يثبت بالفحص الفعلي:
 *  1) الوضع التلقائي (v7.18): يلعب ويقرر بعقله لكن يكتم الشات —
 *     ردود موقعه فقط (الدور/الموت/الفوز) — الفرق الحقيقي عن الاجتماعي.
 *  2) رسالة اللوبي نفسها تُخزّن في الجلسة حرفياً + اللاعبون بالأسماء.
 *  3) كل مرحلة تُسجّل في سجل الوعي + القرار دائماً بعقل الوكيل حتى في التلقائي
 *     (v7.18: «لا يختار هو اصلا من يقتل او على من يصوت» — انتهت).
 *  4) الوضع الاجتماعي (أو الذكي القديم) يتكلم كاملاً حتى بلا زر 🫧.
 *  5) اللوبي تصل قرار الذكاء حرفياً (برومبت التصويت يحوي نص اللوبي).
 *  6) فشل الذكاء يصبح مرئياً للمالك.
 *  7) الاحتساب الصحيح: قائمة الفائزين في إيمبد فيها اسمنا → فوز لنا.
 *  8) نصوص النتائج لا لبس فيها: «الوكيل «X» فاز فعلاً».
 *  9) سياق المحادثة الرئيسية يرى اللعبة الحية (buildLiveGameContext).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- حقن config ومزود وهمي قبل أي تتطلب ----------

const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const providersPath = require.resolve(path.join(__dirname, '..', 'providers', 'index.js'));

// 🧠 مزود وهمي نتحكم به: نجاح/فشل + التقاط البرومبت (إثبات وصول اللوبي)
let providerMode = 'ok';        // 'ok' | 'throw'
let providerReply = 'سامي';
let lastPrompt = null;
let promptCalls = 0;
const fakeProvider = {
    chat: async ({ prompt } = {}) => {
        promptCalls += 1;
        lastPrompt = String(prompt || '');
        if (providerMode === 'throw') throw new Error('provider down');
        return { fullText: providerReply };
    },
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

const AGENT_A = 'aa10000000000000000000aa'; // 24 hex
const GUILD = 'g111111111111111111';
const CHANNEL = 'c222222222222222222';
const GAME_BOT_ID = '1508592252220477651';
const AGENT_USER_ID = '999000111222333444';
const P1_ID = '555000111222333001'; // سامي
const P2_ID = '777000111222333002'; // خالد
const P3_ID = '777000111222333003'; // فهد

// ⏱️ توقيت فوري + احتمالات مؤكدة — اختبارات حتمية
const hooks = social.__testHooks();
hooks.TIMING.minDelay = 1;
hooks.TIMING.maxDelay = 2;
for (const key of Object.keys(hooks.CHANCES)) hooks.CHANCES[key] = 1.0;

// ---------- إعدادات بالذاكرة ----------

const overrides = new Map();
const origGet = store.getGameSettings;
store.getGameSettings = async (agentId, guildId) => {
    const key = `${String(agentId)}:${String(guildId)}`;
    if (overrides.has(key)) return overrides.get(key);
    return origGet(agentId, guildId);
};

function setSettings(agentId, patch) {
    overrides.set(`${String(agentId)}:${GUILD}`, {
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
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر الاختبار' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (c) => ({ content: c }) }) },
    };
}

function btn(label, customId, { style = 1 } = {}) {
    return { type: 'BUTTON', label, custom_id: customId, customId, style, disabled: false };
}

function makeMessage(overridesMsg = {}) {
    const clicks = [];
    const message = {
        id: overridesMsg.id || `m${Math.random().toString(36).slice(2)}`,
        guild: { id: GUILD, name: 'سيرفر الاختبار' },
        channel: { id: CHANNEL, send: async () => {}, sendTyping: async () => {} },
        author: { id: GAME_BOT_ID, bot: true },
        content: '',
        embeds: [],
        components: [],
        mentions: { has: () => false },
        clickButton: async (customId) => { clicks.push(customId); },
        ...overridesMsg,
    };
    message.__clicks = clicks;
    return message;
}

const runtimeSettings = { agentId: AGENT_A, agentName: 'وكيل أ', provider: 'deepseek', providerConfig: {}, kind: 'agent' };

function recentTexts(agentId) {
    return store.getRecentEvents(agentId).map(e => e.text || '');
}

/** دخول مافيا كامل عبر خط الأنابيب — يعيد رسالة اللوبي */
async function joinMafia({ players = [] } = {}) {
    const mentionUsers = new Map(players.map(p => [p.id, { id: p.id, username: p.username, globalName: p.username }]));
    const lobby = makeMessage({
        content: '🎮 تم إنشاء لعبة مافيا! اضغط للانضمام — ابدأ اللعبة عندما يكتمل العدد',
        components: [{ components: [btn('انضمام', `mafia_join_${Math.random().toString(36).slice(2, 8)}`)] }],
        mentions: { has: () => false, users: mentionUsers },
    });
    await player.handleMessage({ client: makeClient(), message: lobby, agentId: AGENT_A, runtimeSettings });
    return lobby;
}

// ════════════════════════════════════════════════════════════

async function run() {
    player.agentReady({ client: makeClient(), agentId: AGENT_A, agentName: 'وكيل أ', tokenType: 'user', kind: 'agent' });

    // ── 1) الوضع التلقائي (v7.18): يلعب ويقرر بعقله لكن يكتم الشات —
    // ردود موقعه فقط (الدور/الموت/الفوز) — الفرق الحقيقي عن الاجتماعي ──
    setSettings(AGENT_A, { enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'auto' } } });
    {
        await joinMafia();
        const rolesMsg = makeMessage({ content: '✅ | تم توزيع الرتب على اللاعبين. ستبدأ الجولة الأولى في بضع ثاني' });
        await player.handleMessage({ client: makeClient(), message: rolesMsg, agentId: AGENT_A, runtimeSettings });
        await wait(60);
        const settings = overrides.get(`${AGENT_A}:${GUILD}`);
        const session = sessions.getSession(AGENT_A, GUILD);
        // 🧠 v7.18: بوابة النوع — التلقائي يكتم الشات (شك/ندبة/رد على ذكر اسمه)
        assert.strictEqual(social.speechGate(settings, session, 'suspect'), false, 'التلقائي: الشك مكتوم');
        assert.strictEqual(social.speechGate(settings, session, 'name_drop'), false, 'التلقائي: الرد على ذكر اسمه مكتوم');
        assert.strictEqual(social.speechGate(settings, session, 'beg'), false, 'التلقائي: الترجي مكتوم');
        // لكن ردود موقعه تعمل — رد الفعل على بطاقة الدور جزء من اللعب نفسه
        assert.strictEqual(social.speechGate(settings, session, 'role_generic'), true, 'التلقائي: رد الفعل على الدور يعمل');
        assert.strictEqual(social.speechGate(settings, session, 'killed'), true, 'التلقائي: تعليق موته يعمل');
        assert.ok(recentTexts(AGENT_A).some(t => t.includes('تعليق اجتماعي')), 'التلقائي رد على توزيع الرتب (رد موقع هو)');
        assert.strictEqual(session.mafia.phase, 'roles', 'المرحلة سُجلت');
    }

    // ── 2) رسالة اللوبي نفسها محفوظة حرفياً + اللاعبون بأسمائهم ──
    {
        const players = [
            { id: P1_ID, username: 'سامي' },
            { id: P2_ID, username: 'خالد' },
            { id: P3_ID, username: 'فهد' },
        ];
        const lobby = await joinMafia({ players });
        const session = sessions.getSession(AGENT_A, GUILD);
        assert.ok(session, 'جلسة مافيا حية بعد الانضمام');
        assert.ok(session.lobbyText && session.lobbyText.includes('تم إنشاء لعبة مافيا'),
            'نص اللوبي نفسه محفوظ — لم يعد يُرمى');
        assert.strictEqual(session.mafia.players.size, 3, 'اللاعبون الثلاثة مسجلون');
        assert.ok([...session.mafia.players.values()].some(p => p.name === 'سامي'), 'اسم اللاعب سامي محفوظ');
        assert.ok(session.events.some(e => e.text.includes('دخلنا اللوبي')), 'حدث الدخول في سجل الوعي');
        assert.ok(lobby.__clicks.length === 1, 'الانضمام ضغط الزر فعلاً');
    }

    // ── 3) كل مرحلة تُسجّل في سجل الوعي + القرار دائماً بعقل الوكيل (v7.18) ──
    {
        const nightMsg = makeMessage({ content: '🔪 | جاري انتظار المافيا لاختيار شخص لقتله...' });
        await player.handleMessage({ client: makeClient(), message: nightMsg, agentId: AGENT_A, runtimeSettings });
        const killMsg = makeMessage({ content: `⚰️ | نجحت عملية المافيا وتم قتل <@${P1_ID}> وهذا الشخص كان **مواطن**` });
        await player.handleMessage({ client: makeClient(), message: killMsg, agentId: AGENT_A, runtimeSettings });
        // 🧠 v7.18: حتى في الوضع التلقائي القرار بعقل الوكيل — العشوائي احتياط فشل فقط
        providerMode = 'ok';
        providerReply = 'فهد';
        const beforeCalls = promptCalls;
        const voteMsg = makeMessage({
            content: 'لديكم **15 ثانية** لاختيار شخص لطرده من اللعبة',
            components: [{ components: [btn('خالد', 'vote_khalid'), btn('فهد', 'vote_fahad')] }],
        });
        await player.handleMessage({ client: makeClient(), message: voteMsg, agentId: AGENT_A, runtimeSettings });
        await wait(30);

        const session = sessions.getSession(AGENT_A, GUILD);
        const texts = session.events.map(e => e.text).join(' | ');
        assert.ok(texts.includes('توزيع الرتب') || session.events.length >= 3, 'مراحل متعددة في السجل');
        assert.ok(texts.includes('المافيا ستختار ضحية'), 'ليل القتل مسجل');
        assert.ok(texts.includes('قتلت المافيا «سامي»'), 'القتيل مسجل باسمه — لا معرفات مجهولة');
        assert.ok(texts.includes('صوّت على طرد'), 'التصويت مسجل في الوعي');
        assert.ok(promptCalls > beforeCalls, 'الذكاء استُشير حتى في الوضع التلقائي (قراره هو لا العشوائي)');
        assert.deepStrictEqual(voteMsg.__clicks, ['vote_fahad'], 'ضغط اختيار الذكاء نفسه');
        assert.strictEqual(session.mafia.players.get(P1_ID).alive, false, 'سامي ميت في الذاكرة');
    }

    // ── 4) الوضع الذكي ≠ التلقائي: ذكي + زر اجتماعي معطل → الكلام يعمل ──
    {
        setSettings(AGENT_A, { enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'ai' } } });
        providerMode = 'ok';
        providerReply = 'يا رب مافيا الليلة';
        await joinMafia({ players: [{ id: P2_ID, username: 'خالد' }] });
        const rolesMsg = makeMessage({ content: '✅ | تم توزيع الرتب على اللاعبين. ستبدأ الجولة الأولى في بضع ثاني' });
        await player.handleMessage({ client: makeClient(), message: rolesMsg, agentId: AGENT_A, runtimeSettings });
        await wait(120);
        const socials = recentTexts(AGENT_A).filter(t => t.includes('تعليق اجتماعي'));
        assert.ok(socials.length >= 1, 'الوضع الذكي كلم حتى مع زر 🫧 معطلاً — هذا هو الفرق عن التلقائي');
        const session = sessions.getSession(AGENT_A, GUILD);
        assert.strictEqual(session.mafia.phase, 'roles', 'المرحلة سُجلت');
    }

    // ── 5) اللوبي تصل قرار الذكاء حرفياً (برومبت التصويت) ──
    {
        setSettings(AGENT_A, { enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'ai' } } });
        providerMode = 'ok';
        providerReply = 'فهد';
        const before = promptCalls;
        const voteMsg = makeMessage({
            content: 'لديكم **15 ثانية** لاختيار شخص لطرده من اللعبة',
            components: [{ components: [btn('خالد', 'vote_k2'), btn('فهد', 'vote_f2')] }],
        });
        await player.handleMessage({ client: makeClient(), message: voteMsg, agentId: AGENT_A, runtimeSettings });
        await wait(30);
        assert.ok(promptCalls > before, 'الذكاء استُشير فعلاً في الوضع الذكي');
        assert.ok(lastPrompt.includes('تم إنشاء لعبة مافيا'), 'نص اللوبي نفسه داخل برومبت الذكاء');
        assert.ok(lastPrompt.includes('خالد') && lastPrompt.includes('فهد'), 'أسماء اللاعبين داخل برومبت الذكاء');
        assert.deepStrictEqual(voteMsg.__clicks, ['vote_f2'], 'الذكاء اختار «فهد» وضُغط زره');
    }

    // ── 6) فشل الذكاء يصبح مرئياً — كان صامتاً فبدا الذكي = التلقائي ──
    {
        setSettings(AGENT_A, { enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'ai' } } });
        providerMode = 'throw';
        await joinMafia({ players: [{ id: P2_ID, username: 'خالد' }] });
        const rolesMsg = makeMessage({ content: '✅ | تم توزيع الرتب على اللاعبين. ستبدأ الجولة الأولى في بضع ثاني' });
        await player.handleMessage({ client: makeClient(), message: rolesMsg, agentId: AGENT_A, runtimeSettings });
        await wait(120);
        const failNotes = recentTexts(AGENT_A).filter(t => t.includes('استشارة الذكاء فشلت'));
        assert.ok(failNotes.length >= 1, 'فشل الذكاء ظاهر في آخر الأحداث — السبب مرئي للمالك');
        assert.ok(failNotes[0].includes('provider down'), 'سبب الفشل الحقيقي في التقرير');
        providerMode = 'ok';
    }

    // ── 7) الاحتساب الصحيح: قائمة الفائزين في إيمبد فيها اسمنا → فوز لنا ──
    {
        setSettings(AGENT_A, { enabled: true, social: { enabled: false }, engines: { mafia: { enabled: true, mode: 'auto' } } });
        await joinMafia({ players: [{ id: P2_ID, username: 'خالد' }] });
        const winsBefore = store.statsFor(AGENT_A, GUILD).wins;

        // قائمة فائزين في إيمبد (منشنات الإيمبد لا تصل message.mentions — الحالة المكسورة سابقاً)
        const winEmbed = makeMessage({
            embeds: [{ title: '🏁 نهاية المافيا', description: `الفائزون: <@${P2_ID}> <@${AGENT_USER_ID}>` }],
            mentions: { has: () => false }, // لا منشن في content — بالضبط حالة الإيمبد
        });
        await player.handleMessage({ client: makeClient(), message: winEmbed, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(store.statsFor(AGENT_A, GUILD).wins, winsBefore + 1, 'فوزنا في إيمبد قائمة الفائزين يُحسب لنا الآن');
        assert.ok(recentTexts(AGENT_A).some(t => t.includes('فاز فعلاً') && t.includes('وكيل أ')), 'النص يقول: الوكيل «وكيل أ» فاز فعلاً — لا لبس');

        // قائمة بلا اسمنا → لا شيء
        const otherWin = makeMessage({
            embeds: [{ description: `الفائزون: <@${P2_ID}> <@${P3_ID}>` }],
            mentions: { has: () => false },
        });
        const lossesBefore = store.statsFor(AGENT_A, GUILD).losses;
        await player.handleMessage({ client: makeClient(), message: otherWin, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(store.statsFor(AGENT_A, GUILD).wins, winsBefore + 1, 'فوز غيرنا لا يُحسب لنا');

        // قتلنا نحن → killed، وقالب غيرنا → لا شيء
        const killedMe = makeMessage({ content: `⚰️ | نجحت عملية المافيا وتم قتل <@${AGENT_USER_ID}> وهذا الشخص كان مواطن` });
        await player.handleMessage({ client: makeClient(), message: killedMe, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(store.statsFor(AGENT_A, GUILD).losses, lossesBefore + 1, '«تم قتل <نحن>» = موتنا يُحسب صحياً');
        assert.ok(recentTexts(AGENT_A).some(t => t.includes('قُتل في المافيا') && t.includes('وكيل أ')), 'النص يقول: الوكيل «وكيل أ» قُتل');

        const killedOther = makeMessage({ content: `⚰️ | نجحت عملية المافيا وتم قتل <@${P3_ID}> وهذا الشخص كان مواطن` });
        await player.handleMessage({ client: makeClient(), message: killedOther, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(store.statsFor(AGENT_A, GUILD).losses, lossesBefore + 1, 'قتل غيرنا لا يُحسب صحياً');
    }

    // ── 8) سياق المحادثة الرئيسية يرى اللعبة الحية ──
    {
        await joinMafia({ players: [{ id: P2_ID, username: 'خالد' }, { id: P3_ID, username: 'فهد' }] });
        const ctx = player.buildLiveGameContext({ agentId: AGENT_A, guildId: GUILD });
        assert.ok(ctx, 'سياق حي عند وجود جلسة');
        assert.ok(ctx.includes('أنت داخل لعبة جارية'), 'العقل يعرف أنه يلعب الآن');
        assert.ok(ctx.includes('تم إنشاء لعبة مافيا'), 'العقل يرى رسالة اللوبي نفسها');
        assert.ok(ctx.includes('خالد') && ctx.includes('فهد'), 'العقل يعرف من يلعب معه بالأسماء');

        const lonely = player.buildLiveGameContext({ agentId: 'bb20000000000000000000bb', guildId: GUILD });
        assert.strictEqual(lonely, null, 'بلا جلسة → null — صفر تغيير على المحادثة العادية');
    }

    // ── تنظيف ──
    player.agentStop(AGENT_A);
    overrides.clear();
    sessions.__reset();

    console.log('🏆 games_awareness: كل المجموعات خضراء');
}

run().catch((error) => {
    console.error('❌ games_awareness.test.js فشل:', error);
    process.exit(1);
});
