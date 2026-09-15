/**
 * games/sessions.js — جلسات اللعب الحية (v7.15)
 * ═══════════════════════════════════════════════════════════
 * ذاكرة قصيرة العمر لكل (وكيل × سيرفر) وهو داخل لعبة فعلياً:
 *   - تبدأ عند انضمام ناجح (roulette/karasi/replka...)
 *   - تُلمس عند كل حركة/دور
 *   - تنتهي عند نتيجة (فوز/خسارة) أو بلا نشاط 15 دقيقة (تنظيف كاسول
 *     عند القراءة — بلا مؤقتات ولا تسريبات)
 *
 * تُستخدم من ثلاث جهات:
 *   1) كشف النتائج: لا نتيجة تُسجَّل لوكيل ليس داخل جلسة على هذا السيرفر
 *      (يقتل الخسائر المزيفة من رسائل اللوبي والبحث عن لاعبين)
 *   2) معالج دور الروليت: لا ضغط خارج جلسة حية
 *   3) التفاعل الاجتماعي: سياق الذكاء (اللاعبون، الأصدقاء، المطرودون،
 *      آخر كلام القناة، حالة الكتم والتبريد)
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const TTL_MS = 15 * 60 * 1000;      // جولة عالقة تنتهي وحدها بعد 15 دقيقة صمت
const CHAT_RING_MAX = 12;           // آخر كلام القناة الذي يراه الذكاء
const EVENTS_MAX = 8;               // آخر أحداث اللعبة التي يراها الذكاء
const LOBBY_TEXT_MAX = 400;         // نص اللوبي المخزّن
const sessions = new Map();         // `${agentId}:${guildId}` → session

function key(agentId, guildId) {
    return `${String(agentId)}:${String(guildId)}`;
}

function newSession(data = {}) {
    return {
        engineId  : data.engineId || null,
        channelId : data.channelId || null,
        botId     : data.botId || null,
        guildName : data.guildName || null,
        gameName  : data.gameName || null,
        joinedAt  : Date.now(),
        lastSeenAt: Date.now(),
        // 🧑‍🤝‍🧑 من لعب معه / من تحدث معه
        players   : new Set(),   // معرفات من ظهروا في رسائل اللعبة
        friends   : new Set(),   // من كلّمه أو ذكر اسمه في الشات (أصدقاء الجلسة)
        kicked    : new Set(),   // من طُرد أمام عينيه
        // 💬 التفاعل الاجتماعي
        chatRing  : [],          // [{ name, text, at }]
        socialCount      : 0,    // كم مرة تكلم هذه الجلسة
        lastSocialAt     : 0,    // آخر تكلم (تبريد عام)
        lastMentionReply : new Map(), // userId → ts (تبريد لكل شخص)
        // 🕵️ المافيا (v7.16) — ذاكرة الدور واللاعبين ومن سكت
        talkCounts: new Map(),   // userId → كم رسالة كتبها في الشات خلال الجلسة
        // 🧠 الوعي (v7.17 — بلاغ المالك: «رسالة اللوبي نفسها تُرسل للوكيل»)
        lobbyText : null,        // نص رسالة اللوبي كما وصلت — يقرأه الذكاء
        events    : [],          // سجل ما يحصل في اللعبة (آخر 8) — «لا يعرف ماذا يحصل بها»
        mafia     : {
            role  : null,        // 'mafia' | 'doctor' | 'detective' | 'citizen' | null
            phase : 'lobby',     // lobby | roles | night_kill | night_save | day | day_discuss | day_vote | ended
            players: new Map(),  // id → { name, talks, alive }
            lastVictim: null,    // آخر قتيل { id, name, role }
        },
    };
}

/** اقرأ الجلسة الحية — مع انتهاء صلاحية كاسول (بلا مؤقتات) */
function getSession(agentId, guildId) {
    const k = key(agentId, guildId);
    const session = sessions.get(k);
    if (!session) return null;
    if (Date.now() - session.lastSeenAt > TTL_MS) {
        sessions.delete(k);
        return null;
    }
    return session;
}

/** ابدأ جلسة (انضمام ناجح) — تستبدل أي جلسة قديمة على نفس السيرفر */
function startSession(agentId, guildId, data = {}) {
    const session = newSession(data);
    sessions.set(key(agentId, guildId), session);
    return session;
}

/** لمّس الجلسة (حركة/دور/رسالة لعبة) — يطيل العمر فقط */
function touchSession(agentId, guildId) {
    const session = getSession(agentId, guildId);
    if (session) session.lastSeenAt = Date.now();
    return session || null;
}

/** أنهِ الجلسة (نتيجة/إيقاف) */
function endSession(agentId, guildId) {
    return sessions.delete(key(agentId, guildId));
}

function endAllForAgent(agentId) {
    const prefix = `${String(agentId)}:`;
    let ended = 0;
    for (const k of [...sessions.keys()]) {
        if (k.startsWith(prefix)) { sessions.delete(k); ended += 1; }
    }
    return ended;
}

// ════════════════════════════════════════════════════════════
//  مراقبة الشات — حلقة الكلام + الأصدقاء
// ════════════════════════════════════════════════════════════

/** سجّل كلمة بشرية في حلقة القناة (يقرأها الذكاء عند تعليقه) */
function pushChatLine(agentId, guildId, { name, text }) {
    const session = getSession(agentId, guildId);
    if (!session) return null;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean) return session;
    session.chatRing.push({ name: String(name || 'لاعب').slice(0, 40), text: clean, at: Date.now() });
    if (session.chatRing.length > CHAT_RING_MAX) session.chatRing.shift();
    return session;
}

/** سجّل لاعباً ظهر في رسائل اللعبة */
function addPlayer(agentId, guildId, userId) {
    const session = getSession(agentId, guildId);
    if (session && userId) session.players.add(String(userId));
    return session;
}

/** صديق = كلّم الوكيل أو ذكر اسمه في الشات خلال الجلسة */
function addFriend(agentId, guildId, userId) {
    const session = getSession(agentId, guildId);
    if (session && userId) session.friends.add(String(userId));
    return session;
}

// ════════════════════════════════════════════════════════════
//  🧠 الوعي (v7.17) — «رسالة اللوبي نفسها تُرسل للوكيل» و«لا يعرف
//  ماذا يحصل بها» — نص اللوبي + سجل أحداث يقرؤهما الذكاء في كل قرار
//  وكلام، وسياق المحادثة الرئيسية يبثهما حين يسأله أحد وهو داخل لعبة
// ════════════════════════════════════════════════════════════

/** خزّن نص رسالة اللوبي الحقيقي (يُقص) — يقرأه الذكاء حرفياً */
function setLobbyText(agentId, guildId, text) {
    const session = getSession(agentId, guildId);
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, LOBBY_TEXT_MAX);
    if (session && clean) session.lobbyText = clean;
    return session;
}

/** سجّل حدثاً في سجل الوعي — «ماذا يحصل الآن» */
function pushEvent(agentId, guildId, text) {
    const session = getSession(agentId, guildId);
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!session || !clean) return session;
    session.events.push({ at: Date.now(), text: clean });
    if (session.events.length > EVENTS_MAX) session.events.shift();
    return session;
}

function addKicked(agentId, guildId, userId) {
    const session = getSession(agentId, guildId);
    if (session && userId) session.kicked.add(String(userId));
    return session;
}

// ════════════════════════════════════════════════════════════
//  🕵️ المافيا — ذاكرة الدور واللاعبين ومن سكت (v7.16)
// ════════════════════════════════════════════════════════════

/** عدّاد الكلام — كل رسالة بشرية في قناة الجلسة تزيد عداد صاحبها
 *  (الذكاء يشك في من لم يتكلم طوال الجولة — بلاغ المالك) */
function bumpTalk(agentId, guildId, userId) {
    const session = getSession(agentId, guildId);
    if (!session || !userId) return session;
    const id = String(userId);
    session.talkCounts.set(id, (session.talkCounts.get(id) || 0) + 1);
    const player = session.mafia.players.get(id);
    if (player) player.talks = session.talkCounts.get(id);
    return session;
}

function mafiaSetRole(agentId, guildId, role) {
    const session = getSession(agentId, guildId);
    if (session && role) session.mafia.role = String(role);
    return session;
}

function mafiaSetPhase(agentId, guildId, phase) {
    const session = getSession(agentId, guildId);
    if (session && phase) session.mafia.phase = String(phase);
    return session;
}

/** سجّل لاعبي اللوبي (منشن من رسالة اللوبي) — «يعرف من يلعب معه بالضبط والعدد» */
function mafiaSetPlayers(agentId, guildId, entries = []) {
    const session = getSession(agentId, guildId);
    if (!session) return null;
    for (const entry of entries) {
        if (!entry || !entry.id) continue;
        session.mafia.players.set(String(entry.id), {
            name: String(entry.name || 'لاعب').slice(0, 60),
            talks: session.talkCounts.get(String(entry.id)) || 0,
            alive: entry.alive !== false,
        });
        session.players.add(String(entry.id));
    }
    return session;
}

function mafiaMarkDead(agentId, guildId, userId) {
    const session = getSession(agentId, guildId);
    const id = String(userId || '');
    if (session && id && id !== 'undefined') {
        const player = session.mafia.players.get(id);
        if (player) player.alive = false;
        session.mafia.lastVictim = { id, name: player ? player.name : null, role: null };
    }
    return session;
}

/** ابحث عن جلسة مافيا حية لهذا الوكيل من بوت معيّن — لرسائل الخاص السرية
 *  (رسالة «اختار شخصا لاغتياله» تأتي على الخاص من بوت اللعبة نفسه) */
function findMafiaSessionByBot(agentId, botId) {
    const prefix = `${String(agentId)}:`;
    for (const [k, session] of sessions.entries()) {
        if (!k.startsWith(prefix)) continue;
        if (session.engineId !== 'mafia') continue;
        if (String(session.botId || '') !== String(botId || '')) continue;
        if (Date.now() - session.lastSeenAt > TTL_MS) { sessions.delete(k); continue; }
        return { guildId: k.slice(prefix.length), session };
    }
    return null;
}

/** اسم من قائمة أزرار/لاعبين موجود في الخريطة؟ (مطابقة عربية متسامحة) */
function normalizeName(name) {
    return String(name || '')
        .replace(/[أإآ]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/ة/g, 'ه')
        .replace(/[\u200c-\u200f\u0640]/g, '')
        .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** ملخص سياق للذكاء الاصطناعي — قصير دائماً */
function contextSummary(session) {
    if (!session) return '';
    const lines = [];
    lines.push(`- اللعبة: ${session.gameName || 'غير معروفة'}`);
    if (session.lobbyText) lines.push(`- رسالة اللوبي كما وصلت: «${session.lobbyText}»`);
    if (session.kicked.size) lines.push(`- المطرودون: ${[...session.kicked].length} لاعب`);
    if (session.players.size) lines.push(`- لاعبون مرئيون: ${session.players.size}`);
    if (session.friends.size) lines.push(`- تحدث معك: ${session.friends.size} لاعب`);
    if (session.events.length) {
        lines.push('- ما يحصل في اللعبة (الأحدث أولاً):');
        for (const ev of session.events.slice(-4).reverse()) {
            lines.push(`  • ${ev.text}`);
        }
    }
    // 🕵️ حالة المافيا — الدور واللاعبون الأحياء ومن سكت
    if (session.engineId === 'mafia' || session.mafia.role) {
        lines.push(`- دورك في المافيا: ${session.mafia.role || 'غير معروف بعد'}`);
        lines.push(`- مرحلة اللعبة: ${session.mafia.phase}`);
        if (session.mafia.players.size) {
            const alive = [...session.mafia.players.entries()].filter(([, p]) => p.alive);
            lines.push(`- اللاعبون الأحياء (${alive.length}): ${alive.map(([, p]) => p.name).join('، ') || '—'}`);
            const silent = alive.filter(([, p]) => (p.talks || 0) === 0).map(([, p]) => p.name);
            if (silent.length) lines.push(`- صامتون طوال الجولة (مشتبه بهم): ${silent.join('، ')}`);
            const friends = alive.filter(([id]) => session.friends.has(id)).map(([, p]) => p.name);
            if (friends.length) lines.push(`- أصدقاؤك منهم: ${friends.join('، ')}`);
            if (session.mafia.lastVictim) lines.push(`- آخر قتيل: ${session.mafia.lastVictim.name || session.mafia.lastVictim.id}`);
        }
    }
    if (session.chatRing.length) {
        lines.push('- آخر كلام القناة:');
        for (const item of session.chatRing.slice(-6)) {
            lines.push(`  • ${item.name}: ${item.text}`);
        }
    }
    return lines.join('\n');
}

/**
 * 🧠 سياق «أنا ألعب الآن» للمحادثة الرئيسية (v7.17) — بلاغ المالك:
 * «ولا يعرف اللعبة اصلا ولا يعرف ماذا يحصل بها» — حين يكلّمه أحد وهو
 * داخل جلسة لعبة حية يرى عقله كل شيء: اللوبي، اللاعبون، الدور، المرحلة،
 * الأحداث الأخيرة. بلا جلسة → null (صفر تغيير على المحادثة العادية).
 */
function buildLiveGameContext({ agentId, guildId, now = Date.now } = {}) {
    const session = getSession(String(agentId || ''), String(guildId || ''));
    if (!session) return null;
    const minutes = Math.max(0, Math.round(((now() || Date.now()) - session.joinedAt) / 60000));
    const lines = [];
    lines.push('[🎮 أنت داخل لعبة جارية الآن — لا تذكر أنك ذكاء اصطناعي]');
    lines.push(`- اللعبة: ${session.gameName || 'غير معروفة'} — بدأت قبل ~${minutes} دقيقة في قناة هذه المحادثة أو جارتها`);
    if (session.lobbyText) lines.push(`- رسالة اللوبي التي انضممت بعدها: «${session.lobbyText}»`);
    if (session.mafia.players.size) {
        const alive = [...session.mafia.players.values()].filter(p => p.alive);
        lines.push(`- اللاعبون معك (${alive.length}): ${alive.map(p => p.name).join('، ') || '—'}`);
    }
    if (session.engineId === 'mafia' || session.mafia.role) {
        lines.push(`- دورك في المافيا: ${session.mafia.role || 'غير معروف بعد'} — المرحلة: ${session.mafia.phase}`);
        if (session.mafia.lastVictim) lines.push(`- آخر قتيل: ${session.mafia.lastVictim.name || session.mafia.lastVictim.id}`);
    }
    if (session.events.length) {
        lines.push('- آخر ما حدث (الأحدث أولاً):');
        for (const ev of session.events.slice(-5).reverse()) lines.push(`  • ${ev.text}`);
    }
    lines.push('- إن سألك أحد عن اللعبة فأجب كلاعب يعرف ما يجري حوله تماماً.');
    return lines.join('\n');
}

/** للاختبار */
function __reset() { sessions.clear(); }

module.exports = {
    TTL_MS,
    CHAT_RING_MAX,
    getSession,
    startSession,
    touchSession,
    endSession,
    endAllForAgent,
    pushChatLine,
    addPlayer,
    addFriend,
    addKicked,
    contextSummary,
    // 🕵️ المافيا (v7.16)
    bumpTalk,
    mafiaSetRole,
    mafiaSetPhase,
    mafiaSetPlayers,
    mafiaMarkDead,
    findMafiaSessionByBot,
    normalizeName,
    // 🧠 الوعي (v7.17)
    setLobbyText,
    pushEvent,
    buildLiveGameContext,
    __reset,
};
