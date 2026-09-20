/**
 * Regression tests for tidyLayoutText() in src/host.js.
 *
 * Run: node tests/tidy-layout.test.mjs
 *
 * The function is extracted from the source and evaluated, so these cases test
 * the shipped implementation rather than a copy of it. No test framework is
 * needed; the script exits non-zero on failure.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Load tidyLayoutText out of src/host.js by slicing its function body. */
function loadTidyLayoutText() {
  // host.js mixes CRLF (older text) and LF (newer blocks); normalize first.
  const src = readFileSync(join(repoRoot, 'src', 'host.js'), 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf('function tidyLayoutText(')
  if (start < 0) throw new Error('tidyLayoutText not found in src/host.js')
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error('end of tidyLayoutText not found')
  return new Function(`${src.slice(start, end + 3)}; return tidyLayoutText;`)()
}

const tidyLayoutText = loadTidyLayoutText()
const nl = (s) => (s.match(/\n/g) || []).length

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

// The reported case: labelled sections, one blank line between each.
const sections = '\u4efb\u52a1\uff1aA\n\n\u8f93\u5165\uff1aB\n\n\u8f93\u51fa\uff1aC'
check('collapse blank lines between label lines', tidyLayoutText(sections), '\u4efb\u52a1\uff1aA\n\u8f93\u5165\uff1aB\n\u8f93\u51fa\uff1aC')

// A leading sentence, then labelled sections.
const lead = '\u539f\u53e5\u3002\n\n\u4efb\u52a1\uff1aA\n\n\u8f93\u51fa\uff1aB'
check('leading sentence keeps a single break', tidyLayoutText(lead), '\u539f\u53e5\u3002\n\u4efb\u52a1\uff1aA\n\u8f93\u51fa\uff1aB')

// Paragraph separation survives as exactly one blank line.
check('paragraph break preserved as one blank', tidyLayoutText('A\n\n\n\nB'), 'A\n\nB')

// A fenced code block is never touched, blank lines inside included.
const fenced = 'text\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nmore'
check('code fence interior preserved', tidyLayoutText(fenced), fenced)

// List items keep their surrounding blank lines.
const list = '\u524d\u8a00\n\n- item1\n- item2\n\n\u540e\u8bed'
check('list stays intact', tidyLayoutText(list), list)

// Nothing to do.
check('single paragraph untouched', tidyLayoutText('\u4e00\u6bb5\u8bdd\u3002'), '\u4e00\u6bb5\u8bdd\u3002')
check('empty string', tidyLayoutText(''), '')
check('whitespace only', tidyLayoutText('   \n\n  '), '')
check('crlf normalized', tidyLayoutText('A\r\n\r\nB'), 'A\nB')

// Whitespace-only lines count as blank lines.
check('blank run containing spaces', tidyLayoutText('A\n\n   \n\nB'), 'A\n\nB')

// The load-bearing invariant: tidying must not drop any non-blank line.
const big = `${sections}\n\n\u7ea6\u675f\uff1aD\n\n\n\u80cc\u666f\uff1aE`
const beforeLines = big.split('\n').map((l) => l.trim()).filter(Boolean)
const afterLines = tidyLayoutText(big).split('\n').map((l) => l.trim()).filter(Boolean)
check('no non-blank line lost', JSON.stringify(afterLines), JSON.stringify(beforeLines))

console.log('')
console.log(`newlines: sections ${nl(sections)} -> ${nl(tidyLayoutText(sections))}`)
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
