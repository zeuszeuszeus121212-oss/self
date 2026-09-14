/**
 * tests/recovery_ladder.test.js — v7.11 «La Yansaa»
 * ─────────────────────────────────────────────────────────────
 * يغطي سلّم التعافي الكامل وذاكرة القناة وحرية التجاهل والتفاعل:
 *   1) تقسيم المفاتيح المتعددة (سطر/|/, والكوكيز بلا فاصلة)
 *   2) سلّم التعافي: محادثة جديدة ×2 → مفتاح تالٍ → نفاد المفاتيح → مزود تالٍ
 *   3) مفتاح تالٍ يعمل بعد فشل المفتاح الأساسي → رد طبيعي
 *   4) حقن ذاكرة القناة عند بداية جلسة جديدة فقط (وليس عند استمرار الجلسة)
 *   5) 🙈 إشارة التجاهل → بلا رد
 *   6) 😄 تفاعل إيموجي فقط + تفاعل مع رد + رفض إيموجي غير صالح
 *   7) نفاد كل شيء → وجه بشري للقناة
 *   8) 🧷 الحفظ التلقائي الحتمي «تذكر أنني…»
 */

'use strict';
const assert = require('assert');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));

function makeFakeCol() {
    const docs = new Map();
    let seq = 0;
    return {
        async findOne(f, o) {
            for (const d of docs.values()) {
                let ok = true;
                for (const [k, v] of Object.entries(f || {})) {
                    if (typeof v === 'object' && v && v.$in) { if (!v.$in.includes(d[k])) { ok = false; break; } continue; }
                    if (d[k] !== v) { ok = false; break; }
                }
                if (ok) return JSON.parse(JSON.stringify(d));
            }
            return null;
        },
        async insertOne(d) { d._id = `oid_${++seq}`; docs.set(d._id, JSON.parse(JSON.stringify(d))); return { insertedId: d._id }; },
        async updateOne() { return {}; },
        async countDocuments(f) {
            let n = 0;
            for (const d of docs.values()) {
                let ok = true;
                for (const [k, v] of Object.entries(f || {})) if (d[k] !== v) { ok = false; break; }
                if (ok) n++;
            }
            return n;
        },
        find(f) {
            const all = [...docs.values()].filter((d) => {
                for (const [k, v] of Object.entries(f || {})) {
                    if (typeof v === 'object' && v && v.$in) { if (!v.$in.includes(d[k])) return false; continue; }
                    if (d[k] !== v) return false;
                }
                return true;
            }).map(d => JSON.parse(JSON.stringify(d)));
            return {
                sort(s) {
                    const [[k, dir]] = Object.entries(s || { created_at: 1 });
                    all.sort((a, b) => dir === 1 ? String(a[k]).localeCompare(String(b[k])) : String(b[k]).localeCompare(String(a[k])));
                    return this;
                },
                limit() { return this; },
                skip() { return this; },
                async toArray() { return all; },
            };
        },
        aggregate(pipeline) {
            const group = pipeline.find(p => p.$group);
            if (!group) throw new Error('no group');
            const acc = new Map();
            for (const d of docs.values()) {
                const key = String(d[group.$group._id.replace('$', '')]);
                const cur = acc.get(key) || { _id: key, total: 0, last: null };
                cur.total++;
                if (!cur.last || new Date(d.created_at) > new Date(cur.last)) cur.last = d.created_at;
                acc.set(key, cur);
            }
            return { async toArray() { return [...acc.values()]; } };
        },
        async deleteMany(f) {
            let n = 0;
            for (const [id, d] of [...docs.entries()]) {
                let ok = true;
                for (const [k, v] of Object.entries(f || {})) if (d[k] !== v) { ok = false; break; }
                if (ok) { docs.delete(id); n++; }
            }
            return { deletedCount: n };
        },
        async deleteOne() { return {}; },
        async distinct() { return []; },
    };
}

const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: makeFakeCol(),
    reminders_col: makeFakeCol(),
    knowledge_col: makeFakeCol(),
    channel_history_col: makeFakeCol(),
    guild_registry_col: makeFakeCol(),
    guild_activity_col: makeFakeCol(),
    agents_col: { findOne: async () => null },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    settings_col: { findOne: async () => null },
    usage_col: makeFakeCol(),
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const providers = require('../providers');
const { runAgent, isIgnoreSignal, isValidReactEmoji } = require('../tools');
const channelHistory = require('../channelHistory');
const memory = require('../memory');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

// مزودات وهمية — تسجل (مفتاح، جلسة، برومبت فيه ذاكرة؟) لكل استدعاء
let callLog = [];

function registerFakeDeepseek(behavior) {
    // نستخدم id='deepseek' الحقيقي ليشتغل mapping حقل المفتاح deepseek_token
    providers.PROVIDERS['deepseek'] = {
        id: 'deepseek', label: 'ديبسيك وهمي', emoji: '🐋', description: 'w',
        modalFields: [],
        validate: () => ({ ok: true, missing: [] }),
        describe: () => 'w',
        async testConnection() { return 'ok'; },
        async chat({ prompt, sessionId, config }) {
            const key = String(config.deepseek_token || '');
            callLog.push({ key, newConversation: !sessionId, hasHistory: prompt.includes('ذاكرة هذه القناة') });
            const r = await behavior(key, prompt);
            if (r instanceof Error) throw r;
            return r;
        },
    };
}

async function run() {
    // ═══════════════════════════════════════════
    //  1) تقسيم المفاتيح المتعددة
    // ═══════════════════════════════════════════
    {
        assert.deepStrictEqual(providers.splitFieldKeys('deepseek_token', 'sk-a\nsk-b\nsk-a'), ['sk-a', 'sk-b'], 'أسطر + dedup');
        assert.deepStrictEqual(providers.splitFieldKeys('deepseek_token', 'sk-a | sk-b,sk-c'), ['sk-a', 'sk-b', 'sk-c'], 'أنبوب وفاصلة للمفاتيح النصية');
        assert.deepStrictEqual(providers.splitFieldKeys('gemini_cookies', 'a=1; b=2, c=3'), ['a=1; b=2, c=3'], 'الكوكيز لا تنقسم بالفاصلة');
        assert.strictEqual(providers.countKeys('deepseek', { deepseek_token: 'k1|k2|k3' }), 3);
        assert.strictEqual(providers.countKeys('qwen', { qwen_token: '' }), 0);
        assert.ok(providers.describeKeys('deepseek', { deepseek_token: 'k1\nk2' }).includes('مفاتيح'));
        ok('1) تقسيم المفاتيح: أسطر/أنبوب/فاصلة + الكوكيز محمية');
    }

    // ═══════════════════════════════════════════
    //  2) سلّم التعافي الكامل: 3 مفاتيح كلها تفشل → البديل يجيب
    //     التسلسل: k1,k1,k1 (محادثة جديدة ×2) → k2,k2,k2 → k3,k3,k3 → backup
    // ═══════════════════════════════════════════
    {
        callLog = [];
        registerFakeDeepseek(async (key) => new Error(`فشل المفتاح ${key}`));
        providers.PROVIDERS['backup_ok'] = {
            id: 'backup_ok', label: 'بديل يعمل', emoji: '🟢', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat({ sessionId }) {
                callLog.push({ key: 'backup', newConversation: !sessionId });
                return { fullText: 'رد البديل بعد نفاد المفاتيح', sessionId: 'bak_sid', newParentMessageId: null };
            },
        };
        const result = await runAgent(
            null, null, 'مرحبا', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            {
                agentId: 'AG_LADDER',
                provider: 'deepseek',
                providerConfig: { deepseek_token: 'k1|k2|k3' },
                fallback_enabled: true,
                fallback_chain: ['backup_ok'],
                fallback_configs: {},
            },
            { userId: 'U1', channelId: 'C1' },
        );
        assert.strictEqual(result.reply, 'رد البديل بعد نفاد المفاتيح');
        const dsCalls = callLog.filter(c => c.key !== 'backup');
        const keys = dsCalls.map(c => c.key);
        assert.deepStrictEqual(keys, ['k1', 'k1', 'k1', 'k2', 'k2', 'k2', 'k3', 'k3', 'k3'], `سلّم المفاتيح: ${keys.join(',')}`);
        assert.ok(dsCalls.every(c => c.newConversation), 'كل محاولة فاشلة تبدأ محادثة جديدة');
        assert.strictEqual(callLog[callLog.length - 1].key, 'backup');
        delete providers.PROVIDERS['backup_ok'];
        ok('2) سلّم التعافي: محادثة جديدة ×2 لكل مفتاح → المفتاح التالي → المزود البديل');
    }

    // ═══════════════════════════════════════════
    //  3) المفتاح الأول ميت والثاني حي — لا حاجة للبديل
    // ═══════════════════════════════════════════
    {
        callLog = [];
        registerFakeDeepseek(async (key, prompt) => {
            if (key === 'k_dead') return new Error('توكن ميت');
            return { fullText: `حياك الله (المفتاح ${key})`, sessionId: 'sid_k2', newParentMessageId: null };
        });
        const result = await runAgent(
            null, null, 'شخبارك', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            {
                agentId: 'AG_LADDER',
                provider: 'deepseek',
                providerConfig: { deepseek_token: 'k_dead\nk_alive' },
                fallback_enabled: false,
            },
            { userId: 'U1', channelId: 'C1' },
        );
        assert.strictEqual(result.reply, 'حياك الله (المفتاح k_alive)');
        const keys = callLog.map(c => c.key);
        assert.deepStrictEqual(keys, ['k_dead', 'k_dead', 'k_dead', 'k_alive'], `الميت ×3 ثم الحي: ${keys.join(',')}`);
        assert.strictEqual(result.newSid, 'sid_k2');
        ok('3) مفتاح ميت ×3 محاولات → المفتاح التالي ينجح بدون مزود بديل');
    }

    // ═══════════════════════════════════════════
    //  4) حقن ذاكرة القناة — بداية جلسة جديدة فقط
    // ═══════════════════════════════════════════
    {
        await channelHistory.appendMessage({ agentId: 'AG_H', guildId: 'g1', channelId: 'C9', role: 'user', content: 'أنا أحب المانجا', userId: 'U9', username: 'زيزو' });
        await channelHistory.appendMessage({ agentId: 'AG_H', guildId: 'g1', channelId: 'C9', role: 'assistant', content: 'والمانجا فن حقيقي', username: 'وكيل' });

        callLog = [];
        registerFakeDeepseek(async (key, prompt) => ({ fullText: prompt.includes('ذاكرة هذه القناة') ? 'أتذكر حديثنا' : 'لا ذاكرة', sessionId: 's1', newParentMessageId: null }));

        // بلا جلسة قائمة → الحقن يجب أن يحدث
        await runAgent(null, null, 'تكلم', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'AG_H', provider: 'deepseek', providerConfig: { deepseek_token: 'k1' } },
            { userId: 'U9', channelId: 'C9' });
        assert.strictEqual(callLog[0].hasHistory, true, 'بلا جلسة → ذاكرة القناة محقونة');

        // بجلسة قائمة → لا حقن مكرر (الجلسة تحفظ السياق)
        callLog = [];
        await runAgent(null, null, 'تكلم', '', '', 'وكيل', 'sess_live', 'pm_live', 'g1', 'default', false, 'member', null,
            { agentId: 'AG_H', provider: 'deepseek', providerConfig: { deepseek_token: 'k1' } },
            { userId: 'U9', channelId: 'C9' });
        assert.strictEqual(callLog[0].hasHistory, false, 'جلسة حية → لا حقن مكرر');

        // عزل وكلاء: وكيل آخر لا يرى ذاكرة وكيل AG_H
        callLog = [];
        await runAgent(null, null, 'تكلم', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'AG_OTHER', provider: 'deepseek', providerConfig: { deepseek_token: 'k1' } },
            { userId: 'U9', channelId: 'C9' });
        assert.strictEqual(callLog[0].hasHistory, false, 'وكيل آخر لا يرى ذاكرة وكيل آخر');
        ok('4) حقن ذاكرة القناة: بداية جلسة فقط + عزل كامل بين الوكلاء');
    }

    // ═══════════════════════════════════════════
    //  5) 🙈 إشارة التجاهل
    // ═══════════════════════════════════════════
    {
        assert.ok(isIgnoreSignal('IGNORE_MSG'), 'IGNORE_MSG');
        assert.ok(isIgnoreSignal('  {"ignore": true}  '), 'JSON variant');
        assert.ok(isIgnoreSignal('ignore_msg'), 'lowercase');
        assert.ok(!isIgnoreSignal('أنا ما أقدر أتجاهل، IGNORE_MSG جميلة'), 'لا تنطلق وسط نص');
        assert.ok(!isIgnoreSignal('حاب أتجاهلك'), 'كلام عادي لا يُعتبر تجاهل');

        registerFakeDeepseek(async () => ({ fullText: 'IGNORE_MSG', sessionId: 's9', newParentMessageId: null }));
        const result = await runAgent(null, null, 'يا أهبل', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'AG_IGN', provider: 'deepseek', providerConfig: { deepseek_token: 'k1' } },
            { userId: 'U1', channelId: 'C1' });
        assert.strictEqual(result.ignored, true, 'result.ignored مفعّل');
        assert.strictEqual(result.reply, null, 'لا يوجد رد إطلاقاً');
        ok('5) التجاهل: إشارة النموذج → بلا أي رد (النظام يضع الإيموجي لاحقاً)');
    }

    // ═══════════════════════════════════════════
    //  6) 😄 تفاعل الإيموجي
    // ═══════════════════════════════════════════
    {
        assert.ok(isValidReactEmoji('😂') && isValidReactEmoji('🔥') && isValidReactEmoji('<:meme:123456789012345678>'), 'صحيحة');
        assert.ok(!isValidReactEmoji('hello') && !isValidReactEmoji(''), 'نص عادي مرفوض');

        // تفاعل فقط بلا نص
        registerFakeDeepseek(async () => ({ fullText: '```json\n{"tool":"react","params":{"emoji":"🔥"}}\n```', sessionId: null, newParentMessageId: null }));
        const r1 = await runAgent(null, null, 'ههههه', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'AG_R', provider: 'deepseek', providerConfig: { deepseek_token: 'k1' } },
            { userId: 'U1', channelId: 'C1' });
        assert.deepStrictEqual(r1.react, ['🔥'], 'تفاعل فقط');
        assert.strictEqual(r1.reply, null, 'بلا نص');

        // تفاعل + رد نصي
        registerFakeDeepseek(async () => ({ fullText: '```json\n{"tool":"react","params":{"emoji":"😂"},"reply":"هههه والله"}\n```', sessionId: null, newParentMessageId: null }));
        const r2 = await runAgent(null, null, 'نكتة', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'AG_R', provider: 'deepseek', providerConfig: { deepseek_token: 'k1' } },
            { userId: 'U1', channelId: 'C1' });
        assert.deepStrictEqual(r2.react, ['😂']);
        assert.strictEqual(r2.reply, 'هههه والله');

        // إيموجي غير صالح → لا تفاعل، والنموذج يُعلم بالخطأ
        registerFakeDeepseek(async () => ({ fullText: '```json\n{"tool":"react","params":{"emoji":"بنجيني"}}\n```', sessionId: null, newParentMessageId: null }));
        const r3 = await runAgent(null, null, 'شيء', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'AG_R', provider: 'deepseek', providerConfig: { deepseek_token: 'k1' } },
            { userId: 'U1', channelId: 'C1' });
        assert.strictEqual(r3.react.length, 0, 'الإيموجي الغبي مرفوض');
        ok('6) التفاعل: إيموجي فقط / إيموجي + رد / رفض الإيموجي غير الصالح');
    }

    // ═══════════════════════════════════════════
    //  7) نفاد كل شيء → وجه بشري محايد
    // ═══════════════════════════════════════════
    {
        const errorReporter = require('../errorReporter');
        errorReporter._resetForTests();
        const reports = [];
        errorReporter.setManagerNotifier(async (r) => { reports.push(r); });

        callLog = [];
        registerFakeDeepseek(async () => new Error('كل المفاتيح انفجرت'));
        const result = await runAgent(null, null, 'مرحبا', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'AG_DEAD', provider: 'deepseek', providerConfig: { deepseek_token: 'k1\nk2' } },
            { userId: 'U1', channelId: 'C1' });
        assert.ok(errorReporter.isPublicFace(result.reply), 'وجه بشري للقناة');
        assert.ok(!result.reply.includes('انفجرت'), 'لا تسريب تقني');
        assert.strictEqual(callLog.length, 6, `مفتاحان × 3 محاولات = 6: ${callLog.length}`);
        await new Promise(r => setTimeout(r, 60));
        assert.ok(reports.length >= 1, 'تقرير للإشعارات');
        errorReporter._resetForTests();
        ok('7) نفاد كل شيء: وجه بشري للقناة + تقرير مفصل للإشعارات');
    }

    // ═══════════════════════════════════════════
    //  8) 🧷 الحفظ التلقائي الحتمي «تذكر أنني…»
    // ═══════════════════════════════════════════
    {
        const r1 = await memory.maybeAutoCapture({ agentId: 'AG_M', guildId: 'g1', userId: 'U7', text: 'تذكر أنني مطور مانهوا محترف' });
        assert.strictEqual(r1.saved, 1, 'حفظ أول');
        assert.ok(r1.texts[0].includes('مطور مانهوا'));
        const r2 = await memory.maybeAutoCapture({ agentId: 'AG_M', guildId: 'g1', userId: 'U7', text: 'تذكر أنني مطور مانهوا محترف' });
        assert.strictEqual(r2.saved, 1, 'dedup يحدث الحداثة ويعيد ok');
        const r3 = await memory.maybeAutoCapture({ agentId: 'AG_M', guildId: 'g1', userId: 'U7', text: 'صباح الخير كيفك' });
        assert.strictEqual(r3.saved, 0, 'كلام عادي لا يُحفظ');
        const ctx = await memory.buildMemoryContext({ agentId: 'AG_M', guildId: 'g1', userId: 'U7' });
        assert.ok(ctx.includes('مطور مانهوا'), 'الذكرى المحفوظة تُحقن في السياق');
        ok('8) الحفظ الحتمي: «تذكر أنني…» يُحفظ ويُحقن تلقائياً مع dedup');
    }

    // ═══════════════════════════════════════════
    //  9) تنظيف السجل — إعادة المزود الحقيقي
    // ═══════════════════════════════════════════
    {
        delete providers.PROVIDERS['deepseek'];
        providers.PROVIDERS['deepseek'] = require('../providers/deepseek');
        assert.strictEqual(providers.PROVIDERS.deepseek.id, 'deepseek', 'المزود الحقيقي استُعيد');
        assert.ok(!providers.PROVIDERS.backup_ok, 'لا بقايا للمزودات الوهمية');
        ok('9) المزود الحقيقي استُعيد بعد الاختبار');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`recovery_ladder: ${passed}/9 ناجحة`);
}

run().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
