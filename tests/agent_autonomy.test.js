/**
 * tests/agent_autonomy.test.js — المبادرة الذاتية والأدوات العابرة للسيرفرات (v7.18)
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالك الحرفي (v7.18):
 *  «لماذا تعمل فقط مع السيرفر الحالي للوكيل ولا يستطيع استخدامها لجلب
 *   رسائل من قنوات سيرفر اخر؟»
 *  «اذا كان وكيل لماذا ليس لديه الاستقلالية في التفكير واستخدام الادوات
 *   بحرية؟ لا اريده فقط عندما اطلب منه استخدم او طلب يتعلق بادوات
 *   بل هو يفكر ويستخدم... اريده وكيل حقيقي!»
 *
 * يثبت:
 *  1) برومبت النظام في نسخه الثلاث (وكيل كامل/عضو/محادثة) يحمل قسم
 *     «المبادرة الذاتية» — الوكيل يقرر استخدام حواسه بنفسه دون طلب.
 *  2) المثال الحرفي من بلاغ المالك داخل البرومبت: «ما رأيك باللعبة السابقة؟»
 *     → يقرأ رسائل القناة بنفسه.
 *  3) أدوات القراءة موثقة بأنها تعبر السيرفرات (target_guild + بحث كل
 *     سيرفرات العميل) — لا حصر بالسيرفر الحالي بعد اليوم.
 *  4) صلاحية admin: أدوات التنفيذ محصورة بالسيرفر الحالي لكن القراءة
 *     عبر السيرفرات مسموحة موثقة (كانت ممنوعة كلياً على owner فقط).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const { buildSystem } = require('../tools/systemPrompt');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

const base = {
    botName: 'وكيل التجارب', mode: 'default', thinking: false,
    personality: '', features: {}, capabilities: {},
};

function run() {
    // ── 1) قسم المبادرة الذاتية في النسخ الثلاث ──
    const adminPrompt = buildSystem(base.botName, base.mode, base.thinking, 'admin', base.personality, base.features, base.capabilities, 'agent');
    const memberPrompt = buildSystem(base.botName, base.mode, base.thinking, 'member', base.personality, base.features, base.capabilities, 'agent');
    const chatPrompt = buildSystem(base.botName, base.mode, base.thinking, 'member', base.personality, base.features, base.capabilities, 'chat');
    const ownerPrompt = buildSystem(base.botName, base.mode, base.thinking, 'owner', base.personality, base.features, base.capabilities, 'agent');

    for (const [label, prompt] of [['admin', adminPrompt], ['member', memberPrompt], ['chat', chatPrompt], ['owner', ownerPrompt]]) {
        assert.ok(prompt.includes('المبادرة الذاتية'), `${label}: قسم المبادرة الذاتية موجود`);
    }
    ok('1) قسم «المبادرة الذاتية» في كل نسخ برومبت النظام');

    // ── 2) المثال الحرفي: «ما رأيك باللعبة السابقة؟» → قراءة القناة بنفسه ──
    assert.ok(adminPrompt.includes('ما رأيك باللعبة السابقة؟'), 'مثال بلاغ المالك الحرفي في البرومبت');
    assert.ok(adminPrompt.includes('get_messages'), 'الأداة المذكورة للمثال موجودة');
    assert.ok(memberPrompt.includes('ممنوع أن تقول «لا أعرف» وأنت تملك حواس'), 'عضو: قاعدة المبادرة قبل أي «لا أعرف»');
    assert.ok(chatPrompt.includes('لا تنتظر أن يطلب منك المستخدم'), 'محادثة: المبادرة قاعدة');
    ok('2) «سُئلت عن شيء لا تعرفه؟ اقرأ بنفسك» — موثق حرفياً');

    // ── 3) القراءة عبر السيرفرات موثقة — لا حصر بالسيرفر الحالي ──
    assert.ok(adminPrompt.includes('target_guild'), 'target_guild موثق للأدوات');
    assert.ok(ownerPrompt.includes('أي قناة في أي سيرفر أنت عضو فيه'), 'owner: أي قناة في أي سيرفر');
    assert.ok(ownerPrompt.includes('تُبحث في بقية سيرفراتك تلقائياً'), 'owner: البحث التلقائي في كل سيرفرات العميل موثق');
    ok('3) أدوات القراءة تعبر السيرفرات — «لماذا السيرفر الحالي فقط؟» انتهت');

    // ── 4) admin: قراءة عابرة للسيرفرات — تنفيذ محلي ──
    assert.ok(adminPrompt.includes('أدوات القراءة تعمل عبر كل السيرفرات'), 'admin: القراءة عبر السيرفرات مسموحة موثقة');
    assert.ok(adminPrompt.includes('ممنوع clone_server'), 'admin: التنفيذ الثقيل يبقى محصوراً');
    ok('4) admin: قراءة عابرة + تنفيذ محلي — التوازن صحيح');

    console.log(`\n🤳 agent_autonomy: ${passed}/4 اختبارات ناجحة`);
}

try {
    run();
    process.exit(0);
} catch (e) {
    console.error('❌ agent_autonomy فشل:', e.message);
    process.exit(1);
}
