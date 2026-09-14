/**
 * tests/notify_routing.test.js — توجيه الإشعارات (v7.10.0)
 * ─────────────────────────────────────────────────────────────
 * 🌍 القاعدة الجديدة (طلب المالك): قناة إشعارات واحدة عالمية تستقبل
 * كل شيء من كل السيرفرات. ترتيب الحل:
 *   1) قناة خاصة بالوكيل (تجاوز صريح اختياري)
 *   2) 🌍 القناة العالمية (scope manager / guild_id 'global')
 *   3) إعداد السيرفر المحدد — تراث توافق قديم فقط
 * الحالة الحاسمة: عالمية مضبوطة + سيرفر الحدث له إعداد قديم
 * → العالمية تفوز (قبلا كان إعداد السيرفر يخفي كل السيرفرات الأخرى).
 */

'use strict';
const assert = require('assert');
const path = require('path');

const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));

const VALID_AGENT_ID = '507f1f77bcf86cd799439011';
let agentDoc = null;                       // الوكيل الحالي (أو null)
const globalSettings = {};                 // إعدادات global
const guildSettings = {};                  // إعدادات سيرفر الحدث

const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    agents_col: {
        findOne: async () => agentDoc,
        updateOne: async () => ({ modifiedCount: 1 }),
    },
    settings_col: {
        findOne: async (filter) => {
            const gid = String(filter.guild_id);
            if (gid === 'global') return Object.keys(globalSettings).length ? { ...globalSettings, scope: 'manager', guild_id: 'global' } : null;
            return Object.keys(guildSettings).length ? { ...guildSettings, scope: 'manager', guild_id: gid } : null;
        },
        updateOne: async () => ({}),
    },
    logs_col: { insertOne: async () => {}, find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    memories_col: null, reminders_col: null, knowledge_col: null, providers_col: null,
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const { getNotificationChannel } = require('../bot');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    // ── 1) قناة الوكيل الخاصة تتصدر (تجاوز صريح) ──
    {
        agentDoc = { _id: VALID_AGENT_ID, name: 'أ', notification_channel_id: 'chan-agent' };
        globalSettings.notification_channel_id = 'chan-global';
        guildSettings.notification_channel_id = 'chan-guild';
        const ch = await getNotificationChannel(VALID_AGENT_ID, 'guild-1');
        assert.equal(ch, 'chan-agent', 'قناة الوكيل الخاصة أولاً');
        ok('1) قناة الوكيل الخاصة (اختيارية) تتجاوز كل شيء');
    }

    // ── 2) 🌍 العالمية تفوق إعداد السيرفر — جوهر الإصلاح ──
    {
        agentDoc = null;
        const ch = await getNotificationChannel(null, 'guild-1');
        assert.equal(ch, 'chan-global', 'العالمية قبل إعداد السيرفر');
        // حتى مع agentId لا يملك قناة خاصة
        agentDoc = { _id: VALID_AGENT_ID, name: 'أ' };
        const ch2 = await getNotificationChannel(VALID_AGENT_ID, 'guild-1');
        assert.equal(ch2, 'chan-global', 'وكيل بلا قناة خاصة → العالمية');
        ok('2) 🌍 العالمية تُرسل كل السيرفرات — إعداد سيرفر واحد لا يخفي البقية بعد اليوم');
    }

    // ── 3) بلا عالمية: إعداد السيرفر تراث احتياطي ──
    {
        delete globalSettings.notification_channel_id;
        const ch = await getNotificationChannel(null, 'guild-1');
        assert.equal(ch, 'chan-guild', 'تراث: إعداد السيرفر يعمل إن غابت العالمية');
        ok('3) بلا عالمية → إعداد السيرفر القديم يعمل (توافق قديم)');
    }

    // ── 4) لا شيء مضبوط → لا قناة (بلا انفجار) ──
    {
        delete guildSettings.notification_channel_id;
        const ch = await getNotificationChannel(null, 'guild-9');
        assert.equal(ch, null, 'لا قناة = لا إشعار، بلا أخطاء');
        ok('4) لا قنوات مضبوطة → null آمن');
    }

    // ── 5) agentId غير صالح — تجاهل آمن ──
    {
        globalSettings.notification_channel_id = 'chan-global';
        const ch = await getNotificationChannel('not-an-objectid', 'guild-1');
        assert.equal(ch, 'chan-global', 'agentId غير صالح يُتجاهل بلا انفجار');
        ok('5) agentId غير صالح → تجاهل آمن والعالمية تعمل');
    }

    console.log(`\n🌍 notify_routing: ${passed}/5 اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌ FATAL:', e); process.exit(1); });
