/**
 * tests/usage.test.js — اختبارات تتبع الاستخدام (المستوى 2D)
 * ─────────────────────────────────────────────────────────────
 * يغطي: $inc على وثيقة اليوم، فصل الأيام، تفصيل الأدوات والمزودين،
 * الملخص والمخطط النصي، أمان بلا DB.
 */

'use strict';
const assert = require('assert');
const path = require('path');
const { ObjectId } = require('mongodb');

class FakeUsageCollection {
    constructor() { this.docs = new Map(); }
    key(q) { return `${q.agent_id}|${q.guild_id}|${q.day}`; }
    async updateOne(q, u, opts = {}) {
        const k = this.key(q);
        let d = this.docs.get(k);
        if (!d) {
            if (!opts.upsert) return { modifiedCount: 0 };
            d = { ...q, messages: 0, tool_calls: 0, web_calls: 0, fallbacks: 0, errors: 0, reminders: 0, knowledge_hits: 0, provider_total: 0, tool_counts: {}, provider_calls: {} };
            this.docs.set(k, d);
        }
        applyInc(d, u.$inc);
        if (u.$set) Object.assign(d, u.$set);
        if (u.$setOnInsert) {
            for (const [k2, v] of Object.entries(u.$setOnInsert)) if (d[k2] === undefined) d[k2] = v;
        }
        return { modifiedCount: 1 };
    }
    find(q) {
        const arr = [...this.docs.values()].filter(d =>
            d.agent_id === q.agent_id &&
            (!q.day?.$gte || d.day >= q.day.$gte) &&
            (!q.day?.$lte || d.day <= q.day.$lte));
        return { sort: () => ({ limit: () => ({ toArray: async () => arr }) }), toArray: async () => arr };
    }
}

function applyInc(d, inc) {
    for (const [k, v] of Object.entries(inc || {})) {
        if (k.includes('.')) {
            const [base, sub] = k.split('.');
            d[base] = d[base] || {};
            d[base][sub] = (d[base][sub] || 0) + v;
        } else {
            d[k] = (d[k] || 0) + v;
        }
    }
}

const fakeConfig = { usage_col: new FakeUsageCollection() };
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const usage = require('../usage');

let passed = 0, failed = 0;
function test(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { passed++; console.log(`✅ ${name}`); })
        .catch((e) => { failed++; console.error(`❌ ${name}: ${e.message}`); });
}

(async () => {
    await test('dayKey: صيغة YYYY-MM-DD', () => {
        assert.match(usage.dayKey(new Date('2025-06-01T15:30:00Z')), /^\d{4}-\d{2}-\d{2}$/);
        assert.strictEqual(usage.dayKey(new Date('2025-06-01T15:30:00Z')), '2025-06-01');
    });

    await test('incFieldsFor: كل نوع يُقن الحقل الصحيح', () => {
        assert.deepStrictEqual(usage.incFieldsFor('message'), { messages: 1 });
        assert.deepStrictEqual(usage.incFieldsFor('web'), { web_calls: 1 });
        assert.deepStrictEqual(usage.incFieldsFor('fallback'), { fallbacks: 1 });
        assert.deepStrictEqual(usage.incFieldsFor('error'), { errors: 1 });
        const t = usage.incFieldsFor('tool', { tool: 'get_members' });
        assert.strictEqual(t.tool_calls, 1);
        assert.strictEqual(t['tool_counts.get_members'], 1);
        const p = usage.incFieldsFor('provider', { provider: 'qwen' });
        assert.strictEqual(p['provider_calls.qwen'], 1);
        assert.strictEqual(p.provider_total, 1);
        // نوع غير معروف → null (لا يُسجل)
        assert.strictEqual(usage.incFieldsFor('unknown'), null);
        // تنظيف أسماء الأدوات الخطرة
        const bad = usage.incFieldsFor('tool', { tool: 'bad name.$hack' });
        assert.strictEqual(bad['tool_counts.badnamehack'], 1);
        assert.ok(!JSON.stringify(bad).includes('$hack'));
    });

    await test('track: يتراكم على وثيقة اليوم نفسه', async () => {
        await usage.track('ag1', 'g1', 'message');
        await usage.track('ag1', 'g1', 'message');
        await usage.track('ag1', 'g1', 'tool', { tool: 'web_search' });
        const rows = await usage.getAgentUsage('ag1', 7);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].messages, 2);
        assert.strictEqual(rows[0].tool_calls, 1);
        assert.strictEqual(rows[0].tool_counts.web_search, 1);
    });

    await test('track: عزل الوكلاء عن بعضها', async () => {
        await usage.track('agX', 'g1', 'message');
        const rows = await usage.getAgentUsage('ag1', 7);
        assert.ok(rows.every(r => !String(r.agent_id).includes('agX')));
    });

    await test('summarize: يجمّع الصحيح مع top_tools و provider_calls', () => {
        const s = usage.summarize([
            { day: '2025-01-01', messages: 5, tool_calls: 3, web_calls: 1, fallbacks: 1, errors: 0, reminders: 2, knowledge_hits: 4, tool_counts: { get_members: 2, web_search: 1 }, provider_calls: { deepseek: 3 } },
            { day: '2025-01-02', messages: 7, tool_calls: 1, web_calls: 0, fallbacks: 0, errors: 2, reminders: 0, knowledge_hits: 1, tool_counts: { get_members: 1 }, provider_calls: { qwen: 2 } },
        ]);
        assert.strictEqual(s.messages, 12);
        assert.strictEqual(s.tool_calls, 4);
        assert.strictEqual(s.web_calls, 1);
        assert.strictEqual(s.fallbacks, 1);
        assert.strictEqual(s.errors, 2);
        assert.strictEqual(s.reminders, 2);
        assert.strictEqual(s.knowledge_hits, 5);
        assert.deepStrictEqual(s.provider_calls, { deepseek: 3, qwen: 2 });
        assert.strictEqual(s.top_tools[0][0], 'get_members');
        assert.strictEqual(s.top_tools[0][1], 3);
        assert.strictEqual(s.per_day.length, 2);
    });

    await test('renderBars: مخطط نصي غير فارغ', () => {
        const bars = usage.renderBars([{ day: '2025-01-01', messages: 5 }, { day: '2025-01-02', messages: 2 }]);
        assert.ok(bars.includes('█'));
        assert.ok(bars.includes('2025-01-01'));
        assert.strictEqual(usage.renderBars([]), 'لا بيانات بعد');
    });

    await test('أمان بلا DB: track لا يرمي ويعيد false', async () => {
        const cfgBackup = fakeConfig.usage_col;
        fakeConfig.usage_col = null;
        const r = await usage.track('ag1', 'g1', 'message');
        assert.strictEqual(r, false);
        fakeConfig.usage_col = cfgBackup;
    });

    console.log('\n════════════════════════════════');
    console.log(`usage: ${passed}/${passed + failed} ناجحة`);
    process.exit(failed ? 1 : 0);
})();
