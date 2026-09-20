/**
 * Regression tests for looksLikeBuiltinPrompt() in src/host.js.
 *
 * Run: node tests/builtin-prompt-detect.test.mjs
 *
 * Why this matters: a settings page left open across a plugin upgrade submits the
 * EARLIER built-in instruction when the user clicks save. If that text is stored
 * as a custom override, the user is silently pinned to the old instruction and
 * every new rule is lost. These cases pin down what must and must not be treated
 * as a built-in instruction.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(repoRoot, 'src', 'host.js'), 'utf8').replace(/\r\n/g, '\n')

/** Pull an array-literal template's text, exactly as the module builds it. */
function template(name) {
  const a = src.indexOf(`const ${name} = [`)
  if (a < 0) throw new Error(`${name} not found`)
  const b = src.indexOf("].join('\\n')", a)
  if (b < 0) throw new Error(`${name} end not found`)
  return src.slice(a, b).split('\n').slice(1)
    .map((l) => l.trim().replace(/^'/, '').replace(/',?$/, ''))
    .map((l) => l.replace(/\\'/g, "'"))
    .filter(Boolean).join('\n')
}

/** Pull a function declaration out of the source by name. */
function fn(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`end of ${name} not found`)
  return src.slice(start, end + 3)
}

const ZH = template('SYSTEM_PROMPT_ZH')
const EN = template('SYSTEM_PROMPT_EN')
// The extracted functions reference the module-level constants by name, so the
// sandbox must define them; JSON.stringify keeps the exact characters.
const sandbox = new Function(
  `const SYSTEM_PROMPT_ZH = ${JSON.stringify(ZH)};\n`
  + `const SYSTEM_PROMPT_EN = ${JSON.stringify(EN)};\n`
  + `${fn('promptFingerprint')}\n${fn('isBuiltinPrompt')}\n${fn('looksLikeBuiltinPrompt')}\n`
  + `return { looksLikeBuiltinPrompt, isBuiltinPrompt };`,
)()

const { looksLikeBuiltinPrompt, isBuiltinPrompt } = sandbox

// The rule clause that v0.12.3 added to rule 6; removing it reconstructs the
// previous shipped built-in closely enough to model a stale editor.
const ZH_V0123_CLAUSE = '\uff1b\u6bcf\u4e2a\u5360\u4f4d\u7b26\u53ea\u6807\u4e00\u4ef6\u5177\u4f53\u7684\u4e8b\uff0c\u4e0d\u5f97\u628a\u65e0\u5173\u7684\u8981\u6c42\u62fc\u5728\u4e00\u8d77\uff1b'
const ZH_V0123_CLAUSE2 = '\u4e5f\u4e0d\u8981\u4e3a\u4e86\u201c\u5b8c\u6574\u201d\u800c\u9010\u6761\u679a\u4e3e\u5404\u79cd\u53ef\u80fd\u60c5\u51b5\uff08\u5982\u201c\u662f\u5426\u9700\u8981\u6ce8\u91ca\u3001\u662f\u5426\u9700\u8981\u8bf4\u660e\u590d\u6742\u5ea6\u201d\uff09\uff0c\u53ea\u6807\u771f\u6b63\u5f71\u54cd\u7ed3\u679c\u7684\u5173\u952e\u4fe1\u606f\uff1b\n'
const EARLIER_ZH = ZH.replace(ZH_V0123_CLAUSE, '\uff1b').replace(ZH_V0123_CLAUSE2, '').replace(/\n{2,}/g, '\n')

let passed = 0
let failed = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (ok) { passed++; console.log(`  PASS  ${label}`); return }
  failed++
  console.log(`  FAIL  ${label} (expected ${expected}, got ${actual})`)
}

console.log(`current ZH: ${ZH.length} chars; reconstructed earlier ZH: ${EARLIER_ZH.length} chars`)
console.log('')

check('current ZH built-in is recognised', looksLikeBuiltinPrompt(ZH), true)
check('current EN built-in is recognised', looksLikeBuiltinPrompt(EN), true)
check('earlier ZH built-in is recognised', looksLikeBuiltinPrompt(EARLIER_ZH), true)
check('CRLF variant of the built-in is recognised', looksLikeBuiltinPrompt(ZH.replace(/\n/g, '\r\n')), true)
check('trailing-newline variant is recognised', looksLikeBuiltinPrompt(ZH + '\n'), true)

console.log('')
check('genuinely custom instruction is NOT a built-in', looksLikeBuiltinPrompt('\u4f60\u662f\u4e00\u4f4d\u63d0\u793a\u8bcd\u4e13\u5bb6\u3002\u8bf7\u628a\u7528\u6237\u7684\u8349\u7a3f\u6539\u5f97\u66f4\u6e05\u6670\u3002'), false)
check('empty string is NOT a built-in', looksLikeBuiltinPrompt(''), false)
check('whitespace only is NOT a built-in', looksLikeBuiltinPrompt('   \n  '), false)
check('random text is NOT a built-in', looksLikeBuiltinPrompt('hello'), false)

// A user prompt that keeps the role sentence but drops the rule structure must
// stay custom - that is a real edit, not a stale built-in.
const keepsRoleOnly = ZH.split('\n').filter((l) => l.startsWith('1)') || l.includes('\u63d0\u793a\u8bcd\u5de5\u7a0b\u5e08')).join('\n')
check('role sentence without full structure stays custom', looksLikeBuiltinPrompt(keepsRoleOnly), false)

// A user prompt that adds a rule (11 numbered lines) is an edit, but it still
// carries the full built-in structure; document the chosen behaviour explicitly.
const withExtraRule = ZH + '\n9) \u672c\u5730\u6dfb\u52a0\u7684\u89c4\u5219\uff1b'
check('built-in plus an added rule is still treated as built-in-shaped', looksLikeBuiltinPrompt(withExtraRule), true)

console.log('')
check('isBuiltinPrompt is exact-match only for the current revision', isBuiltinPrompt(EARLIER_ZH), false)
check('isBuiltinPrompt accepts the current ZH', isBuiltinPrompt(ZH), true)

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
