/**
 * 码上查 · Redis：看一眼缓存、改一个值、删一个测试键。
 * 单机 / 哨兵 / 集群都支持，连接表单见 RedisConnect。
 *
 * 页面常驻（AppShell keep-alive），切走再回来连接还在。
 */
import { useState } from 'react'
import { Page } from '../../components/shell/Page'
import { RedisBench } from './RedisBench'
import { RedisConnect, type RedisSession } from './RedisConnect'

export function RedisPage() {
  const [session, setSession] = useState<RedisSession | null>(null)
  return (
    <Page tab="redis" fill>
      {session ? (
        <RedisBench session={session} onClose={() => setSession(null)} />
      ) : (
        <RedisConnect onConnected={setSession} />
      )}
    </Page>
  )
}
