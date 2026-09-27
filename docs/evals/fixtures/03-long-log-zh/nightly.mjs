// 夜间构建的回放：按固定种子重建昨晚那次构建的完整日志，每次运行输出都一样。
// 用法：node nightly.mjs

function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = prng(20260927)
const pick = (list) => list[Math.floor(rand() * list.length)]
const between = (low, high) => low + Math.floor(rand() * (high - low + 1))

const MODULES = [
  '订单服务',
  '库存服务',
  '支付网关',
  '用户中心',
  '消息推送',
  '报表导出',
  '对账服务',
  '搜索索引',
]
const FAILING = '对账服务'
const CASES = [
  '创建订单时校验库存',
  '取消订单后释放占用',
  '并发扣减不超卖',
  '按渠道汇总金额',
  '退款金额不超过实付',
  '推送失败后按错误码重试',
  '分页查询保持稳定排序',
  '导出文件名带日期',
  '空结果返回空列表',
  '时区换算按东八区',
  '重复请求幂等',
  '缓存失效后回源',
  '字段缺失时给默认值',
  '错误信息不泄露内部路径',
  '大批量写入分批提交',
  '权限不足时拒绝访问',
]
const DEPRECATIONS = ['queryStockV1', 'legacyPay', 'oldTokenCheck', 'exportCsvSync', 'pushV2']

const started = Date.UTC(2026, 8, 26, 18, 14, 5, 312)
let clock = started
const lines = []
let warnings = 0

const pad = (n, w = 2) => String(n).padStart(w, '0')

function stamp() {
  clock += between(400, 6000)
  const t = new Date(clock + 8 * 3600 * 1000)
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.` +
    pad(t.getUTCMilliseconds(), 3)
  )
}
const info = (text) => lines.push(`${stamp()} [信息] ${text}`)
function warn(text) {
  warnings += 1
  lines.push(`${stamp()} [警告] ${text}（告警码 W-${between(1000, 9999)}）`)
}

info('夜间构建开始：分支 main，提交 4f9c2a1，构建机 build-07')
for (const module of MODULES) {
  info(`${module} › 拉取依赖：共 ${between(80, 240)} 个包，命中缓存 ${between(60, 99)}%`)
  info(`${module} › 编译：${between(120, 480)} 个源文件，耗时 ${between(8, 60)} 秒`)
  if (rand() < 0.6) {
    const count = between(1, 6)
    warn(`${module} › 编译：弃用的接口 ${pick(DEPRECATIONS)} 仍被 ${count} 处调用`)
  }
  info(`${module} › 静态检查：通过，${between(0, 3)} 条提示已忽略`)
  const total = between(70, 84)
  const failAt = module === FAILING ? between(Math.floor(total * 0.4), Math.floor(total * 0.6)) : 0
  for (let n = 1; n <= total; n += 1) {
    if (n === failAt) {
      lines.push(
        `${stamp()} [错误] ${module} › 单元测试：用例 ${n}/${total}「按渠道汇总金额」失败，` +
          `汇总金额与流水不一致，差额 0.${between(10, 99)} 元（错误码 E-${between(1000, 9999)}）`,
      )
      continue
    }
    info(`${module} › 单元测试：用例 ${n}/${total}「${pick(CASES)}」通过（${between(2, 90)} 毫秒）`)
    if (rand() < 0.012) warn(`${module} › 单元测试：用例 ${n} 耗时超过 500 毫秒的阈值`)
  }
  if (module === FAILING) {
    info(`${module} › 集成测试：已跳过（单元测试未通过）`)
    info(`${module} › 打包：已跳过（单元测试未通过）`)
    continue
  }
  info(`${module} › 集成测试：${between(12, 40)} 个场景全部通过`)
  info(`${module} › 打包：产物 ${between(4, 90)}.${between(0, 9)} MB`)
  info(`${module} › 上传制品：完成`)
}
const elapsed = Math.round((clock - started) / 1000)
info(
  `构建结束：${MODULES.length - 1} 个模块成功，1 个模块失败；共 1 个错误、${warnings} 个警告，` +
    `耗时 ${Math.floor(elapsed / 60)} 分 ${String(elapsed % 60).padStart(2, '0')} 秒`,
)
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = 1
