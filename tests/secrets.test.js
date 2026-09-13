/**
 * tests/secrets.test.js — اختبارات تشفير الأسرار AES-256-GCM (المستوى 2F)
 * ─────────────────────────────────────────────────────────────
 * يغطي: roundtrip، pass-through للنص القديم، عبث البيان، الأقنعة،
 * decryptAgentDoc / encryptSecretsInPatch، الترحيل (idempotent)، بلا مفتاح.
 */

'use strict';
const assert = require('assert');
const path = require('path');

const { ObjectId } = require('mongodb');

// حقن config وهمي قبل تحميل الوحدات
const fakeConfig = { agents_col: null };
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const secrets = require('../secrets');

let passed = 0;
let failed = 0;
function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`✅ ${name}`); })
        .catch((e) => { failed++; console.error(`❌ ${name}: ${e.message}`); });
}

(async () => {
    // ── بلا مفتاح: passthrough + لا يرمي ──
    delete process.env.ENCRYPTION_KEY;
    secrets.resetKeyForTests();

    await test('بلا مفتاح: encryptSecret يعيد النص كما هو', () => {
        assert.strictEqual(secrets.encryptSecret('abc123'), 'abc123');
        assert.strictEqual(secrets.getKey(), null);
    });

    await test('بلا مفتاح: decryptSecret pass-through للنص القديم', () => {
        assert.strictEqual(secrets.decryptSecret('plain-token'), 'plain-token');
    });

    // ── بمفتاح hex 64 ──
    const HEX = 'a'.repeat(64);
    process.env.ENCRYPTION_KEY = HEX;
    secrets.resetKeyForTests();

    await test('roundtrip: تشفير ثم فك يعيد الأصل', () => {
        const enc = secrets.encryptSecret('my-secret-token-xyz');
        assert.ok(enc.startsWith('enc:v1:'), 'الصيغة enc:v1:');
        assert.notStrictEqual(enc, 'my-secret-token-xyz');
        assert.strictEqual(secrets.decryptSecret(enc), 'my-secret-token-xyz');
    });

    await test('كل تشفير ينتج IV مختلف (نفس النص ينتج بيانين مختلفين)', () => {
        const a = secrets.encryptSecret('same');
        const b = secrets.encryptSecret('same');
        assert.notStrictEqual(a, b);
        assert.strictEqual(secrets.decryptSecret(a), 'same');
        assert.strictEqual(secrets.decryptSecret(b), 'same');
    });

    await test('pass-through: النص القديم غير المشفر يُعاد كما هو حتى بمفتاح', () => {
        assert.strictEqual(secrets.decryptSecret('legacy-plain'), 'legacy-plain');
        // encryptSecret لا يعيد تشفير المشفر مسبقاً
        const enc = secrets.encryptSecret('abc');
        assert.strictEqual(secrets.encryptSecret(enc), enc);
    });

    await test('عبث بالبيان → decryptSecret يعيد null (لا تسريب)', () => {
        const enc = secrets.encryptSecret('top-secret');
        const parts = enc.split(':');
        const data = Buffer.from(parts[4], 'base64');
        data[0] = data[0] ^ 0xff;
        parts[4] = data.toString('base64');
        assert.strictEqual(secrets.decryptSecret(parts.join(':')), null);
    });

    await test('مفتاح مختلف → فك يفشل (null)', () => {
        const enc = secrets.encryptSecret('value-1');
        process.env.ENCRYPTION_KEY = 'b'.repeat(64);
        secrets.resetKeyForTests();
        assert.strictEqual(secrets.decryptSecret(enc), null);
        // استعادة
        process.env.ENCRYPTION_KEY = HEX;
        secrets.resetKeyForTests();
    });

    await test('صيغ تالفة → null وليس استثناء', () => {
        assert.strictEqual(secrets.decryptSecret('enc:v1:bad'), null);
        assert.strictEqual(secrets.decryptSecret('enc:v1:only:two:'), null);
        assert.strictEqual(secrets.decryptSecret(''), '');
        assert.strictEqual(secrets.decryptSecret(null), null);
    });

    await test('maskSecret: يقنّع ويُظهر آخر 4 فقط', () => {
        assert.ok(secrets.maskSecret('abcdefghij1234').includes('••••'));
        assert.ok(secrets.maskSecret('abcdefghij1234').endsWith('1234'));
        assert.ok(!secrets.maskSecret('abcdefghij1234').includes('abcdefghij'));
        const enc = secrets.encryptSecret('abcdefghij1234');
        assert.ok(secrets.maskSecret(enc).endsWith('1234'), 'يقنّع المشفر أيضاً');
        assert.strictEqual(secrets.maskSecret(''), 'غير محدد');
        assert.strictEqual(secrets.maskSecret('short'), '••••••••');
    });

    await test('decryptAgentDoc: يفك الحقول السرية فقط ولا يعدّل الأصل', () => {
        const doc = {
            _id: new ObjectId(),
            name: 'وكيل',
            discord_token: secrets.encryptSecret('discord-plain'),
            qwen_token: secrets.encryptSecret('qwen-plain'),
            qwen_model: 'qwen3-max',
            personality: 'طيبة',
        };
        const out = secrets.decryptAgentDoc(doc);
        assert.strictEqual(out.discord_token, 'discord-plain');
        assert.strictEqual(out.qwen_token, 'qwen-plain');
        assert.strictEqual(out.qwen_model, 'qwen3-max');
        assert.ok(secrets.isEncrypted(doc.discord_token), 'الأصل لم يُعدّل');
    });

    await test('encryptSecretsInPatch: يشفر الأسرار داخل $set ويترك البقية', () => {
        const patch = { deepseek_token: 'raw-ds', name: 'x', personality: '' };
        secrets.encryptSecretsInPatch(patch);
        assert.ok(secrets.isEncrypted(patch.deepseek_token));
        assert.strictEqual(secrets.decryptSecret(patch.deepseek_token), 'raw-ds');
        assert.strictEqual(patch.name, 'x');
        // القيمة الفارغة تبقى كما هي
        const p2 = { openai_api_key: '' };
        secrets.encryptSecretsInPatch(p2);
        assert.strictEqual(p2.openai_api_key, '');
    });

    await test('الترحيل: يشفر النصوص ويكرر بأمان (idempotent)', async () => {
        const docs = new Map();
        const col = {
            async find() {
                return { async *[Symbol.asyncIterator]() { for (const d of docs.values()) yield d; } };
            },
            async updateOne(q, u) {
                const d = [...docs.values()].find(x => String(x._id) === String(q._id));
                if (d && u.$set) Object.assign(d, u.$set);
                return { modifiedCount: d ? 1 : 0 };
            },
        };
        const a1 = { _id: new ObjectId(), discord_token: 'plain-dt', deepseek_token: 'plain-ds' };
        const a2 = { _id: new ObjectId(), discord_token: secrets.encryptSecret('already'), name: 'x' };
        docs.set(a1._id.toString(), a1);
        docs.set(a2._id.toString(), a2);

        const r1 = await secrets.migrateAgentTokensEncryption(col);
        assert.strictEqual(r1.skipped, false);
        assert.strictEqual(r1.encrypted, 1, 'وكيل واحد فقط يحتاج تشفيراً');
        assert.strictEqual(secrets.decryptSecret(a1.discord_token), 'plain-dt');
        assert.strictEqual(secrets.decryptSecret(a1.deepseek_token), 'plain-ds');
        assert.strictEqual(secrets.decryptSecret(a2.discord_token), 'already');

        // مرة ثانية: لا شيء يُشفّر (كلها مشفرة أصلاً)
        const r2 = await secrets.migrateAgentTokensEncryption(col);
        assert.strictEqual(r2.encrypted, 0);
    });

    await test('الترحيل بدون مفتاح: skipped مع سبب', async () => {
        delete process.env.ENCRYPTION_KEY;
        secrets.resetKeyForTests();
        const r = await secrets.migrateAgentTokensEncryption({});
        assert.strictEqual(r.skipped, true);
        assert.ok(r.reason);
        process.env.ENCRYPTION_KEY = HEX;
        secrets.resetKeyForTests();
    });

    await test('مفتاح عبارة نصية (scrypt): يعمل roundtrip', () => {
        process.env.ENCRYPTION_KEY = 'my super secret passphrase 2025';
        secrets.resetKeyForTests();
        const enc = secrets.encryptSecret('phrase-based');
        assert.ok(enc.startsWith('enc:v1:'));
        assert.strictEqual(secrets.decryptSecret(enc), 'phrase-based');
        // نفس العبارة تنتج نفس المفتاح — قيمة مشفرة بجلسة سابقة تُفك
        secrets.resetKeyForTests();
        assert.strictEqual(secrets.decryptSecret(enc), 'phrase-based');
        delete process.env.ENCRYPTION_KEY;
        secrets.resetKeyForTests();
    });

    console.log('\n════════════════════════════════');
    console.log(`secrets: ${passed}/${passed + failed} ناجحة`);
    process.exit(failed ? 1 : 0);
})();
