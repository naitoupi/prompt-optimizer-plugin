/**
 * 会话上下文读取与拼装的离线回归测试（v0.13.0）
 * Offline regression tests for the session-context reader and payload composer.
 *
 * Run: node tests/context.test.mjs
 *
 * 被测函数经 src/host.js 的测试专用出口 `__internals` 导入，测的是**真实实现**而不是副本；
 * 用假的 sessions / sessionTitle 服务驱动，不需要 DSH 运行时，也不需要测试框架：
 * 脚本失败时以非零状态码退出。
 * (The helpers are imported from src/host.js through its documented test-only export
 * `__internals`, so these cases exercise the shipped implementation rather than a copy.
 * Fake sessions/sessionTitle services drive them — no DSH runtime and no test framework
 * is needed; the script exits non-zero on failure.)
 */
import { __internals } from '../src/host.js'

const { stripInjectedBlocks, messageText, buildContextBrief, composeUserText } = __internals

let passed = 0
let failed = 0
function check(label, actual, expected) {
  if (actual === expected) {
    passed++
    console.log(`  PASS  ${label}`)
    return
  }
  failed++
  console.log(`  FAIL  ${label}`)
  console.log(`        expected ${JSON.stringify(expected)}`)
  console.log(`        actual   ${JSON.stringify(actual)}`)
}

// ── 夹具：一条真实形状的消息流（形状取自对真实会话的实测）──
// (Fixture: a realistic message stream, shaped after a measured real session.)
const LONG = '很长的历史内容'.repeat(200) // 1400 字符，超过单条上限 900

function fixtureMessages() {
  return [
    { role: 'system', content: [{ type: 'text', text: '工作区指令（不应进入上下文）' }] },
    { role: 'user', content: [{ type: 'text', text: '第一个问题：H1 的焦点穿透' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '内部思考（不应进入上下文）' }, { type: 'text', text: '结论：descendantFocusability 有问题' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '命中 3 处（不应进入上下文）' }] }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n技能清单（不应进入上下文）\n</system-reminder>' }] },
    { role: 'assistant', content: [{ type: 'text', text: LONG }] },
    { role: 'user', content: [{ type: 'text', text: '那把这个也改一下' }] },
  ]
}

function makeCtx(options) {
  const o = options || {}
  const messages = o.messages === undefined ? fixtureMessages() : o.messages
  const session = {
    header: { cwd: 'D:\\AndroidStudioProjects\\H1', agentPreset: 'standard' },
    deriveMessages() {
      if (o.deriveThrows === true) throw new Error('derive boom')
      return messages
    },
  }
  return {
    get(name) {
      if (name === 'sessions') {
        if (o.sessionsService === false) return undefined
        return { get: (id) => (o.sessionExists === false || id !== 's1' ? undefined : session) }
      }
      if (name === 'sessionTitle') return { get: () => ({ title: o.title === undefined ? '焦点穿透排查' : o.title }) }
      return undefined
    },
  }
}

const OPTS = Object.freeze({
  useContext: true,
  contextMaxChars: 4000,
  contextMaxMessages: 12,
  contextPerMessageChars: 900,
})
const optsOf = (patch) => Object.assign({}, OPTS, patch)

console.log('injected reminder blocks')
check('a <system-reminder> block is removed whole', stripInjectedBlocks('前\n<system-reminder>\n技能清单\n</system-reminder>\n后').includes('技能清单'), false)
check('text around the reminder survives', stripInjectedBlocks('前\n<system-reminder>\n技能清单\n</system-reminder>\n后').includes('前'), true)
check('a message that is only a reminder becomes empty', stripInjectedBlocks('<system-reminder>\nA skill is ...\n</system-reminder>'), '')

console.log('message body extraction')
check(
  'only the text block is taken from a mixed assistant message',
  messageText({ role: 'assistant', content: [{ type: 'reasoning', text: '内部思考' }, { type: 'tool-call', id: 'c1', name: 'grep', arguments: '{}' }, { type: 'text', text: '结论是 A' }] }),
  '结论是 A',
)
check(
  'a tool-result message yields no prose',
  messageText({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '命中 3 处' }] }] }),
  '',
)
check('a system message is not context', messageText({ role: 'system', content: [{ type: 'text', text: 'AGENTS.md' }] }), '')
check('null / missing fields / non-array content are safe', [messageText(null), messageText(undefined), messageText({ role: 'user' }), messageText({ role: 'user', content: 'text' })].join('|'), '|||')

console.log('reading the brief')
const brief = buildContextBrief(makeCtx(), 's1', OPTS, 'zh')
check('the brief exists', brief !== null, true)
check('the earliest real user turn is kept', brief.text.includes('第一个问题：H1 的焦点穿透'), true)
check('the latest real user turn is kept', brief.text.includes('那把这个也改一下'), true)
check('assistant prose is kept', brief.text.includes('结论：descendantFocusability 有问题'), true)
check('tool results / system / reasoning never leak in', brief.text.includes('不应进入上下文'), false)
check('exactly the four prose messages are carried', brief.messages, 4)
check('nothing was dropped or clipped', [brief.available, brief.dropped, brief.truncated].join('|'), '4|0|true')
check('chronological order is preserved', brief.text.indexOf('第一个问题') < brief.text.indexOf('那把这个也改一下'), true)
check('the session topic is included', brief.text.includes('会话主题: 焦点穿透排查'), true)
check('the working directory is included', brief.text.includes('工作目录: D:\\AndroidStudioProjects\\H1'), true)
check('the agent preset is included', brief.text.includes('Agent 预设: standard'), true)
check('an over-long message is clipped and marked', brief.text.includes('（已截断）'), true)
check('the over-long message is not carried whole', brief.text.includes(LONG), false)
check('the total stays within the configured budget', brief.chars <= OPTS.contextMaxChars, true)

console.log('budget and limits')
const many = []
for (let i = 0; i < 6; i++) many.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: '第' + i + '条：' + '内容'.repeat(150) }] })
const tight = buildContextBrief(makeCtx({ messages: many }), 's1', optsOf({ contextMaxChars: 700, contextPerMessageChars: 200 }), 'zh')
check('a tight budget still returns a brief', tight !== null, true)
check('a tight budget stays within the limit', tight.chars <= 700, true)
check('older messages are dropped, not silently ignored', tight.dropped > 0, true)
check('the newest messages are the ones kept', tight.text.includes('第5条'), true)
const capped = buildContextBrief(makeCtx(), 's1', optsOf({ contextMaxMessages: 2 }), 'zh')
check('the message-count cap is honoured', capped.messages, 2)
check('the cap drops the older turns', capped.dropped, 2)

console.log('language and optional metadata')
const en = buildContextBrief(makeCtx(), 's1', OPTS, 'en')
check('english labels are used on an english UI', en.text.includes('Session topic: 焦点穿透排查'), true)
check('english role labels are used', en.text.includes('USER: '), true)
check('english truncation marker is used', en.text.includes('[truncated]'), true)
const untitled = buildContextBrief(makeCtx({ title: '' }), 's1', OPTS, 'zh')
check('a missing session title is not fatal', untitled !== null, true)
check('a missing session title omits that line', untitled.text.includes('会话主题'), false)
check('the rest of the brief survives a missing title', untitled.text.includes('工作目录'), true)

console.log('degrading to plain rewriting')
check('the master switch off yields no brief', buildContextBrief(makeCtx(), 's1', optsOf({ useContext: false }), 'zh'), null)
check('a missing session id yields no brief', buildContextBrief(makeCtx(), '', OPTS, 'zh'), null)
check('a missing sessions service yields no brief', buildContextBrief(makeCtx({ sessionsService: false }), 's1', OPTS, 'zh'), null)
check('a session that is not in memory yields no brief', buildContextBrief(makeCtx({ sessionExists: false }), 's1', OPTS, 'zh'), null)
check('a throwing deriveMessages yields no brief', buildContextBrief(makeCtx({ deriveThrows: true }), 's1', OPTS, 'zh'), null)
check('a stream with no prose at all yields no brief', buildContextBrief(makeCtx({ messages: [{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c' }] }] }), 's1', OPTS, 'zh'), null)

console.log('payload composer')
check('no brief means byte-identical legacy payload (zh)', composeUserText('帮我写个二分查找', null, 'zh'), '帮我写个二分查找')
check('no brief means byte-identical legacy payload (en)', composeUserText('write a binary search', null, 'en'), 'write a binary search')
const payload = composeUserText('那把这个也改一下', brief, 'zh')
check('the context block comes before the draft', payload.indexOf('【会话上下文】') < payload.indexOf('【草稿】'), true)
check('the context block carries the brief', payload.includes(brief.text), true)
check('the draft is last, right before the model writes', payload.trim().endsWith('那把这个也改一下'), true)
const payloadEn = composeUserText('tweak it too', en, 'en')
check('english payload markers are used', payloadEn.includes('[Conversation context]') && payloadEn.includes('[Draft]'), true)
check('the english draft is last as well', payloadEn.trim().endsWith('tweak it too'), true)

console.log('')
console.log(`context brief: ${brief.messages} messages, ${brief.chars} characters`)
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
