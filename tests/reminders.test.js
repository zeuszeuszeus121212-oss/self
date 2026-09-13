/**
 * tests/reminders.test.js — اختبارات محرك التذكيرات (Mongo وعميل ديسكورد وهميان)
 * ─────────────────────────────────────────────────────────────
 * يغطي: كل صيغ "متى"، رفض الماضي/غير الصالح، إنشاء/سرد/إلغاء بملكية،
 * دورة المحرك (استحقاق/إرسال/إنهاء)، التكرار اليومي والأسبوعي بدون انزلاق،
 * والتقاط المتأخر عند الإقلاع (catch-up).
 */

'use strict';
const assert = require('assert');
const path = require('path');

// ── Mongo وهمي (ObjectIds حقيقية مثل mongo الفعلي) ──
const { ObjectId } = require('mongodb');
class FakeCollection {
    constructor() { this.docs = new Map(); }
    async insertOne(doc) { doc._id = new ObjectId(); this.docs.set(doc._id.toString(), doc); return { insertedId: doc._id }; }
    async findOne(q) { for (const d of this.docs.values()) if (this._m(d, q)) return d; return null; }
    find(q) {
        const arr = [...this.docs.values()].filter(d => this._m(d, q));
        return {
            sort: () => ({ limit: () => ({ toArray: async () => arr }) }),
            toArray: async () => arr,
        };
    }
    async countDocuments(q) { return [...this.docs.values()].filter(d => this._m(d, q)).length; }
    async updateOne(q, u) {
        const d = [...this.docs.values()].find(x => this._m(x, q));
        if (!d) return { modifiedCount: 0 };
        if (u.$set) Object.assign(d, u.$set);
        if (u.$inc) for (const k of Object.keys(u.$inc)) d[k] = (d[k] || 0) + u.$inc[k];
        return { modifiedCount: 1 };
    }
    async deleteOne(q) {
        for (const [k, d] of this.docs) if (this._m(d, q)) { this.docs.delete(k); return { deletedCount: 1 }; }
        return { deletedCount: 0 };
    }
    _m(d, q) {
        for (const [k, v] of Object.entries(q)) {
            if (k === '_id') { if (String(d._id) !== String(v)) return false; continue; }
            if (d[k] !== v) return false;
        }
        return true;
    }
}

// ── حقن config وهمي ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const remindersCol = new FakeCollection();
const sentMessages = [];
const fakeClient = {
    channels: {
        fetch: async (id) => ({
            id,
            send: async (content) => { sentMessages.push({ channelId: id, content }); return { id: 'm1' }; },
        }),
    },
};
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    reminders_col: remindersCol,
    memories_col: null, knowledge_col: null,
    agents_col: { findOne: async () => null },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    settings_col: { findOne: async () => null },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const reminders = require('../reminders');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
    const FUTURE = new Date(Date.now() + 10 * 60_000);

    // ── 1) parseWhen: كل الصيغ الصالحة ──
    {
        const a = reminders.parseWhen({ in_minutes: 30 });
        assert.ok(a.ok && Math.abs(a.dueAt.getTime() - Date.now() - 30 * 60_000) < 5000);

        const iso = new Date(Date.now() + 3600_000).toISOString();
        const b = reminders.parseWhen({ at_iso: iso });
        assert.ok(b.ok && b.dueAt.getTime() === new Date(iso).getTime());

        const c = reminders.parseWhen({ at_iso: '2099-05-01 14:30' });
        assert.ok(c.ok && c.dueAt.getHours() === 14 && c.dueAt.getMinutes() === 30);

        const d = reminders.parseWhen({ daily_hhmm: '23:59' });
        assert.ok(d.ok && d.recurrence === 'daily' && d.dueAt.getTime() > Date.now());

        const e = reminders.parseWhen({ weekly_day: 'friday', weekly_hhmm: '20:00' });
        assert.ok(e.ok && e.recurrence === 'weekly' && e.dueAt.getDay() === 5);

        ok('1) parseWhen: دقائق/ISO/تاريخ-وقت/يومي/أسبوعي');
    }

    // ── 2) parseWhen: الرفض الصحيح ──
    {
        assert.strictEqual(reminders.parseWhen({ in_minutes: 0 }).ok, false);
        assert.strictEqual(reminders.parseWhen({ in_minutes: -5 }).ok, false);
        assert.strictEqual(reminders.parseWhen({ at_iso: '1999-01-01T00:00:00Z' }).ok, false, 'الماضي مرفوض');
        assert.strictEqual(reminders.parseWhen({ at_iso: 'garbage' }).ok, false);
        assert.strictEqual(reminders.parseWhen({ daily_hhmm: '25:00' }).ok, false);
        assert.strictEqual(reminders.parseWhen({ weekly_day: 'الجمعة' }).ok, false);
        assert.strictEqual(reminders.parseWhen({}).ok, false, 'لا شيء محدد');
        ok('2) parseWhen: رفض الماضي والصيغ السيئة');
    }

    // ── 3) computeNextOccurrence: بلا انزلاق ──
    {
        const from = new Date('2025-06-15T10:00:00'); // أحد
        const daily = reminders.computeNextOccurrence(from, 'daily', '09:00');
        assert.strictEqual(daily.getDate(), 16, 'اليومي: الساعة مضت → غداً');
        assert.strictEqual(daily.getHours(), 9);

        const before = new Date('2025-06-15T08:00:00');
        const daily2 = reminders.computeNextOccurrence(before, 'daily', '09:00');
        assert.strictEqual(daily2.getDate(), 15, 'اليومي: الساعة لم تأت → اليوم');

        // 2025-06-15 أحد (0) → الهدف جمعة (5) = +5 أيام
        const weekly = reminders.computeNextOccurrence(from, 'weekly', '20:00', 5);
        assert.strictEqual(weekly.getDay(), 5);
        assert.strictEqual(weekly.getDate(), 20);
        ok('3) computeNextOccurrence: تقدم صحيح بلا انزلاق');
    }

    // ── 4) إنشاء تذكير ──
    {
        const r = await reminders.createReminder({
            agentId: 'A1', guildId: 'G1', channelId: 'C1', userId: 'U1', username: 'Ali',
            text: 'اشرب ماء', when: { in_minutes: 1 },
        });
        assert.ok(r.ok && r.id);
        const bad = await reminders.createReminder({ agentId: 'A1', channelId: 'C1', userId: 'U1', text: '', when: { in_minutes: 5 } });
        assert.strictEqual(bad.ok, false);
        const noWhen = await reminders.createReminder({ agentId: 'A1', channelId: 'C1', userId: 'U1', text: 'x', when: {} });
        assert.strictEqual(noWhen.ok, false);
        ok('4) createReminder: نجاح + رفض فارغ/بلا وقت');
    }

    // ── 5) المحرك: استحقاق → إرسال → إنهاء ──
    {
        // نجعل التذكير مستحقاً الآن مباشرة
        const doc = [...remindersCol.docs.values()].find(d => d.user_id === 'U1');
        doc.due_at = new Date(Date.now() - 30_000);

        const engine = reminders.startReminderEngine({ agentId: 'A1', client: fakeClient, intervalMs: 60_000 });
        const res = await engine.tick(new Date());
        assert.ok(res.fired >= 1, `فired=${res.fired}`);
        assert.strictEqual(sentMessages.length, 1);
        assert.ok(sentMessages[0].content.includes('اشرب ماء'));
        assert.ok(sentMessages[0].content.includes('<@U1>'));
        assert.strictEqual(doc.active, false, 'التذكير غير المتكرر يُنهى بعد الإرسال');
        assert.strictEqual(doc.end_reason, 'fired');
        engine.stop();
        ok('5) tick: استحقاق → إرسال بمنشن → إنهاء');
    }

    // ── 6) المتأخر جداً مع إشعار التأخير ──
    {
        await reminders.createReminder({ agentId: 'A1', channelId: 'C2', userId: 'U2', text: 'تذكير متأخر', when: { in_minutes: 2 } });
        const doc = [...remindersCol.docs.values()].find(d => d.user_id === 'U2');
        doc.due_at = new Date(Date.now() - 40 * 60_000); // متأخر 40 دقيقة

        const engine = reminders.startReminderEngine({ agentId: 'A1', client: fakeClient, intervalMs: 60_000 });
        await engine.tick(new Date());
        const msg = sentMessages.find(m => m.content.includes('تذكير متأخر'));
        assert.ok(msg, 'يجب أن يُرسل');
        assert.ok(msg.content.includes('متأخر 40 دقيقة'), `يجب ذكر التأخير: ${msg.content}`);
        engine.stop();
        ok('6) catch-up: متأخر 40 د → يُرسل مع ملاحظة التأخير');
    }

    // ── 7) المتأخر القديم جداً (فوق 24 ساعة مع last_fired) → يُهمل ──
    {
        await reminders.createReminder({ agentId: 'A1', channelId: 'C3', userId: 'U3', text: 'قديم جداً', when: { in_minutes: 2 } });
        const doc = [...remindersCol.docs.values()].find(d => d.user_id === 'U3');
        doc.due_at = new Date(Date.now() - 3 * 24 * 3600_000);
        doc.last_fired_at = new Date(Date.now() - 3 * 24 * 3600_000);

        const engine = reminders.startReminderEngine({ agentId: 'A1', client: fakeClient, intervalMs: 60_000 });
        await engine.tick(new Date());
        assert.strictEqual(doc.active, false);
        assert.strictEqual(doc.end_reason, 'expired');
        assert.ok(!sentMessages.some(m => m.content.includes('قديم جداً')), 'لا يُرسل بعد يوم كامل');
        engine.stop();
        ok('7) المتأخر فوق 24 ساعة → انتهاء بصمت');
    }

    // ── 8) التكرار اليومي: يُرسل ثم يُجدول للغد ──
    {
        const r = await reminders.createReminder({
            agentId: 'A1', channelId: 'C4', userId: 'U4', text: 'تذكير يومي', when: { daily_hhmm: '00:00' },
        });
        assert.ok(r.ok);
        const doc = [...remindersCol.docs.values()].find(d => d.user_id === 'U4');
        doc.due_at = new Date(Date.now() - 60_000); // مستحق الآن
        const oldDue = new Date(doc.due_at);

        const engine = reminders.startReminderEngine({ agentId: 'A1', client: fakeClient, intervalMs: 60_000 });
        await engine.tick(new Date());
        assert.strictEqual(doc.active, true, 'المتكرر يبقى نشطاً');
        assert.ok(doc.due_at.getTime() > Date.now(), 'أُعيدت جدولته للمستقبل');
        assert.strictEqual(doc.recurrence, 'daily');
        const drift = Math.abs(doc.due_at.getTime() - (oldDue.getTime() + 24 * 3600_000));
        assert.ok(drift < 2 * 60_000, `القادم = القديم + 24h بالضبط (انحراف ${Math.round(drift / 1000)}s)`);
        engine.stop();
        ok('8) يومي: إرسال + إعادة جدولة +24h بلا انزلاق');
    }

    // ── 9) التكرار الأسبوعي ──
    {
        const created = await reminders.createReminder({
            agentId: 'A1', channelId: 'C5', userId: 'U5', text: 'اجتماع أسبوعي', when: { weekly_day: 'monday', weekly_hhmm: '09:00' },
        });
        assert.ok(created.ok);
        const doc = [...remindersCol.docs.values()].find(d => d.user_id === 'U5');
        // محاكاة فوات أسبوع كامل: الهدف الأصلي ناقص 7 أيام (يظل يوم اثنين كما يجب)
        const origTarget = new Date(created.dueAt);
        doc.due_at = new Date(origTarget.getTime() - 7 * 86_400_000);

        const engine = reminders.startReminderEngine({ agentId: 'A1', client: fakeClient, intervalMs: 60_000 });
        await engine.tick(new Date());
        assert.strictEqual(doc.active, true);
        assert.strictEqual(doc.due_at.getDay(), 1, 'القادم يوم الاثنين');
        const drift = Math.abs(doc.due_at.getTime() - origTarget.getTime());
        assert.ok(drift < 60_000, `القادم = الهدف الأصلي تماماً (انحراف ${Math.round(drift / 1000)}s)`);
        const daysToNext = (doc.due_at.getTime() - Date.now()) / (24 * 3600_000);
        assert.ok(daysToNext > 0 && daysToNext <= 7, `القادم ضمن أسبوع: ${daysToNext.toFixed(1)}d`);
        engine.stop();
        ok('9) أسبوعي: إعادة جدولة +7d على نفس اليوم بلا انزلاق');
    }

    // ── 10) سرد + إلغاء بملكية ──
    {
        const list = await reminders.listReminders({ agentId: 'A1', userId: 'U4' });
        assert.ok(list.ok && list.reminders.length === 1);
        const target = list.reminders[0];

        // مستخدم آخر لا يستطيع الإلغاء
        const stolen = await reminders.cancelReminder({ agentId: 'A1', userId: 'U5', id: target.id });
        assert.strictEqual(stolen.ok, false);

        // قناة غير موجودة → فشل إرسال → يُنهى بـ fired_failed (لا انهيار)
        const docU4 = [...remindersCol.docs.values()].find(d => d.user_id === 'U4');
        docU4.channel_id = 'NO_CHANNEL';
        fakeClient.channels.fetch = async () => null;
        const engine = reminders.startReminderEngine({ agentId: 'A1', client: fakeClient, intervalMs: 60_000 });
        docU4.due_at = new Date(Date.now() - 30_000);
        await engine.tick(new Date());
        fakeClient.channels.fetch = async (id) => ({ id, send: async (c) => { sentMessages.push({ channelId: id, content: c }); } });
        engine.stop();

        const cancel = await reminders.cancelReminder({ agentId: 'A1', userId: 'U4', id: target.id });
        assert.ok(cancel.ok);
        const after = await reminders.listReminders({ agentId: 'A1', userId: 'U4' });
        assert.strictEqual(after.reminders.length, 0);
        ok('10) سرد + حماية إلغاء + قناة مفقودة لا تكسر المحرك');
    }

    // ── 11) عزل الوكلاء: محرك A1 لا يطلق تذكيرات A2 ──
    {
        await reminders.createReminder({ agentId: 'A2', channelId: 'C9', userId: 'U9', text: 'تذكير وكيل آخر', when: { in_minutes: 1 } });
        const doc = [...remindersCol.docs.values()].find(d => d.agent_id === 'A2');
        doc.due_at = new Date(Date.now() - 30_000);
        const before = sentMessages.length;

        const engine = reminders.startReminderEngine({ agentId: 'A1', client: fakeClient, intervalMs: 60_000 });
        const res = await engine.tick(new Date());
        engine.stop();
        assert.strictEqual(sentMessages.length, before, 'لا إرسال لتذكير وكيل آخر');
        assert.strictEqual(doc.active, true, 'لم يُلمس');
        ok('11) عزل المحركات بين الوكلاء');
    }

    // ── 12) حدود التخزين ──
    {
        for (let i = 0; i < 30; i++) {
            await reminders.createReminder({ agentId: 'A5', channelId: 'C', userId: 'UX', text: `ت${i}`, when: { in_minutes: i + 1 } });
        }
        const over = await reminders.createReminder({ agentId: 'A5', channelId: 'C', userId: 'UX', text: 'واحد زائد', when: { in_minutes: 99 } });
        assert.strictEqual(over.ok, false, 'الحد 30 نشط');
        const other = await reminders.createReminder({ agentId: 'A5', channelId: 'C', userId: 'UY', text: 'مستخدم آخر', when: { in_minutes: 99 } });
        assert.ok(other.ok);
        ok('12) حد 30 تذكيراً لكل مستخدم + عزل المستخدمين');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`reminders: ${passed}/12 ناجحة`);
}

run().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
