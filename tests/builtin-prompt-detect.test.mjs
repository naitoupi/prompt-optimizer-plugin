/**
 * Tests for how the settings editor's "save instruction" path treats text.
 *
 * Run: node tests/builtin-prompt-detect.test.mjs
 *
 * The contract is deliberately simple:
 *
 *   - Exactly the CURRENT built-in text means "no custom override" (the label
 *     should read 内置默认版), because the user clearly did not customise it.
 *   - Everything else is saved verbatim as the user's custom instruction. The
 *     optimizer must never second-guess, rewrite, or discard what the user saved;
 *     the explicit "reset to default" button is the only way back.
 *
 * History: an earlier revision tried to recognise "stale built-in text" so a
 * settings page left open across an upgrade could not pin the old instruction.
 * The first attempt only matched the current revision (too narrow, the bug it was
 * meant to fix), the second used a structural heuristic (too loose - it discarded
 * real user edits, which is worse). Both are gone. The stale-text problem is
 * handled where it starts: the editor opens on the current built-in every time.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(repoRoot, 'src', 'host.js'), 'utf8').replace(/\r\n/g, '\n')
const TERMINATOR = "].join('\\n')"

/** Extract an array-literal template the way the module builds it. */
function template(source, name) {
  const decl = source.indexOf(`const ${name} = [`)
  if (decl < 0) throw new Error(`${name} not found`)
  const lines = source.slice(decl).split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === TERMINATOR) {
      return lines.slice(1, i)
        .map((l) => l.trim().replace(/^'/, '').replace(/',?$/, ''))
        .map((l) => l.replace(/\\'/g, "'"))
        .filter(Boolean).join('\n')
    }
  }
  throw new Error(`${name}: terminator not found`)
}

function fn(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end + 3)
}

const ZH = template(src, 'SYSTEM_PROMPT_ZH')
const EN = template(src, 'SYSTEM_PROMPT_EN')

const sandbox = new Function(
  `const SYSTEM_PROMPT_ZH = ${JSON.stringify(ZH)};\n`
  + `const SYSTEM_PROMPT_EN = ${JSON.stringify(EN)};\n`
  + `${fn('promptFingerprint')}\n${fn('isBuiltinPrompt')}\n`
  + `return { isBuiltinPrompt };`,
)()
const { isBuiltinPrompt } = sandbox

let passed = 0
let failed = 0
function check(label, actual, expected) {
  if (actual === expected) { passed++; console.log(`  PASS  ${label}`); return }
  failed++
  console.log(`  FAIL  ${label} (expected ${expected}, got ${actual})`)
}

console.log(`current ZH ${ZH.length} chars / EN ${EN.length} chars`)
console.log('')

console.log('--- the current built-in means "not custom" ---')
check('current ZH', isBuiltinPrompt(ZH), true)
check('current EN', isBuiltinPrompt(EN), true)

console.log('')
console.log('--- anything else is the user\'s instruction and must be saved as-is ---')
const USER_TEXT = [
  ['one word changed', ZH.replace('\u5b8c\u6574\u4fdd\u7559\u539f\u610f', '\u5b8c\u6574\u4fdd\u7559\u7528\u6237\u539f\u610f')],
  ['a rule strengthened', ZH.replace('\u4f7f\u7528\u4e0e\u539f\u6587\u76f8\u540c\u7684\u8bed\u8a00', '\u5fc5\u987b\u4f7f\u7528\u4e0e\u539f\u6587\u76f8\u540c\u7684\u8bed\u8a00')],
  ['a rule replaced', ZH.replace(/8\) [^\n]+/, '8) \u8f93\u51fa\u5fc5\u987b\u7b80\u77ed\u3002')],
  ['a rule appended', ZH + '\n9) \u4e0d\u8981\u4f7f\u7528\u5217\u8868\u3002'],
  ['a line prepended', '\u8bf7\u4e25\u683c\u9075\u5b88\u4ee5\u4e0b\u89c4\u5219\uff1a\n' + ZH],
  ['a rule inserted mid-list', ZH.replace('4) \u7edd\u4e0d\u6539\u53d8', '3.5) \u4fdd\u6301\u7b80\u6d01\u3002\n4) \u7edd\u4e0d\u6539\u53d8')],
  ['the built-in truncated', ZH.split('\n').slice(0, 6).join('\n')],
  ['an earlier revision (no longer special-cased)', '9) \u65e7\u7248\u5185\u7f6e\u6587\u6848\u7684\u7b2c\u4e00\u884c\u3002\n8) \u65e7\u7248\u7b2c\u4e8c\u884c\u3002'],
  ['a fully custom instruction', '\u4f60\u662f\u4e00\u4f4d\u4e25\u683c\u7684\u63d0\u793a\u8bcd\u5ba1\u6838\u5458\uff1a\u53ea\u4fdd\u7559\u53ef\u6267\u884c\u7684\u8981\u6c42\u3002'],
  ['EN with one word changed', EN.replace('Preserve all of the original meaning', 'Always preserve all of the original meaning')],
  ['whitespace-only difference', '  ' + ZH + '  '],
  ['empty string', ''],
  ['a short greeting', 'hello'],
]
for (const [label, text] of USER_TEXT) {
  check(`saved as custom: ${label}`, isBuiltinPrompt(text), false)
}

console.log('')
console.log('--- the guessing machinery must stay gone ---')
for (const banned of ['isBuiltinLikePrompt', 'LEGACY_BUILTIN_PROMPTS', 'looksLikeBuiltinPrompt', 'replacedEarlierBuiltin', 'SYSTEM_PROMPT_ZH_PREV', 'SYSTEM_PROMPT_ZH_OLD']) {
  check(`removed from host.js: ${banned}`, src.includes(banned), false)
}
const client = readFileSync(join(repoRoot, 'src', 'client.js'), 'utf8')
check('removed from client.js: replacedEarlierBuiltin', client.includes('replacedEarlierBuiltin'), false)
check('client opens the editor on the current text', client.includes('function loadPromptOnce()'), true)

console.log('')
console.log('--- the custom instruction is one slot shared by both languages ---')
// lang only selects which built-in the fallback uses; a saved override is
// language-independent, so both reads return it (verified end-to-end too).
const handler = src.slice(src.indexOf('// 优化指令：GET 读当前生效指令'), src.indexOf('// 更新生成参数'))
check('GET serves the override regardless of lang', handler.includes('promptOf(lang)'), true)
check('only the current built-in clears the override', handler.includes('if (isBuiltinPrompt(next)) {'), true)
check('the override is cleared somewhere (reset or built-in text)', handler.includes('delete state.prompt'), true)
check('reset is accepted', handler.includes('payload.reset === true'), true)

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
