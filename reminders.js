/**
 * reminders.js — Disor Bot v7.2 "Real Agent"
 * ═══════════════════════════════════════════════════════════
 * محرك التذكيرات للوكلاء — وحدة التخزين والتشغيل الوحيدة لمجموعة agent_reminders.
 *
 *   • createReminder  — إنشاء تذكير (بعد-دقائق / وقت-ISO / يومي / أسبوعي)
 *   • listReminders   — تذكيرات مستخدم (لا يرى غير تذكيراته)
 *   • cancelReminder  — إلغاء بمعرف (حماية ملكية)
 *   • startReminderEngine — ماسح دوري داخل runtime الوكيل يرسل عبر عميله هو
 *
 * دقة التوقيت: التحقق من الاستحقاق بمقارنة due_at <= الآن، والتكرار
 * بإعادة جدولة محسوبة من الهدف القادم (لا انزلاق زمني).
 * كل شيء يعمل بأمان حتى لو MongoDB غير متصل.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const DAY_NAMES = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const SCAN_INTERVAL_MS = 20_000;
const CATCH_UP_MAX_AGE_MS = 24 * 3600 * 1000; // المتأخر أكثر من يوم يُهمل

function col() {
    const cfg = require('./config');
    return cfg.reminders_col || null;
}

// ═══════════════════════════════════════════════════════════
//  حساب الوقت — دوال نقية قابلة للاختبار
// ═══════════════════════════════════════════════════════════

/**
 * تحويل معاملات "متى" إلى هدف زمني
 * @param {object} p
 *   in_minutes  → بعد X دقيقة
 *   at_iso      → وقت ISO أو "YYYY-MM-DD HH:MM" (بتوقيت السيرفر)
 *   daily_hhmm  → "HH:MM" يومي
 *   weekly_day  → اسم يوم إنجليزي + weekly_hhmm "HH:MM" أسبوعي
 * @returns {{ok: boolean, error?: string, dueAt?: Date, recurrence?: null|'daily'|'weekly', baseHhmm?: string, baseDay?: number}}
 */
function parseWhen(p = {}) {
    const now = new Date();

    // 1) بعد دقائق
    if (p.in_minutes !== undefined && p.in_minutes !== null && p.in_minutes !== '') {
        const mins = Number(p.in_minutes);
        if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: 'in_minutes يجب أن يكون رقماً أكبر من صفر' };
        if (mins > 60 * 24 * 365) return { ok: false, error: 'in_minutes أكبر من سنة' };
        return { ok: true, dueAt: new Date(now.getTime() + mins * 60_000), recurrence: null };
    }

    // 2) وقت محدد ISO أو "YYYY-MM-DD HH:MM"
    if (p.at_iso) {
        let s = String(p.at_iso).trim();
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + (s.length === 16 ? ':00' : '');
        const d = new Date(s);
        if (isNaN(d.getTime())) return { ok: false, error: `وقت غير مفهوم: ${p.at_iso}` };
        if (d.getTime() <= now.getTime()) return { ok: false, error: 'الوقت المحدد في الماضي' };
        return { ok: true, dueAt: d, recurrence: null };
    }

    // 3) يومي HH:MM
    if (p.daily_hhmm) {
        const m = String(p.daily_hhmm).trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return { ok: false, error: 'daily_hhmm يجب أن يكون بصيغة HH:MM' };
        const hh = Number(m[1]); const mm = Number(m[2]);
        if (hh > 23 || mm > 59) return { ok: false, error: 'وقت غير صالح' };
        const due = new Date(now);
        due.setHours(hh, mm, 0, 0);
        if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1); // الهدف القادم دائماً في المستقبل
        return { ok: true, dueAt: due, recurrence: 'daily', baseHhmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
    }

    // 4) أسبوعي: يوم + HH:MM
    if (p.weekly_day || p.weekly_hhmm) {
        const dayName = String(p.weekly_day || '').toLowerCase().trim();
        if (!(dayName in DAY_NAMES)) return { ok: false, error: 'weekly_day يجب أن يكون اسم يوم إنجليزي مثل monday' };
        const m = String(p.weekly_hhmm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return { ok: false, error: 'weekly_hhmm يجب أن يكون بصيغة HH:MM' };
        const hh = Number(m[1]); const mm = Number(m[2]);
        if (hh > 23 || mm > 59) return { ok: false, error: 'وقت غير صالح' };
        const target = DAY_NAMES[dayName];
        const due = new Date(now);
        due.setHours(hh, mm, 0, 0);
        let diff = (target - due.getDay() + 7) % 7;
        if (diff === 0 && due.getTime() <= now.getTime()) diff = 7;
        due.setDate(due.getDate() + diff);
        return { ok: true, dueAt: due, recurrence: 'weekly', baseHhmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, baseDay: target };
    }

    return { ok: false, error: 'حدد متى التذكير: in_minutes أو at_iso أو daily_hhmm أو weekly_day+weekly_hhmm' };
}

/** الحساب القادم لتذكير متكرر — جداري: أقرب موعد مستقبلي بنفس HH:MM */
function computeNextOccurrence(from, recurrence, baseHhmm, baseDay) {
    const next = new Date(from.getTime());
    if (recurrence === 'daily') {
        const [hh, mm] = String(baseHhmm || '00:00').split(':').map(Number);
        next.setHours(hh, mm, 0, 0);
        if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
        return next;
    }
    if (recurrence === 'weekly') {
        const [hh, mm] = String(baseHhmm || '00:00').split(':').map(Number);
        next.setHours(hh, mm, 0, 0);
        const target = Number.isInteger(baseDay) ? baseDay : next.getDay();
        let diff = (target - next.getDay() + 7) % 7;
        if (diff === 0 && next.getTime() <= from.getTime()) diff = 7;
        next.setDate(next.getDate() + diff);
        return next;
    }
    return null; // غير متكرر
}

/**
 * تقدم تذكير متكرر من هدفه القديم بفترات دقيقة (+24h / +7d) — بلا انزلاق زمني.
 * يلحق الفوائت المتعددة (بوت مطفأ) بالقفز فترات كاملة حتى يصل للمستقبل.
 * ملاحظة: الحساب بالفترات الدقيقة (قد ينحرف ساعة عند تغيير التوقيت الصيفي — مقصود وموثوق).
 */
function advanceRecurring(dueAt, recurrence, now = new Date()) {
    const periodMs = recurrence === 'daily' ? 86_400_000
        : recurrence === 'weekly' ? 7 * 86_400_000
        : null;
    if (!periodMs) return null;
    let next = new Date(dueAt.getTime() + periodMs);
    const nowMs = Math.max(now.getTime(), dueAt.getTime());
    let guard = 0;
    while (next.getTime() <= nowMs && guard < 1000) {
        next = new Date(next.getTime() + periodMs);
        guard++;
    }
    return next;
}

// ═══════════════════════════════════════════════════════════
//  التخزين
// ═══════════════════════════════════════════════════════════

async function createReminder({ agentId, guildId, channelId, userId, username = '', text, when = {} } = {}) {
    const c = col();
    if (!c) return { ok: false, message: 'قاعدة البيانات غير متصلة' };
    const content = String(text || '').trim();
    if (!content) return { ok: false, message: 'نص التذكير فارغ' };
    if (!channelId) return { ok: false, message: 'قناة التذكير غير معروفة' };
    if (!userId) return { ok: false, message: 'معرف المستخدم مفقود' };
    if (content.length > 500) return { ok: false, message: 'نص التذكير طويل جداً (الحد 500)' };

    const parsed = parseWhen(when);
    if (!parsed.ok) return { ok: false, message: parsed.error };

    // حد أقصى 30 تذكير نشط لكل مستخدم
    const active = await c.countDocuments({ agent_id: String(agentId || 'default'), user_id: String(userId), active: true });
    if (active >= 30) return { ok: false, message: 'وصلت للحد الأقصى (30 تذكيراً نشطاً)' };

    const doc = {
        agent_id : String(agentId || 'default'),
        guild_id : guildId ? String(guildId) : null,
        channel_id: String(channelId),
        user_id  : String(userId),
        username : String(username || '').slice(0, 60),
        text     : content,
        due_at   : parsed.dueAt,
        recurrence: parsed.recurrence || null,
        base_hhmm: parsed.baseHhmm || null,
        base_day : Number.isInteger(parsed.baseDay) ? parsed.baseDay : null,
        active   : true,
        last_fired_at: null,
        created_at: new Date(),
    };
    const res = await c.insertOne(doc);
    return { ok: true, id: String(res.insertedId), dueAt: parsed.dueAt, recurrence: parsed.recurrence || null, message: describeWhen(parsed) };
}

function describeWhen(parsed) {
    if (parsed.recurrence === 'daily') return `يومياً الساعة ${parsed.baseHhmm}`;
    if (parsed.recurrence === 'weekly') return `أسبوعياً ${parsed.dueAt.toISOString().slice(0, 10)} الساعة ${parsed.baseHhmm}`;
    return `في ${parsed.dueAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

async function listReminders({ agentId, userId } = {}) {
    const c = col();
    if (!c) return { ok: false, message: 'قاعدة البيانات غير متصلة', reminders: [] };
    if (!userId) return { ok: false, message: 'معرف المستخدم مفقود', reminders: [] };
    const docs = await c.find({ agent_id: String(agentId || 'default'), user_id: String(userId), active: true }).toArray();
    const reminders = (docs || [])
        .sort((a, b) => new Date(a.due_at) - new Date(b.due_at))
        .map(d => ({
            id     : String(d._id),
            text   : d.text,
            due_at : d.due_at,
            recurrence: d.recurrence,
        }));
    return { ok: true, reminders };
}

async function cancelReminder({ agentId, userId, id } = {}) {
    const c = col();
    if (!c) return { ok: false, deleted: 0, message: 'قاعدة البيانات غير متصلة' };
    if (!userId) return { ok: false, deleted: 0, message: 'معرف المستخدم مفقود' };
    const { ObjectId } = require('mongodb');
    let oid;
    try { oid = new ObjectId(String(id)); } catch (_) { return { ok: false, deleted: 0, message: 'معرف غير صالح' }; }
    const doc = await c.findOne({ _id: oid, agent_id: String(agentId || 'default'), user_id: String(userId), active: true });
    if (!doc) return { ok: false, deleted: 0, message: 'لا يوجد تذكير نشط بهذا المعرف يخصك' };
    await c.updateOne({ _id: oid }, { $set: { active: false, cancelled_at: new Date() } });
    return { ok: true, deleted: 1, message: `أُلغي التذكير: ${String(doc.text).slice(0, 60)}` };
}

// ═══════════════════════════════════════════════════════════
//  المحرك — ماسح دوري داخل runtime الوكيل
// ═══════════════════════════════════════════════════════════

/**
 * بدء محرك التذكيرات لهذا الوكيل
 * @param {object} opts
 *   agentId - معرف الوكيل (يُتجاهل مع shouldHandle)
 *   client  - عميل ديسكورد الخاص بالوكيل (الإرسال عبره)
 *   intervalMs - فترة المسح (للاختبارات)
 *   shouldHandle - (اختياري v7.11) فلتر: (agentId) => boolean — للفحص عبر كل التذكيرات
 *                  يُستخدم من بوت المدير ليغطي تذكيرات الوكلاء المتوقفين فقط.
 * @returns {{stop: Function, tick: Function}} tick للاختبارات
 */
function startReminderEngine({ agentId, client, intervalMs = SCAN_INTERVAL_MS, shouldHandle = null } = {}) {
    const running = { stopped: false };
    const filterByAgent = typeof shouldHandle !== 'function';

    async function tick(now = new Date()) {
        if (running.stopped) return { fired: 0 };
        const c = col();
        if (!c || !client) return { fired: 0 };

        let due = [];
        try {
            due = filterByAgent
                ? await c.find({ agent_id: String(agentId || 'default'), active: true }).toArray()
                : await c.find({ active: true }).toArray();
        } catch (_) { return { fired: 0 }; }

        let fired = 0;
        for (const doc of (due || [])) {
            // فلتر المدير: هذا الوكيل يعمل حالياً؟ محركه الخاص يتكفل بتذكيراته — تجاوز
            if (!filterByAgent && !shouldHandle(String(doc.agent_id || ''))) continue;
            const dueAt = new Date(doc.due_at).getTime();
            if (isNaN(dueAt)) continue;
            const isDue = dueAt <= now.getTime();

            // المتأخر القديم جداً (بوت كان مطفأً مدة طويلة) — يُهمل بصمت
            if (!isDue) continue;
            const lateBy = now.getTime() - dueAt;
            if (lateBy > CATCH_UP_MAX_AGE_MS && doc.last_fired_at) {
                await deactivate(c, doc, 'expired');
                continue;
            }

            const sent = await deliverReminder(client, doc, lateBy);
            if (sent) fired++;

            if (doc.recurrence === 'daily' || doc.recurrence === 'weekly') {
                const next = advanceRecurring(new Date(dueAt), doc.recurrence, now);
                if (next) {
                    await c.updateOne({ _id: doc._id }, { $set: { due_at: next, last_fired_at: now } });
                    continue;
                }
            }
            await deactivate(c, doc, sent ? 'fired' : 'fired_failed');
        }
        return { fired };
    }

    const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();

    running.stop = () => { running.stopped = true; clearInterval(timer); };
    running.tick = tick;
    return running;
}

async function deactivate(c, doc, reason) {
    try {
        await c.updateOne({ _id: doc._id }, { $set: { active: false, end_reason: reason, ended_at: new Date() } });
    } catch (_) {}
}

/** إرسال التذكير عبر عميل الوكيل — حماية كاملة من الأخطاء + احتياطي الخاص (DM) */
async function deliverReminder(client, doc, lateBy = 0) {
    const mention = doc.user_id ? `<@${doc.user_id}>` : '';
    const lateNote = lateBy > 5 * 60_000 ? ` (متأخر ${Math.round(lateBy / 60_000)} دقيقة — البوت كان غير متصل)` : '';
    const msg = `⏰ **تذكير**${lateNote}\n${mention}\n${doc.text}`;
    try {
        const channel = await client.channels.fetch(String(doc.channel_id)).catch(() => null);
        if (channel && typeof channel.send === 'function') {
            await channel.send(msg.slice(0, 1900));
            return true;
        }
    } catch (e) {
        console.error(`[Reminder] فشل إرسال تذكير ${doc._id} في القناة:`, e.message);
    }
    // 🪂 احتياطي: فشلت القناة (محذوفة/بلا وصول)؟ رسالة خاصة للمستخدم حتى لا يضيع التذكير أبداً
    try {
        if (doc.user_id && typeof client.users?.fetch === 'function') {
            const user = await client.users.fetch(String(doc.user_id)).catch(() => null);
            if (user && typeof user.send === 'function') {
                await user.send(`⏰ **تذكير**${lateNote}\n${doc.text}`.slice(0, 1900));
                return true;
            }
        }
    } catch (e) {
        console.error(`[Reminder] فشل احتياطي الخاص للتذكير ${doc._id}:`, e.message);
    }
    return false;
}

module.exports = {
    parseWhen,
    computeNextOccurrence,
    advanceRecurring,
    createReminder,
    listReminders,
    cancelReminder,
    startReminderEngine,
    SCAN_INTERVAL_MS,
    CATCH_UP_MAX_AGE_MS,
};
