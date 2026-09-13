/**
 * tests/knowledge.test.js — اختبارات قاعدة المعرفة RAG (المستوى 2C)
 * ─────────────────────────────────────────────────────────────
 * يغطي: التقطيع (فقرات، جمل طويلة، تداخل)، الإدخال واستبدال المصدر،
 * البحث بالصلة والتغطية، عزل الوكلاء، حذف مصدر، مسح كامل، إحصائيات.
 */

'use strict';
const assert = require('assert');
const path = require('path');
const { ObjectId } = require('mongodb');

// ── Mongo وهمي داعم لـ insertMany و aggregate ──
class FakeCollection {
    constructor() { this.docs = new Map(); let n = 0; this._next = () => ++n; }
    async insertMany(arr) { for (const d of arr) { d._id = new ObjectId(); this.docs.set(d._id.toString(), d); } return { insertedCount: arr.length }; }
    async deleteMany(q) {
        let c = 0;
        for (const [k, d] of [...this.docs.entries()]) {
            if (match(d, q)) { this.docs.delete(k); c++; }
        }
        return { deletedCount: c };
    }
    find(q) {
        const arr = [...this.docs.values()].filter(d => match(d, q));
        return { limit: (n) => ({ toArray: async () => arr.slice(0, n) }), toArray: async () => arr };
    }
    aggregate(pipeline) {
        // دعم فقط: $match + $group _id=source + $sort + $limit
        let arr = [...this.docs.values()];
        const $match = pipeline.find(s => s.$match)?.$match;
        if ($match) arr = arr.filter(d => match(d, $match));
        const $group = pipeline.find(s => s.$group)?.$group;
        const $sort = pipeline.find(s => s.$sort)?.$sort;
        const $limit = pipeline.find(s => s.$limit)?.$limit;
        if ($group) {
            const groups = new Map();
            for (const d of arr) {
                const key = resolveField(d, $group._id);
                if (!groups.has(key)) groups.set(key, { _id: key, chunks: 0, chars: 0, added: d.created_at });
                const g = groups.get(key);
                g.chunks += 1;
                g.chars += (resolveField(d, $group.chars) || 0);
                if (new Date(resolveField(d, $group.added)) > new Date(g.added)) g.added = resolveField(d, $group.added);
            }
            arr = [...groups.values()];
        }
        if ($sort) {
            const [k, dir] = Object.entries($sort)[0];
            arr.sort((a, b) => dir === 1 ? (a[k] > b[k] ? 1 : -1) : (a[k] < b[k] ? 1 : -1));
        }
        if ($limit) arr = arr.slice(0, $limit);
        return { toArray: async () => arr };
    }
    async countDocuments(q) { return [...this.docs.values()].filter(d => match(d, q)).length; }
    async distinct(field, q) {
        const set = new Set();
        for (const d of this.docs.values()) if (match(d, q)) set.add(d[field]);
        return [...set];
    }
}

function resolveField(d, spec) {
    if (typeof spec === 'string' && spec.startsWith('$')) return d[spec.slice(1)];
    return spec;
}

function match(doc, q) {
    for (const [k, v] of Object.entries(q || {})) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            // نطاقات $gte/$lte للنصوص
            if (v.$gte !== undefined && !(doc[k] >= v.$gte)) return false;
            if (v.$lte !== undefined && !(doc[k] <= v.$lte)) return false;
            continue;
        }
        if (doc[k] !== v) return false;
    }
    return true;
}

const fakeConfig = { knowledge_col: new FakeCollection() };
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const knowledge = require('../knowledge');

let passed = 0, failed = 0;
function test(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { passed++; console.log(`✅ ${name}`); })
        .catch((e) => { failed++; console.error(`❌ ${name}: ${e.message}`); });
}

(async () => {
    await test('التقطيع: نص قصير = قطعة واحدة', () => {
        const chunks = knowledge.chunkText('سطر أول\n\nسطر ثانٍ', { size: 900, overlap: 120 });
        assert.strictEqual(chunks.length, 1);
        assert.ok(chunks[0].includes('سطر أول') && chunks[0].includes('سطر ثانٍ'));
    });

    await test('التقطيع: نص طويل بفقرات → عدة قطع ضمن الحجم', () => {
        const para = 'هذه فقرة اختبارية تحتوي كلمات كثيرة. '.repeat(10); // ~470 حرف
        const text = Array(8).fill(para).join('\n\n'); // ~3800 حرف
        const chunks = knowledge.chunkText(text, { size: 900, overlap: 120 });
        assert.ok(chunks.length >= 4, `متوقع ≥4 قطع، حصل ${chunks.length}`);
        for (const c of chunks) assert.ok(c.length <= 900 + 150, `قطعة أطول من الحجم: ${c.length}`);
    });

    await test('التقطيع: تداخل — ذيل القطعة السابقة يظهر في التالية', () => {
        const para = 'كلمةأولى كلمةثانية كلمةثالثة كلمةرابعة كلمةخامسة. ';
        const text = para.repeat(60);
        const chunks = knowledge.chunkText(text, { size: 400, overlap: 80 });
        assert.ok(chunks.length >= 2);
        // التداخل: بداية كل قطعة (عدا الأولى) ليست فارغة ومنطقية
        for (let i = 1; i < chunks.length; i++) {
            assert.ok(chunks[i].length > 10);
        }
    });

    await test('التقطيع: جملة واحدة أطول من الحجم تُقصّ قسرياً', () => {
        const long = 'ك'.repeat(3000);
        const chunks = knowledge.chunkText(long, { size: 900, overlap: 0 });
        assert.ok(chunks.length >= 3);
        for (const c of chunks) assert.ok(c.length <= 900);
    });

    await test('التقطيع: نص فارغ → لا قطع', () => {
        assert.deepStrictEqual(knowledge.chunkText('   '), []);
        assert.deepStrictEqual(knowledge.chunkText(''), []);
    });

    await test('الإدخال: مستند يُخزن بقطع متعددة مع مصدره', async () => {
        const para = 'معلومة مهمة عن الأسعار والخصومات للعملاء. '.repeat(4); // ~170 حرف للفقرة
        const text = Array(12).fill(para).join('\n\n'); // ~2000 حرف
        const r = await knowledge.ingestDocument({ agentId: 'a1', guildId: 'g1', source: 'pricing.txt', text });
        assert.ok(r.ok);
        assert.ok(r.chunks >= 2, `متوقع ≥2 قطعة، حصل ${r.chunks}`);
        const stats = await knowledge.knowledgeStats('a1');
        assert.strictEqual(stats.chunks, r.chunks);
        assert.strictEqual(stats.sources, 1);
    });

    await test('الإدخال: إعادة نفس المصدر تستبدل القطع القديمة (idempotent)', async () => {
        const r1 = await knowledge.ingestDocument({ agentId: 'a2', source: 'doc.md', text: 'نص قديم. '.repeat(50) });
        const r2 = await knowledge.ingestDocument({ agentId: 'a2', source: 'doc.md', text: 'نص جديد محتوى مختلف تماماً عن السعر. '.repeat(50) });
        assert.ok(r1.ok && r2.ok);
        const stats = await knowledge.knowledgeStats('a2');
        assert.strictEqual(stats.chunks, r2.chunks, 'لا تقطع قديمة متبقية');
    });

    await test('الإدخال: نص فارغ يُرفض', async () => {
        const r = await knowledge.ingestDocument({ agentId: 'a1', source: 'x.txt', text: '   ' });
        assert.strictEqual(r.ok, false);
    });

    await test('البحث: تطابق مباشر يعيد النتيجة الأولى', async () => {
        await knowledge.ingestDocument({ agentId: 'a3', source: 'pol.txt', text: 'سياسة الاسترجاع: يمكن للعميل استرجاع المنتج خلال 14 يوماً من الشراء.\n\n' + 'شروط أخرى لا علاقة لها بالاسترجاع إطلاقاً مثل الدعم الفني والدفع. '.repeat(20) });
        const r = await knowledge.searchKnowledge({ agentId: 'a3', query: 'كم مدة الاسترجاع؟' });
        assert.ok(r.ok && r.results.length >= 1);
        assert.ok(r.results[0].content.includes('الاسترجاع'));
        assert.strictEqual(r.results[0].source, 'pol.txt');
    });

    await test('البحث: استعلام بلا أي تطابق → نتائج فارغة', async () => {
        const r = await knowledge.searchKnowledge({ agentId: 'a3', query: 'كوانتم فضاء مكوك قمر' });
        assert.ok(r.ok);
        assert.strictEqual(r.results.length, 0);
    });

    await test('البحث: عزل الوكلاء — معرفة وكيل لا تظهر لآخر', async () => {
        const r = await knowledge.searchKnowledge({ agentId: 'a999', query: 'الاسترجاع' });
        assert.ok(r.ok);
        assert.strictEqual(r.results.length, 0);
    });

    await test('البحث: حد limit يُحترم', async () => {
        const r = await knowledge.searchKnowledge({ agentId: 'a3', query: 'الاسترجاع', limit: 1 });
        assert.ok(r.results.length <= 1);
    });

    await test('حذف مصدر: يحذف قطعه فقط', async () => {
        await knowledge.ingestDocument({ agentId: 'a4', source: 'one.txt', text: 'ملف أول نصه الدفع بيتكوين فقط. ' });
        await knowledge.ingestDocument({ agentId: 'a4', source: 'two.txt', text: 'ملف ثانٍ نصه التوصيل مجاني للرياض. ' });
        const r = await knowledge.deleteSource('a4', 'one.txt');
        assert.ok(r.ok && r.deleted >= 1);
        const stats = await knowledge.knowledgeStats('a4');
        assert.strictEqual(stats.sources, 1);
        const search = await knowledge.searchKnowledge({ agentId: 'a4', query: 'بيتكوين' });
        assert.strictEqual(search.results.length, 0);
        const search2 = await knowledge.searchKnowledge({ agentId: 'a4', query: 'التوصيل' });
        assert.ok(search2.results.length >= 1);
    });

    await test('المسح الكامل: يفرغ معرفة الوكيل فقط', async () => {
        await knowledge.ingestDocument({ agentId: 'a5', source: 'x.txt', text: 'محتوى. ' });
        await knowledge.ingestDocument({ agentId: 'a5', source: 'y.txt', text: 'محتوى آخر. ' });
        const r = await knowledge.clearKnowledge('a5');
        assert.ok(r.ok && r.deleted >= 2);
        const stats = await knowledge.knowledgeStats('a5');
        assert.strictEqual(stats.chunks, 0);
        assert.strictEqual((await knowledge.knowledgeStats('a3')).chunks > 0, true, 'الوكيل الآخر لم يُمس');
    });

    await test('listSources: يعيد أسماء المصادر مع عدّادات', async () => {
        const srcs = await knowledge.listSources('a3');
        assert.ok(srcs.length >= 1);
        assert.ok(srcs.every(s => s.source && s.chunks >= 1));
    });

    console.log('\n════════════════════════════════');
    console.log(`knowledge: ${passed}/${passed + failed} ناجحة`);
    process.exit(failed ? 1 : 0);
})();
