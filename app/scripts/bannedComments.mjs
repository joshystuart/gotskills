const exemptPrefixes = ['@ts-', 'eslint-', 'prettier-ignore']
const charsBeforeRegex = '(,=:[!&|?{};+-*%~^'
const keywordsBeforeRegex = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'void',
  'delete',
  'throw',
  'new',
  'else',
  'do',
  'yield',
  'await',
])
const wordChar = /[\w$]/

function isExempt(text) {
  const trimmed = text.trim()
  return exemptPrefixes.some((prefix) => trimmed.startsWith(prefix))
}

function previousWord(source, end) {
  let start = end
  while (start > 0 && wordChar.test(source[start - 1])) start--
  return source.slice(start, end)
}

function startsRegex(source, index) {
  let before = index - 1
  while (before >= 0 && /\s/.test(source[before])) before--
  if (before < 0) return true
  if (charsBeforeRegex.includes(source[before])) return true
  return keywordsBeforeRegex.has(previousWord(source, before + 1))
}

function skipQuoted(source, index, quote) {
  let i = index + 1
  while (i < source.length && source[i] !== quote && source[i] !== '\n') {
    i += source[i] === '\\' ? 2 : 1
  }
  return i + 1
}

function skipRegex(source, index) {
  let i = index + 1
  let inClass = false
  while (i < source.length && source[i] !== '\n') {
    const char = source[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) return i + 1
    i++
  }
  return i
}

export function bannedCommentLines(source) {
  const lines = []
  const templateBraceDepths = []
  let braceDepth = 0
  let line = 1
  let i = 0

  const advanceTo = (end) => {
    for (; i < end && i < source.length; i++) if (source[i] === '\n') line++
  }

  const skipTemplateFrom = (start) => {
    i = start
    while (i < source.length) {
      const char = source[i]
      if (char === '\\') {
        advanceTo(i + 2)
      } else if (char === '`') {
        i++
        return
      } else if (char === '$' && source[i + 1] === '{') {
        templateBraceDepths.push(braceDepth)
        braceDepth++
        i += 2
        return
      } else {
        advanceTo(i + 1)
      }
    }
  }

  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      if (source[i + 2] !== '/' && !isExempt(source.slice(i + 2, stop))) lines.push(line)
      i = stop
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      const body = source.slice(i + 2, stop - 2)
      const isJsDoc = body.startsWith('*') && body !== '*'
      if (!isJsDoc && !isExempt(body)) lines.push(line)
      advanceTo(stop)
    } else if ((char === "'" || char === '"') && !wordChar.test(source[i - 1] ?? '')) {
      i = skipQuoted(source, i, char)
    } else if (char === '`') {
      skipTemplateFrom(i + 1)
    } else if (char === '/' && startsRegex(source, i)) {
      i = skipRegex(source, i)
    } else if (char === '{') {
      braceDepth++
      i++
    } else if (char === '}') {
      braceDepth--
      if (templateBraceDepths.at(-1) === braceDepth) {
        templateBraceDepths.pop()
        skipTemplateFrom(i + 1)
      } else {
        i++
      }
    } else {
      advanceTo(i + 1)
    }
  }

  return lines
}

export function bannedRustCommentLines(source) {
  const lines = []
  let line = 1
  let i = 0
  let blockDepth = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (blockDepth > 0) {
      if (char === '/' && next === '*') {
        blockDepth++
        i += 2
      } else if (char === '*' && next === '/') {
        blockDepth--
        i += 2
      } else {
        if (char === '\n') line++
        i++
      }
    } else if (char === '/' && next === '/') {
      const third = source[i + 2]
      if (third !== '/' && third !== '!') lines.push(line)
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
    } else if (char === '/' && next === '*') {
      lines.push(line)
      blockDepth = 1
      i += 2
    } else if (
      char === 'r' &&
      /^r#*"/.test(source.slice(i, i + 40)) &&
      !/\w/.test(source[i - 1] ?? '')
    ) {
      const hashes = /^r(#*)"/.exec(source.slice(i, i + 40))[1]
      const close = `"${hashes}`
      const end = source.indexOf(close, i + 2 + hashes.length)
      const stop = end === -1 ? source.length : end + close.length
      line += source.slice(i, stop).split('\n').length - 1
      i = stop
    } else if (char === '"') {
      i++
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++
        if (source[i] === '\n') line++
        i++
      }
      i++
    } else if (
      char === "'" &&
      (source[i + 2] === "'" || (source[i + 1] === '\\' && source.indexOf("'", i + 2) - i < 12))
    ) {
      i = source.indexOf("'", source[i + 1] === '\\' ? i + 3 : i + 2) + 1
    } else {
      if (char === '\n') line++
      i++
    }
  }
  return lines
}
