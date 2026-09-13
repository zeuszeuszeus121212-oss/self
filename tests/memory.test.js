/**
 * tests/memory.test.js — اختبارات الذاكرة طويلة المدى (Mongo وهمي كامل)
 * ─────────────────────────────────────────────────────────────
 * يغطي: الحفظ، dedup بالتطبيع العربي، الحد الأقصى، البحث بالصلة،
 * تعزيز الحداثة، النسيان (id/query/all)، عزل المستخدمين والوكلاء، حقن السياق.
 */

'use strict';
const assert = require('assert');
const path = require('path');

// ── Mongo وهمي داخل الذاكرة ──
const { ObjectId } = require('mongodb');
class FakeCollection {
    constructor() { this.docs = new Map(); }
    _oid() { return new ObjectId(); }
    async insertOne(doc) { const id = this._oid(); doc._id = id; this.docs.set(id.toString(), doc); return { insertedId: id }; }
    async findOne(q) {
        for (const d of this.docs.values()) if (match(d, q)) return d;
        return null;
    }
    find(q) {
        const arr = [...this.docs.values()].filter(d => match(d, q));
        return {
            sort: (s) => ({
                limit: (n) => ({
                    toArray: async () => {
                        const key = Object.keys(s || {})[0] || 'updated_at';
                        return arr.sort((a, b) => new Date(a[key]) - new Date(b[key])).slice(0, n);
                    },
                }),
            }),
            toArray: async () => arr,
        };
    }
    async countDocuments(q) { return [...this.docs.values()].filter(d => match(d, q)).length; }
    async updateOne(q, u) {
        const d = await this.findOne(q);
        if (!d) return { modifiedCount: 0 };
        if (u.$set) Object.assign(d, u.$set);
        if (u.$inc) for (const k of Object.keys(u.$inc)) d[k] = (d[k] || 0) + u.$inc[k];
        return { modifiedCount: 1 };
    }
    async deleteOne(q) {
        for (const [k, d] of this.docs) if (match(d, q)) { this.docs.delete(k); return { deletedCount: 1 }; }
        return { deletedCount: 0 };
    }
    async deleteMany(q) {
        let n = 0;
        for (const [k, d] of this.docs) if (match(d, q)) { this.docs.delete(k); n++; }
        return { deletedCount: n };
    }
    async distinct(field, q) {
        const set = new Set();
        for (const d of this.docs.values()) if (match(d, q)) set.add(d[field]);
        return [...set];
    }
}

function match(doc, q) {
    for (const [k, v] of Object.entries(q)) {
        if (k === '_id') { if (doc._id?.toString() !== v.toString()) return false; continue; }
        if (doc[k] !== v) return false;
    }
    return true;
}

// ── حقن config وهمي ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const memories = new FakeCollection();
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: memories,
    reminders_col: null, knowledge_col: null,
    agents_col: { findOne: async () => null }, logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    settings_col: { findOne: async () => null },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const memory = require('../memory');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    // ── 1) حفظ أساسي ──
    {
        const r = await memory.rememberFact({ agentId: 'A1', guildId: 'G1', userId: 'U1', content: 'المستخدم يعمل مبرمج جافاسكربت' });
        assert.strictEqual(r.ok, true);
        assert.ok(r.id);
        ok('1) حفظ ذكرى أساسي');
    }

    // ── 2) dedup: نفس المعنى بتشكيل/همزات مختلفة → تحديث وليس تكرار ──
    {
        const r = await memory.rememberFact({ agentId: 'A1', guildId: 'G1', userId: 'U1', content: 'المستخدم يعملُ مبرمج  جافاسكربت' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.duplicate, true, 'يجب كشفها مكررة بعد التطبيع');
        const total = await memories.countDocuments({ agent_id: 'A1', user_id: 'U1' });
        assert.strictEqual(total, 1, 'المجموعة ما زالت ذكرى واحدة');
        ok('2) dedup بالتطبيع العربي (تشكيل/همزات/مسافات)');
    }

    // ── 3) عزل المستخدمين والوكلاء ──
    {
        await memory.rememberFact({ agentId: 'A1', guildId: 'G1', userId: 'U2', content: 'المستخدم يحب القهوة' });
        await memory.rememberFact({ agentId: 'A2', guildId: 'G1', userId: 'U1', content: 'ذاكرة وكيل آخر مختلفة' });
        const r = await memory.recallFacts({ agentId: 'A1', userId: 'U1', query: '' });
        assert.ok(r.results.every(m => !m.content.includes('قهوة')), 'ذاكرة U2 لا تظهر لـ U1');
        assert.ok(r.results.every(m => !m.content.includes('وكيل آخر')), 'ذاكرة A2 لا تظهر في A1');
        ok('3) عزل ذكريات المستخدمين والوكلاء');
    }

    // ── 4) البحث بالصلة: كلمات مفتاحية + مطابقة جزئية ──
    {
        await memory.rememberFact({ agentId: 'A1', userId: 'U1', content: 'للمستخدم مشروع متجر إلكتروني في الرياض' });
        await memory.rememberFact({ agentId: 'A1', userId: 'U1', content: 'المستخدم يدرس المقالب الطويلة' });
        const r = await memory.recallFacts({ agentId: 'A1', userId: 'U1', query: 'مشروع المتجر' });
        assert.strictEqual(r.ok, true);
        assert.ok(r.results.length >= 1);
        assert.ok(r.results[0].content.includes('متجر'), `الأعلى يجب أن يكون المتجر: ${r.results[0].content}`);
        ok('4) recall: الصلة ترتّب النتائج صحيحاً');
    }

    // ── 5) تعزيز الحداثة: الأحدث يتفوق عند تساوي الكلمات ──
    {
        await memory.rememberFact({ agentId: 'A1', userId: 'U1', content: 'كلمة فريدة الموضوعات' });
        await new Promise(r => setTimeout(r, 30));
        await memory.rememberFact({ agentId: 'A1', userId: 'U1', content: 'كلمة فريدة الموضوعات نسخة أحدث' });
        const r = await memory.recallFacts({ agentId: 'A1', userId: 'U1', query: 'فريدة' });
        assert.ok(r.results[0].content.includes('أحدث'), 'الأحدث يجب أن يتقدم');
        ok('5) تعزيز الحداثة في الترتيب');
    }

    // ── 6) hits تزيد عند الاستدعاء ──
    {
        const before = [...memories.docs.values()].find(d => d.content.includes('أحدث'));
        await memory.recallFacts({ agentId: 'A1', userId: 'U1', query: 'فريدة' });
        const after = [...memories.docs.values()].find(d => d.content.includes('أحدث'));
        assert.ok((after.hits || 0) >= (before.hits || 0));
        ok('6) عداد hits يزيد عند الاستدعاء');
    }

    // ── 7) النسيان بـ query ──
    {
        const r = await memory.forgetFacts({ agentId: 'A1', userId: 'U1', query: 'متجر' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.deleted, 1);
        const check = await memory.recallFacts({ agentId: 'A1', userId: 'U1', query: 'متجر' });
        assert.strictEqual(check.results.length, 0);
        ok('7) forget بـ query يحذف المطابق فقط');
    }

    // ── 8) النسيان بـ id + رفض معرف لا يملكه ──
    {
        const add = await memory.rememberFact({ agentId: 'A1', userId: 'U1', content: 'ذكرى مؤقتة للحذف بالمعرف' });
        // مستخدم آخر يحاول حذفها
        const stolen = await memory.forgetFacts({ agentId: 'A1', userId: 'U2', id: add.id });
        assert.strictEqual(stolen.ok, false, 'لا يمكن لمستخدم آخر نسيان ذكرى غيره');
        const own = await memory.forgetFacts({ agentId: 'A1', userId: 'U1', id: add.id });
        assert.strictEqual(own.ok, true);
        assert.strictEqual(own.deleted, 1);
        ok('8) forget بـ id + حماية ملكية');
    }

    // ── 9) النسيان الكامل all ──
    {
        const before = await memories.countDocuments({ agent_id: 'A1', user_id: 'U1' });
        assert.ok(before > 0);
        const r = await memory.forgetFacts({ agentId: 'A1', userId: 'U1', all: true });
        assert.strictEqual(r.ok, true);
        const after = await memories.countDocuments({ agent_id: 'A1', user_id: 'U1' });
        assert.strictEqual(after, 0);
        assert.strictEqual(r.deleted, before);
        ok('9) forget all يمسح ذكريات المستخدم فقط');
    }

    // ── 10) الحد الأقصى 200 ──
    {
        for (let i = 0; i < 205; i++) {
            await memory.rememberFact({ agentId: 'A3', userId: 'U9', content: `حقيقة مرقمة رقم ${i} فريدة تماماً` });
        }
        const count = await memories.countDocuments({ agent_id: 'A3', user_id: 'U9' });
        assert.ok(count <= memory.MAX_MEMORIES_PER_USER, `العدد ${count} تجاوز الحد`);
        ok(`10) حد الذاكرة: ${count} ≤ ${memory.MAX_MEMORIES_PER_USER}`);
    }

    // ── 11) حقن السياق ──
    {
        await memory.rememberFact({ agentId: 'A4', userId: 'U10', content: 'المستخدم يفضل الردود المختصرة' });
        const ctx = await memory.buildMemoryContext({ agentId: 'A4', userId: 'U10' });
        assert.ok(ctx.includes('ذكرياتك المحفوظة'));
        assert.ok(ctx.includes('يفضل الردود المختصرة'));
        const empty = await memory.buildMemoryContext({ agentId: 'A4', userId: 'U_NOPE' });
        assert.strictEqual(empty, '', 'لا مستخدم → نص فارغ');
        ok('11) حقن السياق: نص مع ذكريات / فارغ بدون');
    }

    // ── 12) tokenize + stop words ──
    {
        const toks = memory.tokenize('أنا من الرياض وأعمل في البرمجة');
        assert.ok(!toks.includes('انا') && !toks.includes('من'), 'كلمات التوقف تُستبعد');
        assert.ok(toks.includes('الرياض'));
        ok('12) tokenize يستبعد كلمات التوقف');
    }

    // ── 13) stats + clear (لوحة التحكم) ──
    {
        const s = await memory.memoryStats('A3');
        assert.strictEqual(s.ok, true);
        assert.strictEqual(s.users, 1);
        const c = await memory.clearAgentMemory('A3');
        assert.ok(c.deleted > 0);
        const s2 = await memory.memoryStats('A3');
        assert.strictEqual(s2.total, 0);
        ok('13) memoryStats + clearAgentMemory');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`memory: ${passed}/13 ناجحة`);
}

run().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
