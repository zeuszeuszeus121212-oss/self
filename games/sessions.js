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

function addKicked(agentId, guildId, userId) {
    const session = getSession(agentId, guildId);
    if (session && userId) session.kicked.add(String(userId));
    return session;
}

/** ملخص سياق للذكاء الاصطناعي — قصير دائماً */
function contextSummary(session) {
    if (!session) return '';
    const lines = [];
    lines.push(`- اللعبة: ${session.gameName || 'غير معروفة'}`);
    if (session.kicked.size) lines.push(`- المطرودون: ${[...session.kicked].length} لاعب`);
    if (session.players.size) lines.push(`- لاعبون مرئيون: ${session.players.size}`);
    if (session.friends.size) lines.push(`- تحدث معك: ${session.friends.size} لاعب`);
    if (session.chatRing.length) {
        lines.push('- آخر كلام القناة:');
        for (const item of session.chatRing.slice(-6)) {
            lines.push(`  • ${item.name}: ${item.text}`);
        }
    }
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
    __reset,
};
