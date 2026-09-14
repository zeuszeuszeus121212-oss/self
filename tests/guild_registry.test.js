/**
 * tests/guild_registry.test.js — اختبارات RAQEEB: سجل السيرفرات والنشاط (v7.9.0)
 * ─────────────────────────────────────────────────────────────
 * يغطي: تسجيل انضمام سيرفر مع استخراج «من أضافه» من سجل التدقيق،
 * الإشعار الفوري للمالك، تسجيل النبضات (من/أين/متى — بلا محتوى)،
 * مغادرة سيرفر، إعداد إشعارات النشاط (تشغيل/إطفاء)، والاستعلامات
 * للوحة /الرصد (overview + تفاصيل سيرفر).
 */

'use strict';
const assert = require('assert');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));

function makeCol() {
    const docs = new Map();
    let seq = 0;
    return {
        docs,
        async findOne(filter) {
            for (const d of docs.values()) {
                let match = true;
                for (const [k, v] of Object.entries(filter)) if (String(d[k]) !== String(v)) { match = false; break; }
                if (match) return JSON.parse(JSON.stringify(d));
            }
            return null;
        },
        async updateOne(filter, patch) {
            let doc = null;
            for (const d of docs.values()) {
                let match = true;
                for (const [k, v] of Object.entries(filter)) if (String(d[k]) !== String(v)) { match = false; break; }
                if (match) { doc = d; break; }
            }
            const isNew = !doc;
            if (isNew) { doc = { _id: ++seq }; for (const [k, v] of Object.entries(filter)) doc[k] = v; docs.set(doc._id, doc); }
            Object.assign(doc, patch.$set || {});
            if (patch.$setOnInsert && isNew) for (const [k, v] of Object.entries(patch.$setOnInsert)) if (!(k in doc)) doc[k] = v;
            return { matched: isNew ? 0 : 1 };
        },
        async insertOne(d) { const id = ++seq; docs.set(id, JSON.parse(JSON.stringify(d))); return { insertedId: id }; },
        async countDocuments() { return docs.size; },
        async deleteOne({ _id }) { return { deletedCount: docs.delete(_id) ? 1 : 0 }; },
        find(filter = {}) {
            let all = [...docs.values()].filter(d => Object.entries(filter).every(([k, v]) => String(d[k]) === String(v)));
            return {
                sort() {
                    return {
                        limit(n) {
                            return { toArray: async () => JSON.parse(JSON.stringify(all.slice(0, n))) };
                        },
                    };
                },
                sortDir: null,
            };
        },
    };
}

const registryCol = makeCol();
const activityCol = makeCol();
let activityNotifySetting = undefined; // undefined = الافتراضي (مفعّل)

const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    guild_registry_col: registryCol, guild_activity_col: activityCol,
    qwen_guild_accounts_col: null,
    settings_col: { findOne: async () => ({ activity_notify: activityNotifySetting }), updateOne: async () => ({}) },
    agents_col: makeCol(), logs_col: { insertOne: async () => {} },
    memories_col: null, reminders_col: null, knowledge_col: null,
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const guildRegistry = require('../guildRegistry');
const { findBotAdder } = guildRegistry._internals;

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

// ── أدوات وهمية Discord ──
const CLIENT = { user: { id: 'bot-999' } };
function makeGuild(id, name) {
    return {
        id, name, memberCount: 42, ownerId: 'owner-1',
        fetchAuditLogs: async ({ type, limit }) => ({
            entries: {
                values: () => [{
                    target: { id: 'bot-999' },
                    executor: { id: 'adder-777', tag: `AdderSeven` },
                }].slice(0, limit),
                first: () => ({ target: { id: 'bot-999' }, executor: { id: 'adder-777', tag: 'AdderSeven' } }),
            },
        }),
        iconURL: () => null,
    };
}

async function run() {
    let notifications = [];
    guildRegistry.setNotifier(async (n) => { notifications.push(n); });

    // ── 1) استخراج من أضاف البوت من سجل التدقيق ──
    {
        const adder = await findBotAdder(makeGuild('g1'), CLIENT);
        assert.ok(adder, 'وُجد المُضيف');
        assert.equal(adder.id, 'adder-777');
        assert.equal(adder.tag, 'AdderSeven');
        ok('1) من أضاف البوت — مستخرج من سجل التدقيق (BOT_ADD)');
    }

    // ── 2) تسجيل انضمام + إشعار فوري ──
    {
        notifications.length = 0;
        const res = await guildRegistry.recordGuildJoin(makeGuild('g1', 'سيرفر الأول'), CLIENT);
        assert.equal(res.ok, true);
        assert.equal(res.addedBy.tag, 'AdderSeven');
        const doc = registryCol.docs.get(1);
        assert.equal(doc.guild_id, 'g1');
        assert.equal(doc.name, 'سيرفر الأول');
        assert.equal(doc.added_by_id, 'adder-777');
        assert.ok(doc.joined_at, 'وقت الانضمام مخزن');
        assert.equal(notifications.length, 1, 'إشعار واحد للمالك');
        assert.ok(notifications[0].title.includes('سيرفر جديد'));
        assert.ok(notifications[0].message.includes('AdderSeven'), 'الإشعار يذكر من أضافه');
        ok('2) الانضمام مُسجل كاملاً + إشعار فوري بالمن/الوقت/من أضافه');
    }

    // ── 3) نبضة نشاط — من/أين/متى وبلا أي محتوى رسائل ──
    {
        notifications.length = 0;
        const res = await guildRegistry.recordActivity({
            agentId: 'a1', agentName: 'بوت-التجربة',
            guildId: 'g1', guildName: 'سيرفر الأول',
            channelId: 'c1', channelName: 'عام',
            userId: 'u1', username: 'متكلم',
        });
        assert.equal(res.ok, true);
        const doc = activityCol.docs.get(1);
        assert.equal(doc.user_id, 'u1');
        assert.equal(doc.channel_name, 'عام');
        assert.ok(doc.created_at);
        // بلا أي حقل محتوى — خصوصية صارمة
        assert.equal(doc.content, undefined);
        assert.equal(doc.message, undefined);
        assert.equal(doc.preview, undefined);
        assert.equal(notifications.length, 1, 'إشعار النشاط مفعّل افتراضياً');
        ok('3) النبضات: من/أين/متى فقط — صفر محتوى رسائل + إشعار حي');
    }

    // ── 4) تهدئة الإشعارات — نفس الشخص/القناة خلال الثواني الأربع = إشعار واحد ──
    {
        notifications.length = 0;
        for (let i = 0; i < 3; i++) {
            await guildRegistry.recordActivity({
                guildId: 'g1', channelId: 'c1', userId: 'u1', username: 'متكلم',
                agentId: 'a1', agentName: 'بوت-التجربة',
            });
        }
        assert.equal(notifications.length, 0, 'النبضات المتتالية المختنقة بلا إشعارات');
        // نبضة من مستخدم آخر — إشعار جديد
        await guildRegistry.recordActivity({
            guildId: 'g1', channelId: 'c1', userId: 'u2', username: 'ثاني',
            agentId: 'a1', agentName: 'بوت-التجربة',
        });
        assert.equal(notifications.length, 1, 'شخص آخر في نفس القناة = إشعار');
        ok('4) تهدئة إشعارات النشاط — بلا إغراق لقناة الإشعارات');
    }

    // ── 5) إطفاء إشعارات النشاط من الإعدادات ──
    {
        activityNotifySetting = false;
        notifications.length = 0;
        await guildRegistry.recordActivity({
            guildId: 'g1', channelId: 'c9', userId: 'u3', username: 'ثالث',
            agentId: 'a1', agentName: 'بوت-التجربة',
        });
        assert.equal(notifications.length, 0, 'المُطفأ = صفر إشعارات');
        assert.equal(await guildRegistry.activityNotifyEnabled(), false);
        // النبضة نفسها سُجلت رغم الإطفاء (الرصد دائماً، الإشعارات اختيارية)
        assert.ok([...activityCol.docs.values()].some(d => d.user_id === 'u3'));
        activityNotifySetting = undefined;
        ok('5) إطفاء الإشعارات من الإعدادات — الرصد يستمر بلا إزعاج');
    }

    // ── 6) مغادرة سيرفر ──
    {
        notifications.length = 0;
        const res = await guildRegistry.recordGuildLeave({ id: 'g1', name: 'سيرفر الأول' });
        assert.equal(res.ok, true);
        const doc = await registryCol.findOne({ guild_id: 'g1' });
        assert.equal(doc.left, true);
        assert.ok(doc.left_at);
        assert.equal(notifications.length, 1);
        assert.ok(notifications[0].title.includes('خرج'));
        ok('6) المغادرة مُسلمة مع إشعار تحذيري');
    }

    // ── 7) استعلامات اللوحة — overview وتفاصيل ──
    {
        const overview = await guildRegistry.getOverview();
        assert.ok(overview.length >= 1);
        const row = overview.find(r => r.guild_id === 'g1');
        assert.ok(row.total_chats >= 4, 'عدّاد المحادثات مجمّع');
        assert.ok(row.last_activity, 'آخر نشاط موجود');
        const detail = await guildRegistry.getGuildDetail('g1');
        assert.equal(detail.guild_id, 'g1');
        assert.ok(detail.activity.length >= 1);
        assert.equal(await guildRegistry.getGuildDetail('مجهول'), null);
        ok('7) استعلامات /الرصد — overview وتفاصيل سيرفر كاملة');
    }

    // ── 8) notifier تالف لا يُسقط شيئاً أبداً ──
    {
        guildRegistry.setNotifier(async () => { throw new Error('قناة الإشعارات ماتت'); });
        const res = await guildRegistry.recordGuildLeave({ id: 'g2', name: 'سيرفر الثاني' });
        assert.equal(res.ok, true, 'التسجيل نجح رغم انفجار المُبلّغ');
        guildRegistry.setNotifier(async (n) => { notifications.push(n); });
        ok('8) قناة إشعارات معطوبة لا تعطل الرصد أبداً');
    }

    console.log(`\n🎯 guild_registry: ${passed}/8 اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌ FATAL:', e); process.exit(1); });
