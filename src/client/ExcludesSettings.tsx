/**
 * Settings panel for the exclude list (`settings.render` on the Git tab):
 * a textarea, one directory name per line, saved back to the plugin's
 * `.dsh-bs-git-excludes` doc in the session cwd via the /bsgit API.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SidebarSettingsRenderProps } from 'dsh-better-sidebar/client/service'
import { api } from './api.ts'
import css from './git-view.module.css'

export function ExcludesSettings(props: SidebarSettingsRenderProps): ReactNode {
  const { service, close } = props
  const sessionId = service.getSnapshot().sessionId
  const scope = { sessionId: sessionId ?? '' }
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    api
      .excludesGet(scope)
      .then(result => {
        if (!alive) return
        setText(result.excludes.join('\n'))
        setLoading(false)
      })
      .catch(reason => {
        if (!alive) return
        setError(`读取排除列表失败：${reason instanceof Error ? reason.message : String(reason)}`)
        setLoading(false)
      })
    return () => { alive = false }
  }, [sessionId])

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await api.excludesSet(scope, text.split('\n'))
      close()
    } catch (reason) {
      setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`)
      setSaving(false)
    }
  }

  return (
    <div className={css.excludesPanel}>
      <p className={css.excludesHint}>
        每行一个要排除的目录名（如 <code>node_modules</code>）；排除后该目录子树中的 git 仓库不会被发现。保存后回到 Git 面板会自动刷新。
      </p>
      <textarea
        className={css.excludesTextarea}
        value={text}
        onChange={event => { setText(event.target.value) }}
        rows={10}
        spellCheck={false}
        placeholder={'node_modules\ndist'}
        disabled={loading}
      />
      {error !== null && <div className={css.errorLine}>{error}</div>}
      <div className={css.excludesButtons}>
        <button type="button" className={css.textButton} onClick={close} disabled={saving}>取消</button>
        <button type="button" className={css.commitButton} onClick={() => { void save() }} disabled={saving || loading}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
