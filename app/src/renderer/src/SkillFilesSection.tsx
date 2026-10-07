import { useEffect, useState, type JSX } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { RendererApi, SkillFileContent, SkillFileEntry, SkillSummary } from '../../shared/ipc'

interface SkillFilesSectionProps {
  api: RendererApi
  skill: SkillSummary
  installedOnly: boolean
  onFileOpenChange: (open: boolean) => void
}

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function depthOf(path: string): number {
  return path.split('/').length - 1
}

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')
}

function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }))
}

export function SkillFilesSection({
  api,
  skill,
  installedOnly,
  onFileOpenChange,
}: SkillFilesSectionProps): JSX.Element {
  const [files, setFiles] = useState<SkillFileEntry[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [selected, setSelected] = useState<SkillFileEntry | null>(null)
  const [content, setContent] = useState<SkillFileContent | null>(null)
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    onFileOpenChange(selected !== null)
  }, [selected, onFileOpenChange])

  useEffect(() => {
    let live = true
    setFiles(null)
    setUnavailable(false)
    setSelected(null)
    setContent(null)
    setRaw(false)
    api
      .listSkillFiles({ registryId: skill.registryId, folderName: skill.folderName })
      .then((list) => {
        if (!live) return
        if (list.unavailable === 'missing') {
          setUnavailable(true)
        } else {
          setFiles(list.files)
        }
      })
      .catch(() => {
        if (live) setUnavailable(true)
      })
    return () => {
      live = false
    }
  }, [api, skill.registryId, skill.folderName])

  useEffect(() => {
    if (selected === null) return
    let live = true
    setContent(null)
    setRaw(false)
    api
      .readSkillFile({
        registryId: skill.registryId,
        folderName: skill.folderName,
        path: selected.path,
      })
      .then((result) => {
        if (live) setContent(result)
      })
      .catch(() => {
        if (live) setContent({ path: selected.path, sizeBytes: 0, kind: 'missing' })
      })
    return () => {
      live = false
    }
  }, [api, skill.registryId, skill.folderName, selected])

  if (selected !== null) {
    return (
      <section className="skill-files" aria-label="Files">
        <div className="skill-file-viewer-header">
          <button type="button" className="skill-file-back" onClick={() => setSelected(null)}>
            Back to files
          </button>
          <span className="skill-file-path mono">{selected.path}</span>
          <span className="skill-file-size">{formatFileSize(selected.sizeBytes)}</span>
        </div>
        {content === null ? (
          <p className="skill-files-loading">Loading file…</p>
        ) : content.kind === 'missing' ? (
          <p className="skill-files-unavailable">Files unavailable</p>
        ) : content.kind === 'binary' ? (
          <p className="skill-file-not-viewable">This file is not viewable.</p>
        ) : (
          <>
            {content.truncated ? (
              <p className="skill-file-truncated" role="note">
                File truncated — this preview shows only the beginning of the file.
              </p>
            ) : null}
            {isMarkdownPath(selected.path) ? (
              <>
                <button
                  type="button"
                  className="skill-file-toggle"
                  onClick={() => setRaw((prev) => !prev)}
                >
                  {raw ? 'Rendered' : 'Raw'}
                </button>
                {raw ? (
                  <pre className="skill-file-source">{content.content}</pre>
                ) : (
                  <div
                    className="skill-file-markdown"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(content.content ?? '') }}
                  />
                )}
              </>
            ) : (
              <pre className="skill-file-source">{content.content}</pre>
            )}
          </>
        )}
      </section>
    )
  }

  return (
    <section className="skill-files" aria-label="Files">
      <h2 className="skill-files-title">Files</h2>
      {skill.stale || installedOnly ? (
        <p className="skill-files-notice" role="note">
          Files reflect the current mirror and may be newer than the catalogue entry.
        </p>
      ) : null}
      {unavailable ? (
        <p className="skill-files-unavailable">Files unavailable</p>
      ) : files === null ? (
        <p className="skill-files-loading">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="skill-files-empty">No files found.</p>
      ) : (
        <ul className="skill-files-list" role="list">
          {files.map((file) => (
            <li
              key={file.path}
              className="skill-file-row"
              style={{ paddingLeft: `${depthOf(file.path) * 1.25}rem` }}
            >
              <button type="button" className="skill-file-open" onClick={() => setSelected(file)}>
                <span className="skill-file-path mono">{file.path}</span>
                <span className="skill-file-meta">
                  {!file.viewable ? <span className="skill-file-binary">not viewable</span> : null}
                  <span className="skill-file-size">{formatFileSize(file.sizeBytes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
