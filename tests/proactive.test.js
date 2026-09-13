/**
 * tests/proactive.test.js — اختبارات الاستباقية (المستوى 2E)
 * ─────────────────────────────────────────────────────────────
 * يغطي: تنظيف الكلمات والتطبيع العربي، مطابقة القناة والكلمة،
 * التهدئة لكل قناة، رفض البوتات والخاص، حدود التهدئة، sanitize.
 */

'use strict';
const assert = require('assert');
const proactive = require('../proactive');

let passed = 0, failed = 0;
function test(name, fn) {
    return Promise.resolve().then(fn)
        .then(() => { passed++; console.log(`✅ ${name}`); })
        .catch((e) => { failed++; console.error(`❌ ${name}: ${e.message}`); });
}

(async () => {
    await test('normalizeKeyword: تطبيع عربي (همزات/ة-ه/تشكيل)', () => {
        assert.strictEqual(proactive.normalizeKeyword('الأَسْعَار'), 'الاسعار');
        assert.strictEqual(proactive.normalizeKeyword('مدرسة'), 'مدرسه');
        assert.strictEqual(proactive.normalizeKeyword('  HELLO   World '), 'hello world');
    });

    await test('cleanKeywords: فصل بالفاصلة والسطر + dedup', () => {
        const k = proactive.cleanKeywords('سعر, السعر، خصم\nخصم  , أ');
        assert.deepStrictEqual(k, ['سعر', 'السعر', 'خصم']);
    });

    await test('cleanKeywords: كلمة قصيرة جداً تُرفض', () => {
        assert.deepStrictEqual(proactive.cleanKeywords('أ,ب'), []);
    });

    await test('clampCooldown: ضمن 1..720 مع افتراضي 10', () => {
        assert.strictEqual(proactive.clampCooldown(0), 10);
        assert.strictEqual(proactive.clampCooldown(-5), 10);
        assert.strictEqual(proactive.clampCooldown('abc'), 10);
        assert.strictEqual(proactive.clampCooldown(0.4), 1);
        assert.strictEqual(proactive.clampCooldown(5000), 720);
        assert.strictEqual(proactive.clampCooldown(30), 30);
    });

    await test('sanitizeEntries: يرفض القنوات غير الصالحة والفارغة الكلمات', () => {
        const entries = proactive.sanitizeEntries([
            { channel_id: '123456789012345678', keywords: ['سعر'], cooldown_minutes: 5 },
            { channel_id: 'bad', keywords: ['سعر'] },
            { channel_id: '123456789012345679', keywords: [] },
            null,
            { channel_id: '123456789012345680', keywords: 'تذكير، منبه' },
        ]);
        assert.strictEqual(entries.length, 2);
        assert.strictEqual(entries[0].cooldown_minutes, 5);
        assert.deepStrictEqual(entries[1].keywords, ['تذكير', 'منبه']);
    });

    const entries = [{ channel_id: '111111111111111111', keywords: ['سعر', 'خصم'], cooldown_minutes: 10 }];

    await test('matchProactive: مطابقة قناة + كلمة', () => {
        const cooldowns = new Map();
        const r = proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'كم سعر الاشتراك؟', cooldowns, guildId: 'g1' });
        assert.ok(r);
        assert.strictEqual(r.keyword, 'سعر');
    });

    await test('matchProactive: كلمة غير موجودة حرفياً → null (مطابقة نصية دقيقة)', () => {
        // «أخصومات» بعد التطبيع «اخصومات» لا تحتوي «خصم» حرفياً — المطابقة نصية وليست تقريبية
        const r = proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'فيه أخصومات؟', cooldowns: new Map(), guildId: 'g1' });
        assert.strictEqual(r, null);
        // لكن «خصم» ككلمة واضحة تطابق فوراً
        const r2 = proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'فيه خصم كبير؟', cooldowns: new Map(), guildId: 'g1' });
        assert.ok(r2);
        assert.strictEqual(r2.keyword, 'خصم');
    });

    await test('matchProactive: قناة غير مُصغاة → null', () => {
        assert.strictEqual(proactive.matchProactive({ entries, channelId: '999999999999999999', content: 'سعر', cooldowns: new Map(), guildId: 'g1' }), null);
    });

    await test('matchProactive: بلا كلمة مفتاحية → null', () => {
        assert.strictEqual(proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'رسالة عادية بلا كلمات', cooldowns: new Map(), guildId: 'g1' }), null);
    });

    await test('matchProactive: بوتات وخاص مرفوضة دائماً', () => {
        assert.strictEqual(proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'سعر', isBot: true, cooldowns: new Map(), guildId: 'g1' }), null);
        assert.strictEqual(proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'سعر', isDm: true, cooldowns: new Map(), guildId: 'g1' }), null);
    });

    await test('التهدئة: نفس القناة خلال التهدئة → null، بعدها → تعمل', () => {
        const cooldowns = new Map();
        const now = 1_000_000_000;
        const r1 = proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'سعر', now, cooldowns, guildId: 'g1' });
        assert.ok(r1);
        // بعد دقيقة فقط — مرفوضة (التهدئة 10 د)
        const r2 = proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'خصم', now: now + 60_000, cooldowns, guildId: 'g1' });
        assert.strictEqual(r2, null);
        // بعد 11 دقيقة — مقبولة
        const r3 = proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'سعر', now: now + 11 * 60_000, cooldowns, guildId: 'g1' });
        assert.ok(r3);
    });

    await test('التهدئة: لكل قناة على حدة', () => {
        const cooldowns = new Map();
        const entries2 = [
            { channel_id: '111111111111111111', keywords: ['سعر'], cooldown_minutes: 60 },
            { channel_id: '222222222222222222', keywords: ['سعر'], cooldown_minutes: 60 },
        ];
        const now = 5_000_000;
        assert.ok(proactive.matchProactive({ entries: entries2, channelId: '111111111111111111', content: 'سعر', now, cooldowns, guildId: 'g1' }));
        // قناة أخرى ما زالت حرة فوراً
        assert.ok(proactive.matchProactive({ entries: entries2, channelId: '222222222222222222', content: 'سعر', now, cooldowns, guildId: 'g1' }));
        // الأولى الآن في تهدئة
        assert.strictEqual(proactive.matchProactive({ entries: entries2, channelId: '111111111111111111', content: 'سعر', now, cooldowns, guildId: 'g1' }), null);
    });

    await test('matchProactive: تهدئة لكل سيرفر وليس عالمية', () => {
        const cooldowns = new Map();
        const now = 7_000_000;
        assert.ok(proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'سعر', now, cooldowns, guildId: 'guild-A' }));
        // نفس القناة لكن سيرفر مختلف — حرة
        assert.ok(proactive.matchProactive({ entries, channelId: '111111111111111111', content: 'سعر', now, cooldowns, guildId: 'guild-B' }));
    });

    await test('isEnabled: توافق قديم — بلا إعداد = معطلة', () => {
        assert.strictEqual(proactive.isEnabled({}), false);
        assert.strictEqual(proactive.isEnabled({ proactive_enabled: true }), true);
        assert.strictEqual(proactive.isEnabled({ proactive_enabled: false }), false);
    });

    console.log('\n════════════════════════════════');
    console.log(`proactive: ${passed}/${passed + failed} ناجحة`);
    process.exit(failed ? 1 : 0);
})();
