/** 压测默认配置：store 初始化要用，压测本身在专业版目录 */
import type { BenchConfig } from '../types'

export const DEFAULT_BENCH_CONFIG: BenchConfig = {
  mode: 'single',
  apiIds: [],
  weights: {},
  concurrency: 10,
  durationSec: 30,
  rampupSec: 5,
  timeoutMs: 5000,
  thinkTimeMs: 0,
}
