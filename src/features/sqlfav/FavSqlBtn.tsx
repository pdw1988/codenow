/**
 * 生成结果「收藏」：把当前 SQL 存进我的SQL库。
 * 同内容去重、自动起名在 saveSqlFavorite。
 */
import { useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { useFavoriteStore } from '../../store/useFavoriteStore'
import { Btn } from '../../components/ui'

const HOLD_MS = 1300

export function FavSqlBtn({ sql }: { sql: string }) {
  const { message } = App.useApp()
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const flash = (next: 'ok' | 'fail') => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), HOLD_MS)
  }

  const save = async () => {
    if (!sql) return
    try {
      await useFavoriteStore.getState().addSql(sql)
      flash('ok')
    } catch (e) {
      flash('fail')
      message.error(`收藏失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <Btn
      variant="mini"
      title="收藏到我的SQL库"
      disabled={!sql}
      on={state === 'ok'}
      onClick={() => void save()}
    >
      {state === 'ok' ? '✓ 已收藏' : state === 'fail' ? '✗ 收藏失败' : '收藏'}
    </Btn>
  )
}
