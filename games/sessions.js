/**
 * games/sessions.js — جلسات اللعب الحية (v7.18)
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

const TTL_MS = 45 * 60 * 1000;      // 🐞 v7.18: كانت 15 دقيقة — مراحل الليل (رسائل خاصة) صمت قناتي
                                    // طويل فتموت الجلسة ويفقد الوكيل كل وعيه («فقط أول مرة يعرف») — 45 دقيقة
const CHAT_RING_MAX = 12;           // آخر كلام القناة الذي يراه الذكاء
const EVENTS_MAX = 8;               // آخر أحداث اللعبة التي يراها الذكاء
const LOBBY_TEXT_MAX = 900;         // 🧠 v7.18: كانت 400 — نص اللوبي بأسماء اللاعبين يحتاج حيّزاً أكبر
const INBOX_MAX = 14;               // 📥 الصندوق الحي (v7.18): آخر رسائل اللعبة الحقيقية حرفياً
const INBOX_TEXT_MAX = 500;         // نص كل رسالة في الصندوق
const INBOX_IDS_MAX = 80;           // منع نسخ نفس الرسالة مرتين (تعديلات/منشور مرتين)
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
        lobbyMessageId : null,   // 🧠 v7.18: معرف رسالة اللوبي — لتتبع تعديلها (لاعبون ينضمون بعدها)
        me : { id: null, name: null }, // 🧠 v7.18: هوية الوكيل نفسه في اللعبة — «أنا مين»
        events    : [],          // سجل ما يحصل في اللعبة (آخر 8) — «لا يعرف ماذا يحصل بها»
        // 📥 الصندوق الحي (v7.18 — بلاغ المالك: «اي رساله من اللعبة يتم إرسالها للوكيل»)
        // كل رسالة بوت لعبة (قناة أو خاص) تُنسخ حرفياً هنا ويقرأها عقله في كل قرار وكلام
        inbox     : [],          // [{ at, kind, text }]
        inboxIds  : new Set(),   // معرفات الرسائل المنسوخة — لا تكرار
        mafia     : {
            role  : null,        // 'mafia' | 'doctor' | 'detective' | 'citizen' | null
            phase : 'lobby',     // lobby | roles | night_kill | night_save | day | day_discuss | day_vote | ended
            players: new Map(),  // id → { name, talks, alive }
            lastVictim: null,    // آخر قتيل { id, name, role }
            // 🗳️ v7.19 — بلاغ المالك: «لا يعرف في جولات التصويت من صوت على من»
            voteCounts  : new Map(), // اسم اللاعب → عدد الأصوات عليه (من تعديلات العدّاد)
            voteMessageId: null,     // معرف رسالة التصويت الحالية — تتبع تعديلاتها
            allies      : new Set(), // 🩸 زملاء الوكيل في المافيا (من بطاقة الدور)
            meDead      : false,     // ⚰️ قُتلنا — نلعب بصمت (لا تصويت ولا حركات)
        },
        voteAnnounces: 0,         // 🗣️ كم مرة أعلن تصويته بالشات (سقف 3 لكل جلسة)
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
    session.lastSeenAt = Date.now(); // 🐞 v7.18: كل حركة تُجدد عمر الجلسة
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
    if (session && clean) {
        session.lobbyText = clean;
        session.lastSeenAt = Date.now(); // 🐞 v7.18
    }
    return session;
}

/** 🧠 v7.18: خزّن معرف رسالة اللوبي — نتبع تعديلها حين ينضم باقي اللاعبين */
function setLobbyMessage(agentId, guildId, messageId) {
    const session = getSession(agentId, guildId);
    if (session && messageId) session.lobbyMessageId = String(messageId);
    return session;
}

/** 🧠 v7.18: هوية الوكيل نفسه في اللعبة — «أنا مين» (منشن لي = أنا) */
function setMe(agentId, guildId, { id, name } = {}) {
    const session = getSession(agentId, guildId);
    if (!session) return null;
    if (id) session.me.id = String(id);
    if (name) session.me.name = String(name).slice(0, 60);
    return session;
}

/** سجّل حدثاً في سجل الوعي — «ماذا يحصل الآن» */
function pushEvent(agentId, guildId, text) {
    const session = getSession(agentId, guildId);
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!session || !clean) return session;
    session.events.push({ at: Date.now(), text: clean });
    if (session.events.length > EVENTS_MAX) session.events.shift();
    session.lastSeenAt = Date.now(); // 🐞 v7.18
    return session;
}

/**
 * 📥 الصندوق الحي (v7.18 — جوهر بلاغ المالك: «انا طلبت بأنه اي رساله من
 * اللعبة يتم إرسالها للوكيل») — نسخة حرفية من رسالة بوت اللعبة (قناة أو خاص)
 * تُقرأ في كل قرار وكلام وسياق محادثة. لا ملخصات ولا تخمين — النص كما وصل.
 */
function pushInbox(agentId, guildId, { id = null, kind = 'game_msg', text = '' } = {}) {
    const session = getSession(agentId, guildId);
    const clean = String(text || '').replace(/[\t\r]+/g, ' ').trim().slice(0, INBOX_TEXT_MAX);
    if (!session || !clean) return session;
    if (id) {
        const key = String(id);
        if (session.inboxIds.has(key)) return session; // نفس الرسالة لا تُنسخ مرتين
        session.inboxIds.add(key);
        if (session.inboxIds.size > INBOX_IDS_MAX) {
            const oldest = session.inboxIds.values().next().value;
            session.inboxIds.delete(oldest);
        }
    }
    session.inbox.push({ at: Date.now(), kind: String(kind || 'game_msg').slice(0, 20), text: clean });
    if (session.inbox.length > INBOX_MAX) session.inbox.shift();
    session.lastSeenAt = Date.now();
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
    session.lastSeenAt = Date.now(); // 🐞 v7.18
    return session;
}

function mafiaSetRole(agentId, guildId, role) {
    const session = getSession(agentId, guildId);
    if (session && role) {
        session.mafia.role = String(role);
        session.lastSeenAt = Date.now(); // 🐞 v7.18
    }
    return session;
}

function mafiaSetPhase(agentId, guildId, phase) {
    const session = getSession(agentId, guildId);
    if (session && phase) {
        session.mafia.phase = String(phase);
        session.lastSeenAt = Date.now(); // 🐞 v7.18
    }
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
    if (entries.length) session.lastSeenAt = Date.now(); // 🐞 v7.18
    return session;
}

function mafiaMarkDead(agentId, guildId, userId) {
    const session = getSession(agentId, guildId);
    const id = String(userId || '');
    if (session && id && id !== 'undefined') {
        const player = session.mafia.players.get(id);
        if (player) player.alive = false;
        session.mafia.lastVictim = { id, name: player ? player.name : null, role: null };
        session.lastSeenAt = Date.now(); // 🐞 v7.18
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
    if (session.me?.name) lines.push(`- أنت اللاعب «${session.me.name}»${session.me.id ? ` (معرفك <@${session.me.id}>)` : ''} — أي منشن لك في اللعبة يعني أنت`);
    if (session.lobbyText) lines.push(`- رسالة اللوبي كما وصلت: «${session.lobbyText}»`);
    if (session.kicked.size) lines.push(`- المطرودون: ${[...session.kicked].length} لاعب`);
    if (session.players.size) lines.push(`- لاعبون مرئيون: ${session.players.size}`);
    if (session.friends.size) lines.push(`- تحدث معك: ${session.friends.size} لاعب`);
    // 📥 الصندوق الحي — الرسائل الحقيقية كما وصلت (بلاغ المالك v7.18:
    // «لا اريده يحاكي انه يعرف ما يجري بل فعلا يعرف»)
    if (session.inbox.length) {
        lines.push('- رسائل اللعبة الأخيرة كما وصلت حرفياً (الأحدث أولاً):');
        for (const item of session.inbox.slice(-6).reverse()) {
            lines.push(`  • ${item.text}`);
        }
    }
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
            const dead = [...session.mafia.players.entries()].filter(([, p]) => !p.alive).map(([, p]) => p.name);
            if (dead.length) lines.push(`- الموتى: ${dead.join('، ')}`);
            const silent = alive.filter(([, p]) => (p.talks || 0) === 0).map(([, p]) => p.name);
            if (silent.length) lines.push(`- صامتون طوال الجولة (مشتبه بهم): ${silent.join('، ')}`);
            const friends = alive.filter(([id]) => session.friends.has(id)).map(([, p]) => p.name);
            if (friends.length) lines.push(`- أصدقاؤك منهم: ${friends.join('، ')}`);
            if (session.mafia.lastVictim) lines.push(`- آخر قتيل: ${session.mafia.lastVictim.name || session.mafia.lastVictim.id}`);
        }
        // 🗳️ v7.19: لوحة الأصوات — «من صوت على من» كما طلبت المالك
        if (session.mafia.voteCounts.size) {
            const tally = [...session.mafia.voteCounts.entries()]
                .map(([name, count]) => `${name} (${count})`).join('، ');
            lines.push(`- لوحة الأصوات في جولة التصويت الحالية: ${tally}`);
        }
        // 🩸 v7.19: زملاؤك في المافيا — «ومن معه»
        if (session.mafia.allies.size) {
            const allyNames = [...session.mafia.allies]
                .map(id => session.mafia.players.get(id)?.name || id);
            lines.push(`- زملاؤك في المافيا (لا تكشفهم ولا تصوت عليهم): ${allyNames.join('، ')}`);
        }
        if (session.mafia.meDead) lines.push('- ⚰️ قُتلت في هذه الجولة — أنت متفرج الآن، لا تصوت ولا تختر');
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
    // 🧠 v7.18: الهوية — «يحسب انه البوت الذي فاز وليس هو» + «يقول مواطن وهو مافيا»
    if (session.me?.name) {
        lines.push(`- أنت اللاعب «${session.me.name}»${session.me.id ? ` ومعرفك <@${session.me.id}>` : ''} — كل منشن أو اسم يظهر في رسائل اللعبة ويقصدك = أنت نفسك، وليس بوتاً آخر`);
    }
    lines.push(`- اللعبة: ${session.gameName || 'غير معروفة'} — بدأت قبل ~${minutes} دقيقة في قناة هذه المحادثة أو جارتها`);
    if (session.lobbyText) lines.push(`- رسالة اللوبي التي انضممت بعدها: «${session.lobbyText}»`);
    // 🧠 v7.18: اللاعبون بأسمائهم الحقيقية وحالتهم — «من في اللعبه او بمن تشك»
    if (session.mafia.players.size) {
        const entries = [...session.mafia.players.values()];
        const alive = entries.filter(p => p.alive).map(p => p.name);
        const dead = entries.filter(p => !p.alive).map(p => p.name);
        lines.push(`- لاعبو الجولة (${entries.length}): ${entries.map(p => `${p.name} (${p.alive ? 'حي' : 'ميت'})`).join('، ') || '—'}`);
        if (alive.length) lines.push(`- الأحياء (${alive.length}): ${alive.join('، ')}`);
        if (dead.length) lines.push(`- الموتى (${dead.length}): ${dead.join('، ')}`);
    }
    if (session.engineId === 'mafia' || session.mafia.role) {
        lines.push(`- دورك في المافيا: ${session.mafia.role || 'غير معروف بعد'} — المرحلة: ${session.mafia.phase}`);
        if (session.mafia.role === 'mafia') lines.push('- أنت مافيا: حاول ألا تكشف نفسك، وتعاون مع المافيا الآخرين إن وجدوا');
        if (session.mafia.lastVictim) lines.push(`- آخر قتيل: ${session.mafia.lastVictim.name || session.mafia.lastVictim.id}`);
        // 🗳️ v7.19: لوحة الأصوات + الزملاء في سياق المحادثة الرئيسية أيضاً
        if (session.mafia.voteCounts.size) {
            const tally = [...session.mafia.voteCounts.entries()]
                .map(([name, count]) => `${name} (${count})`).join('، ');
            lines.push(`- لوحة الأصوات في جولة التصويت الحالية: ${tally}`);
        }
        if (session.mafia.allies.size) {
            const allyNames = [...session.mafia.allies]
                .map(id => session.mafia.players.get(id)?.name || id);
            lines.push(`- زملاؤك في المافيا: ${allyNames.join('، ')}`);
        }
        if (session.mafia.meDead) lines.push('- ⚰️ قُتلت في هذه الجولة — أنت متفرج الآن');
    }
    // 📥 الصندوق الحي — الرسائل الحقيقية (بلاغ المالك v7.18: «اي رساله من
    // اللعبة يتم إرسالها للوكيل» — لا ملخصات ناقصة)
    if (session.inbox.length) {
        lines.push('- رسائل اللعبة الأخيرة كما وصلت حرفياً (الأحدث أولاً):');
        for (const item of session.inbox.slice(-8).reverse()) {
            lines.push(`  • ${item.text}`);
        }
    }
    if (session.events.length) {
        lines.push('- آخر ما حدث (الأحدث أولاً):');
        for (const ev of session.events.slice(-5).reverse()) lines.push(`  • ${ev.text}`);
    }
    lines.push('- إن سألك أحد «من في اللعبة؟» أو «بمن تشك؟» أو عن أي شيء في الجولة فأجب كلاعب يعرف ما يجري حوله تماماً من المعلومات أعلاه — لا تخمّن ولا تقول لا أعرف.');
    return lines.join('\n');
}

// ══════════════════════════════════════════════════════════
//  🗳️ جولة التصويت (v7.19 — بلاغ المالك: «لا يعرف في جولات التصويت
//  من صوت على من» + «وخيار له لكي يصوت على احد»)
// ══════════════════════════════════════════════════════════

/** معرف رسالة التصويت الحالية — تعديلاتها (العدّاد) تُترجم لأصوات */
function mafiaSetVoteMessage(agentId, guildId, messageId) {
    const session = getSession(agentId, guildId);
    if (session && messageId) session.mafia.voteMessageId = String(messageId);
    return session;
}

/** لوحة الأصوات الحالية — تُبث لعقل الوكيل في كل قرار وكلام وسؤال */
function mafiaSetVote(agentId, guildId, name, count = null) {
    const session = getSession(agentId, guildId);
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!session || !clean) return session;
    const current = session.mafia.voteCounts.get(clean) || 0;
    const next = count === null ? current + 1 : Math.max(0, Number(count) || 0);
    session.mafia.voteCounts.set(clean, next);
    session.lastSeenAt = Date.now();
    return session;
}

/** خزّن زملاء الوكيل في المافيا من بطاقة الدور («زملاؤك: <@X> <@Y>») */
function mafiaAddAllies(agentId, guildId, entries = []) {
    const session = getSession(agentId, guildId);
    if (!session) return session;
    let added = 0;
    for (const entry of entries) {
        const id = String(entry && entry.id ? entry.id : entry || '');
        if (!id || !/^\d{5,25}$/.test(id) || id === String(session.me.id || '')) continue;
        if (!session.mafia.allies.has(id)) { session.mafia.allies.add(id); added += 1; }
        if (entry && entry.name) {
            const known = session.mafia.players.get(id);
            if (!known) session.mafia.players.set(id, { name: String(entry.name).slice(0, 60), talks: 0, alive: true });
        }
    }
    if (added) session.lastSeenAt = Date.now();
    return session;
}

/** ⚰️ قُتلنا — خارج اللعبة: لا تصويت ولا حركات سرية بعد اليوم */
function mafiaMarkMeDead(agentId, guildId) {
    const session = getSession(agentId, guildId);
    if (session) {
        session.mafia.meDead = true;
        session.mafia.phase = 'ended';
        session.lastSeenAt = Date.now();
    }
    return session;
}

/**
 * 🧩 سطر الخيارات — أسماء الأزرار/القوائم داخل رسالة اللعبة (v7.19):
 * الصندوق الحي كان ينسخ نص الرسالة فقط وأزرار الخيارات (أسماء اللاعبين
 * التي يصوت عليها أو يقتلها) لا تصل لعقله أبداً — بلاغ المالك الحرفي:
 * «وخيار له لكي يصوت على احد». دالة نقية تُستخدم من player.js وmafia.js.
 */
function optionsLineFromComponents(components) {
    try {
        if (!Array.isArray(components) || components.length === 0) return '';
        const labels = [];
        const walk = (node, depth) => {
            if (!node || depth > 4 || labels.length > 40) return;
            if (Array.isArray(node)) { for (const child of node) walk(child, depth + 1); return; }
            if (node.type === 3 && Array.isArray(node.options)) {
                for (const option of node.options) {
                    if (option && option.label) labels.push(String(option.label));
                }
                return;
            }
            if (node.label) { labels.push(String(node.label)); return; }
            if (Array.isArray(node.components)) walk(node.components, depth + 1);
        };
        walk(components, 0);
        const unique = [...new Set(labels.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean))];
        if (!unique.length) return '';
        return `الخيارات: ${unique.slice(0, 24).map(l => `[${l}]`).join(' ')}`;
    } catch (_) { return ''; }
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
    // 📥 الصندوق الحي + الهوية + معرف اللوبي (v7.18)
    pushInbox,
    setLobbyMessage,
    setMe,
    INBOX_MAX,
    INBOX_TEXT_MAX,
    // 🗳️ جولة التصويت + الزملاء + الموت (v7.19)
    mafiaSetVoteMessage,
    mafiaSetVote,
    mafiaAddAllies,
    mafiaMarkMeDead,
    optionsLineFromComponents,
    __reset,
};
