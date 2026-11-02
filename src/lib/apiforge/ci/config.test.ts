import test from 'node:test'
import assert from 'node:assert/strict'
import { configToYml, parseApiforgeConfig, parseYamlSubset } from './config'

const PRD_YML = `
# apiforge.yml 示例（PRD 4.10.4）
project: ./my-service
base_url: http://localhost:8080   # 被测服务

database:
  driver: mysql
  host: localhost
  port: 3306
  database: test_db
  username: root
  password: \${DB_PASSWORD}  # 从环境变量读取，不进配置

login:
  path: /api/user/login
  username: admin
  password: \${ADMIN_PASSWORD}

scope:
  controllers:
    - UserController
    - OrderController
  exclude:
    - HealthController

validation:
  mode: strict
  expectations:
    user: +1
    order: +1

report:
  formats:
    - junit
    - html
  output_dir: ./apiforge-reports/
`

const ENV = { DB_PASSWORD: 'db-pass', ADMIN_PASSWORD: 'admin-pass' }

test('parseApiforgeConfig：PRD 示例整份解析，${VAR} 注入到位', () => {
  const c = parseApiforgeConfig(PRD_YML, ENV)
  assert.equal(c.project, './my-service')
  assert.equal(c.baseUrl, 'http://localhost:8080')
  assert.equal(c.database?.password, 'db-pass')
  assert.equal(c.login?.password, 'admin-pass')
  assert.deepEqual(c.scope.controllers, ['UserController', 'OrderController'])
  assert.deepEqual(c.scope.exclude, ['HealthController'])
  assert.equal(c.validation.mode, 'strict')
  assert.deepEqual(c.validation.expectations, { user: '+1', order: '+1' })
  assert.deepEqual(c.report.formats, ['junit', 'html'])
})

test('parseApiforgeConfig：license 字段透传（CI 专业版闸门），没配是空串', () => {
  const c = parseApiforgeConfig(`${PRD_YML}\nlicense: CHUJU2.abc.def\n`, ENV)
  assert.equal(c.license, 'CHUJU2.abc.def')
  assert.equal(parseApiforgeConfig(PRD_YML, ENV).license, '')
})

test('parseApiforgeConfig：缺环境变量一次性报全，密码不静默变空', () => {
  assert.throws(() => parseApiforgeConfig(PRD_YML, {}), (e: Error) => {
    assert.match(e.message, /DB_PASSWORD/)
    assert.match(e.message, /ADMIN_PASSWORD/)
    return true
  })
})

test('parseApiforgeConfig：必填校验给中文报错；缺省值兜底', () => {
  assert.throws(() => parseApiforgeConfig('project: .\n', {}), /base_url/)
  assert.throws(
    () => parseApiforgeConfig('base_url: http://x\ndatabase:\n  driver: oracle\n  host: h\n  database: d\n', {}),
    /mysql \/ postgresql/,
  )
  const minimal = parseApiforgeConfig('base_url: http://localhost:8080\n', {})
  assert.equal(minimal.database, null)
  assert.equal(minimal.login, null)
  assert.deepEqual(minimal.report.formats, ['junit', 'html', 'json'])
  assert.equal(minimal.report.output_dir, './apiforge-reports')
  assert.equal(minimal.validation.mode, 'observe')
})

test('parseYamlSubset：引号/数字/布尔/同缩进数组/尾注释都认', () => {
  const y = parseYamlSubset(
    [
      'a: "x #y"      # 真注释',
      "b: '单引号 # 不算注释'",
      'n: 3306',
      'flag: false',
      'list:',
      '- one',
      '- two',
      'map:',
      '  k: v',
    ].join('\n'),
  )
  assert.equal(y.a, 'x #y')
  assert.equal(y.b, '单引号 # 不算注释')
  assert.equal(y.n, 3306)
  assert.equal(y.flag, false)
  assert.deepEqual(y.list, ['one', 'two'])
  assert.deepEqual(y.map, { k: 'v' })
})

test('configToYml：GUI 导出可被解析器读回，密码永远是占位符', () => {
  const yml = configToYml({
    project: 'E:/work/demo',
    baseUrl: 'http://localhost:8080',
    loginApi: '/api/auth/login',
    username: 'admin',
    assertMode: 'strict',
    formats: ['junit', 'html'],
  })
  assert.doesNotMatch(yml, /password: [^$]/, '密码只能以 ${VAR} 出现')
  const c = parseApiforgeConfig(yml, { APIFORGE_LOGIN_PASSWORD: 'x' })
  assert.equal(c.project, 'E:/work/demo')
  assert.equal(c.baseUrl, 'http://localhost:8080')
  assert.equal(c.login?.path, '/api/auth/login')
  assert.equal(c.validation.mode, 'strict')
  assert.deepEqual(c.report.formats, ['junit', 'html'])
})
