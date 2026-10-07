import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { bannedCommentLines } from './bannedComments.mjs'

const slash = '/'
const lineComment = `${slash}${slash}`
const blockOpen = `${slash}*`
const blockClose = `*${slash}`

describe('bannedCommentLines', () => {
  it.each([
    ['a whole-line comment', `const a = 1\n${lineComment} note\nconst b = 2`, [2]],
    ['a trailing comment', `const a = 1 ${lineComment} note`, [1]],
    ['a block comment', `const a = ${blockOpen} note ${blockClose} 1`, [1]],
    [
      'a JSX block comment',
      `const el = (\n  <div>\n    {${blockOpen} note ${blockClose}}\n  </div>\n)`,
      [3],
    ],
    [
      'a multi-line block comment',
      `const a = 1\n${blockOpen}\n note\n${blockClose}\nconst b = 2`,
      [2],
    ],
    ['a comment after a regex', `const r = /a\\/b/g ${lineComment} note`, [1]],
  ])('flags %s', (_name, source, expected) => {
    expect(bannedCommentLines(source)).toEqual(expected)
  })

  it.each([
    ['JSDoc', `${blockOpen}* Docs ${blockClose}\nexport const a = 1`],
    ['a single-quoted string', `const a = '${lineComment} ${blockOpen}'`],
    ['a double-quoted string', `const a = "${lineComment} ${blockOpen}"`],
    ['a template literal', `const a = \`${lineComment} \${b + '${lineComment}'} ${blockOpen}\``],
    ['a URL', `const a = 'https:${lineComment}example.com'`],
    ['a regex with slashes', `const r = /https:\\/\\/x/\nconst s = /a[${lineComment}]/`],
    ['a regex with a block opener', `const r = (/a${blockOpen}/).test(x)`],
    ['a ts directive', `${lineComment} @ts-expect-error\nconst a: number = ''`],
    ['an eslint directive', `${blockOpen} eslint-disable ${blockClose}`],
    ['a prettier-ignore directive', `${lineComment} prettier-ignore\nconst a = 1`],
    ['a triple-slash directive', `${lineComment}${slash} <reference types="vite/client" />`],
    ['division', 'const a = b / c / d'],
    ['an apostrophe in JSX text', `const el = <p>Don't stop</p>\nconst x = 1`],
  ])('does not flag %s', (_name, source) => {
    expect(bannedCommentLines(source)).toEqual([])
  })
})

describe('app source', () => {
  it('has no banned comments', () => {
    const appRoot = path.resolve(__dirname, '..')
    const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs'], {
      cwd: appRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    const violations = files.flatMap((file) =>
      bannedCommentLines(readFileSync(path.join(appRoot, file), 'utf8')).map(
        (line) => `${file}:${line}`
      )
    )

    expect(violations).toEqual([])
  })
})
