/**
 * tests/qwen_accounts.test.js — اختبارات حسابات Qwen التلقائية لكل سيرفر (v7.9.0)
 * ─────────────────────────────────────────────────────────────
 * يغطي: توليد بيانات آمنة، صلاحية التوكن، أولوية توكن السيرفر
 * المفعّل في مسار runAgent (وعود التراجع)، التسجيل الكامل مع
 * البريد المؤقت (axios مُزيّف)، التعامل مع فشل التسجيل بلا انهيار،
 * والتأكيد بالدخول (signin) بعد التفعيل.
 */

'use strict';
const assert = require('assert');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));

function makeCol() {
    const docs = new Map();
    return {
        docs,
        async findOne(filter) {
            const gid = filter.guild_id;
            const doc = docs.has(gid) ? JSON.parse(JSON.stringify(docs.get(gid))) : null;
            if (!doc) return null;
            // احترام فلاتر استعلام بسيطة (status مثلاً) كما يفعل MongoDB الحقيقي
            for (const [k, v] of Object.entries(filter)) {
                if (k === 'guild_id') continue;
                if (String(doc[k]) !== String(v)) return null;
            }
            return doc;
        },
        async updateOne(filter, patch) {
            const gid = filter.guild_id;
            const base = docs.get(gid) || {};
            const doc = { ...base, ...(patch.$set || {}) };
            if (patch.$setOnInsert) for (const [k, v] of Object.entries(patch.$setOnInsert)) if (!(k in doc)) doc[k] = v;
            docs.set(gid, doc);
            return { matched: docs.has(gid) ? 1 : 0 };
        },
        async find() {
            const all = [...docs.values()];
            return { sort: () => ({ limit: () => ({ toArray: async () => all }) }) };
        },
    };
}

const accountsCol = makeCol();
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    qwen_guild_accounts_col: accountsCol,
    guild_registry_col: null, guild_activity_col: null,
    settings_col: { findOne: async () => null },
    agents_col: makeCol(), logs_col: { insertOne: async () => {} },
    memories_col: null, reminders_col: null, knowledge_col: null,
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

// ── تزييف axios قبل تحميل الوحدة ──
const axios = require('axios');
const calls = { posts: [], gets: [] };
let signupResponder = null;
let signinResponder = null;
axios.post = async (url, body) => {
    calls.posts.push({ url, body });
    if (url.includes('/auths/signup')) {
        if (!signupResponder) throw new Error('signupResponder غير مضبوط');
        return signupResponder();
    }
    if (url.includes('/auths/signin')) {
        if (!signinResponder) throw new Error('signinResponder غير مضبوط');
        return signinResponder();
    }
    throw new Error(`POST غير متوقع: ${url}`);
};
axios.get = async (url) => {
    calls.gets.push(url);
    return { data: { 'hydra:member': [{ isActive: true, domain: 'uberip.test' }] } };
};

const qwenAccounts = require('../qwenAccounts');
const { generateCredentials, validToken } = qwenAccounts._internals;

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };
const DAY = 24 * 3600 * 1000;

async function run() {
    // ── 1) توليد بيانات الحساب — فريدة وقوية ──
    {
        const a = generateCredentials();
        const b = generateCredentials();
        assert.ok(a.name.startsWith('DisorGuild'), 'اسم بصيغة موحدة');
        assert.ok(/^disor\.g[0-9a-f]+@gmail\.com$/.test(a.email), 'بريد بصيغة موحدة');
        assert.ok(a.password.length >= 12, 'كلمة مرور طويلة بما يكفي');
        assert.notEqual(a.email, b.email, 'بلا تكرار');
        ok('1) توليد بيانات الحساب — فريدة وقوية للجميع');
    }

    // ── 2) صلاحية التوكن ──
    {
        assert.equal(validToken({ token: 't', expires_at: new Date(Date.now() + 10 * DAY) }), true, 'سليم');
        assert.equal(validToken({ token: 't', expires_at: new Date(Date.now() + 1 * DAY) }), false, 'قارب النهاية (<3 أيام)');
        assert.equal(validToken({ token: 't', expires_at: new Date(Date.now() - 1000) }), false, 'منتهٍ');
        assert.equal(validToken({ token: null, expires_at: new Date(Date.now() + 10 * DAY) }), false, 'بلا توكن');
        ok('2) صلاحية التوكن — هامش الأمان 3 أيام قبل الانتهاء');
    }

    // ── 3) getGuildQwenToken — المفعّل فقط يُستخدم، بلا تسريب للانتظار ──
    {
        accountsCol.docs.set('g1', { guild_id: 'g1', status: 'active', token: 'TOK_ACTIVE', expires_at: new Date(Date.now() + 10 * DAY) });
        accountsCol.docs.set('g2', { guild_id: 'g2', status: 'pending', token: 'TOK_PENDING', expires_at: new Date(Date.now() + 10 * DAY) });
        assert.equal(await qwenAccounts.getGuildQwenToken('g1'), 'TOK_ACTIVE');
        assert.equal(await qwenAccounts.getGuildQwenToken('g2'), null, 'الحساب غير المفعّل لا يُستخدم (Qwen يرفضه)');
        assert.equal(await qwenAccounts.getGuildQwenToken('غير_موجود'), null);
        ok('3) توكن السيرفر: المفعّل فقط — الصبر على التفعيل لا يكسر التشغيل');
    }

    // ── 4) التسجيل الكامل — بريد مؤقت + signup ناجح → pending + تخزين كامل ──
    {
        calls.posts.length = 0;
        signupResponder = () => ({
            data: { success: true, data: { token: 'TOK_NEW', id: 'uid-1', role: 'pending', expires_at: Math.floor((Date.now() + 30 * DAY) / 1000) } },
        });
        // نعطّل قراءة بريد التفعيل (mailToken سيكون فارغاً لأن /token سيفشل) — بلا مشاكل
        const res = await qwenAccounts.registerGuildAccount('g10', { reason: 'test' });
        assert.equal(res.ok, true, `التسجيل ينجح: ${res.error || ''}`);
        assert.equal(res.status, 'pending');
        const stored = accountsCol.docs.get('g10');
        assert.ok(stored, 'الحساب مخزن');
        assert.equal(stored.status, 'pending');
        assert.equal(stored.token, 'TOK_NEW');
        assert.ok(stored.email.startsWith('disor.'), 'بريد مؤقت مُستخدم');
        assert.ok(stored.qwen_password, 'كلمة مرور Qwen مخزنة للتفعيل/التجديد');
        assert.ok(calls.posts.some(p => p.url.includes('/auths/signup')), 'نداء signup حقيقي الصيغة');
        ok('4) التسجيل التلقائي الكامل — بريد + signup + تخزين كامل البيانات');
    }

    // ── 5) فشل signup — لا يرمي، يخزن failed بلطف ──
    {
        signupResponder = () => { throw new Error('HTTP 429: كثرة الطلبات'); };
        const res = await qwenAccounts.registerGuildAccount('g11', { reason: 'test' });
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        const stored = accountsCol.docs.get('g11');
        assert.equal(stored.status, 'failed');
        assert.ok(stored.last_error.includes('429'));
        ok('5) فشل التسجيل يُدار بنعومة — بلا انهيار، وبالحالة والإخطار');
    }

    // ── 6) activateAccount بالتأكيد بالدخول — نجاح يحوّل إلى active ──
    {
        accountsCol.docs.set('g12', { guild_id: 'g12', email: 'x@uberip.test', qwen_password: 'pass', status: 'pending', token: 'OLD', expires_at: new Date() });
        signinResponder = () => ({ data: { success: true, data: { token: 'TOK_ACTIVATED', expires_at: Math.floor((Date.now() + 30 * DAY) / 1000) } } });
        const doc = JSON.parse(JSON.stringify(accountsCol.docs.get('g12')));
        const act = await qwenAccounts._internals;
        // استخدم ensureGuildAccount — مسار pending → محاولة تفعيل → signin
        const res = await qwenAccounts.ensureGuildAccount('g12', { reason: 'test' });
        assert.equal(res.ok, true, 'التفعيل نجح');
        assert.equal(res.status, 'active');
        const after = accountsCol.docs.get('g12');
        assert.equal(after.status, 'active');
        assert.equal(after.token, 'TOK_ACTIVATED', 'توكن جديد بعد التفعيل');
        ok('6) التفعيل بالدخول — pending يصبح active وتوكنه يُجدَّد');
    }

    // ── 7) بيانات خاطئة في signin — بقاء pending بلا انهيار ──
    {
        accountsCol.docs.set('g13', { guild_id: 'g13', email: 'y@uberip.test', qwen_password: 'bad', status: 'pending' });
        signinResponder = () => ({ data: { success: false, data: { message: 'كلمة المرور خاطئة' } } });
        const res = await qwenAccounts.ensureGuildAccount('g13', { reason: 'test' });
        assert.equal(res.ok, false, 'ما زال غير مفعّل');
        const after = accountsCol.docs.get('g13');
        assert.equal(after.status, 'pending');
        ok('7) رفض التفعيل يُدار بلطف — الحالة تبقى pending وتُراجع لاحقاً');
    }

    // ── 8) تجديد حساب active قارب الانتهاء ──
    {
        accountsCol.docs.set('g14', { guild_id: 'g14', email: 'z@uberip.test', qwen_password: 'pass', status: 'active', token: 'OLD', expires_at: new Date(Date.now() + 1 * DAY) });
        signinResponder = () => ({ data: { success: true, data: { token: 'TOK_RENEWED', expires_at: Math.floor((Date.now() + 30 * DAY) / 1000) } } });
        const res = await qwenAccounts.ensureGuildAccount('g14', { reason: 'test' });
        assert.equal(res.ok, true);
        assert.equal(res.renewed, true);
        assert.equal(accountsCol.docs.get('g14').token, 'TOK_RENEWED');
        ok('8) التجديد الوقائي — التوكن قارب الانتهاء فجُدِّد بالدخول');
    }

    // ── 9) describeGuildAccount — للوحة الرصد، بلا توكن حساس ──
    {
        const d = await qwenAccounts.describeGuildAccount('g14');
        assert.equal(d.status, 'active');
        assert.equal(d.email, 'z@uberip.test');
        assert.equal(d.token, undefined, 'بلا توكن حساس في العرض');
        assert.equal(await qwenAccounts.describeGuildAccount('مجهول'), null);
        ok('9) وصف الحساب للوحة — كامل المعلومات وبلا أسرار');
    }

    console.log(`\n🎯 qwen_accounts: ${passed}/9 اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌ FATAL:', e); process.exit(1); });
