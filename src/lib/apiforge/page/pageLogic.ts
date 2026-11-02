/**
 * 页面算法版本：画像（ftlProfile）和写操作草稿（writeDraft）只在扫描时算，缓存里存的是结果。
 * 改了这两处的算法就把版本 +1，老缓存会提醒重扫、写操作拒跑。
 */
import type { ProjectScanResult } from '../types'

export const PAGE_LOGIC_VERSION = 3

/** 缓存里的画像 / 草稿是旧算法算的。一页画像都没有时不算（重扫也算不出来）；Vue 工程不走这套算法 */
export function pagesStale(p: ProjectScanResult): boolean {
  return !p.vue && p.pageLogic !== PAGE_LOGIC_VERSION && (p.pages ?? []).some((x) => x.profile !== null)
}
