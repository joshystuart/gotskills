import { useId, useState, type JSX } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { parse } from 'yaml'

type Tab = 'Document' | 'Metadata' | 'Raw'

interface SplitMarkdown {
  frontmatter: string | null
  body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Separates a leading `---` YAML frontmatter block from the markdown body. */
export function splitFrontmatter(source: string): SplitMarkdown {
  const match = FRONTMATTER.exec(source)
  if (match === null) return { frontmatter: null, body: source }
  return { frontmatter: match[1], body: source.slice(match[0].length) }
}

/** The frontmatter's top-level fields, or null when it is not a YAML mapping. */
export function frontmatterFields(frontmatter: string): [string, string][] | null {
  let data: unknown
  try {
    data = parse(frontmatter)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  return Object.entries(data).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value),
  ])
}

function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }))
}

function Metadata({ frontmatter }: { frontmatter: string }): JSX.Element {
  const fields = frontmatterFields(frontmatter)
  if (fields === null) return <pre className="skill-file-source">{frontmatter}</pre>
  return (
    <dl className="skill-file-metadata">
      {fields.map(([key, value]) => (
        <div key={key} className="skill-file-metadata-row">
          <dt className="mono">{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A markdown file as Document, Metadata (frontmatter, when present) and Raw tabs. */
export function MarkdownFileView({ source }: { source: string }): JSX.Element {
  const id = useId()
  const [tab, setTab] = useState<Tab>('Document')
  const { frontmatter, body } = splitFrontmatter(source)
  const tabs: Tab[] = frontmatter === null ? ['Document', 'Raw'] : ['Document', 'Metadata', 'Raw']
  const current = tabs.includes(tab) ? tab : 'Document'

  return (
    <>
      <div className="skill-file-tabs" role="tablist" aria-label="File view">
        {tabs.map((name) => (
          <button
            key={name}
            id={`${id}-${name}-tab`}
            type="button"
            role="tab"
            aria-selected={current === name}
            aria-controls={`${id}-panel`}
            className="skill-file-tab"
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${current}-tab`}>
        {current === 'Document' ? (
          <div
            className="skill-file-markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
          />
        ) : current === 'Metadata' && frontmatter !== null ? (
          <div className="skill-file-markdown">
            <Metadata frontmatter={frontmatter} />
          </div>
        ) : (
          <pre className="skill-file-source">{source}</pre>
        )}
      </div>
    </>
  )
}
