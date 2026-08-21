# 港航工作台

用于根据 Excel 中的提单号、柜号汇总船司网站或官方 API 的船期数据，统一追踪 ATA/ETA 和卸船时间，自动回写 Excel 并发送企业微信汇总通知。

## 全新电脑部署

### 1. 环境要求

- 64 位 Windows 10/11、macOS 或 Ubuntu/Linux
- Git
- Node.js 20 或更高版本，推荐 Node.js 22 LTS
- npm 10 或更高版本
- Google Chrome 或 Microsoft Edge。项目使用 `playwright-core` 调用系统浏览器，不会自动下载浏览器
- 可访问各船司官网的网络环境
- 生产运行只需要开放 `8787` 端口；开发模式还会使用 `5173` 端口
- 生产公网共享建议通过 Cloudflare Tunnel 转发到 `127.0.0.1:8787`，不要直接开放 `8787` 到公网

建议将电脑时区设置为中国标准时间。任务本身固定按 `Asia/Shanghai` 执行，但正确的系统时间便于核对日志和备份。

### 2. 安装基础软件

macOS（先安装 [Homebrew](https://brew.sh/)）：

```bash
xcode-select --install
brew update
brew install git node
brew install --cask google-chrome
sudo systemsetup -settimezone Asia/Shanghai
```

Windows PowerShell（以管理员身份运行）：

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Google.Chrome -e
Set-TimeZone -Id "China Standard Time"
```

安装完成后关闭并重新打开 PowerShell。

Ubuntu 22.04/24.04（以下 Chrome 安装命令适用于 x86_64）：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
curl -LO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb
sudo timedatectl set-timezone Asia/Shanghai
```

确认安装结果：

```bash
git --version
node --version
npm --version
```

Node.js 应显示 `v20` 或更高版本。

### 3. 下载项目并安装依赖

macOS / Linux：

```bash
git clone https://github.com/yelvnanxian/Port-and-Shipping-Workbench.git
cd Port-and-Shipping-Workbench
npm ci
cp .env.example .env
```

Windows PowerShell：

```powershell
git clone https://github.com/yelvnanxian/Port-and-Shipping-Workbench.git
Set-Location Port-and-Shipping-Workbench
npm ci
Copy-Item .env.example .env
```

### 4. 配置 `.env`

macOS / Linux：

```bash
nano .env
```

Windows PowerShell：

```powershell
notepad .env
```

macOS 示例：

```dotenv
PORT=8787
APP_HOST=127.0.0.1
APP_ORIGIN=https://ship.example.com
APP_TRUST_PROXY=false
APP_HTTPS=false
APP_RATE_LIMIT_ENABLED=true
AUTH_ENABLED=true
AUTH_ADMIN_USERNAME=admin
AUTH_ADMIN_PASSWORD=请替换为至少16位随机密码
AUTH_USER_USERNAME=operator
AUTH_USER_PASSWORD=
WECHAT_WEBHOOK_URL=
BROWSER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
BROWSER_HEADLESS=true
BROWSER_HUMAN_VERIFY=true
BROWSER_HUMAN_VERIFY_TIMEOUT_MS=180000
HMM_BROWSER_HEADLESS=false
BROWSER_HUMAN_BEHAVIOR=true
RATE_LIMIT_REQUESTS_PER_MINUTE=10
DATABASE_URL=postgresql://port_ops:请替换密码@127.0.0.1:5432/port_ops
DATABASE_SSL=false
DB_POOL_MAX=10
```

Windows 示例：

```dotenv
PORT=8787
WECHAT_WEBHOOK_URL=
BROWSER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
BROWSER_HEADLESS=true
HMM_BROWSER_HEADLESS=false
BROWSER_HUMAN_BEHAVIOR=true
RATE_LIMIT_REQUESTS_PER_MINUTE=10
```

Ubuntu 示例：

```dotenv
PORT=8787
WECHAT_WEBHOOK_URL=
BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
BROWSER_HEADLESS=true
HMM_BROWSER_HEADLESS=false
BROWSER_HUMAN_BEHAVIOR=true
RATE_LIMIT_REQUESTS_PER_MINUTE=10
```

- `WECHAT_WEBHOOK_URL` 可以暂时留空，启动后在"系统设置"中保存和测试企业微信机器人地址。
- 如果 Chrome 安装在其他位置，请将 `BROWSER_EXECUTABLE_PATH` 改成实际可执行文件路径。
- `BROWSER_HEADLESS=false` 可切换为有头模式，反检测效果更好但需要图形界面；服务器环境保持 `true`。
- `BROWSER_HUMAN_VERIFY=true` 允许万海、以星、赫伯罗特、达飞、东方海外遇到官网人机验证时暂停等待人工操作；必须同时设置 `BROWSER_HEADLESS=false`，系统会打开 Chrome 窗口并在验证通过后继续解析。
- 如果验证页出现，直接在打开的 Chrome 窗口按官网提示完成验证，不要关闭窗口；控制台会显示“人工验证已通过”后继续写入 Excel。等待时间由 `BROWSER_HUMAN_VERIFY_TIMEOUT_MS` 控制，默认 180 秒。无界面模式遇到验证会明确失败并提示切换有头模式，不会写入猜测数据。
- 验证通过后的 Cookie/localStorage 会按船司保存到 `data/sources/{船司代码}/browser-state/`，后续运行只复用同一船司会话；升级时仍会兼容读取旧的 `data/browser-state/` 文件，会话失效时系统再次提示人工验证。
- 运行过程中如果浏览器再次触发人机验证，工作台会在页面内弹出当前船司、提单号和柜号；完成 Chrome 中的验证后会自动检测并继续，无法处理时可选择“跳过当前记录”，该单号会以失败原因写入运行记录，不会写入猜测时间。
- 每条成功的浏览器查询都会保存完整页面截图到按船司隔离的证据目录，并在追踪表和单号详情中提供“采集证据”入口。路线解析按船司独立规则执行，识别到的装货港、卸货港和后续交付节点会在详情页显示为线路图。
- `HMM_BROWSER_HEADLESS=false` 是韩新海运专用设置。其官网会拦截无头 Chrome，必须在已登录图形桌面的电脑上运行；定时查询时会短暂打开 Chrome 窗口。
- `BROWSER_HUMAN_BEHAVIOR=true` 启用真人行为模拟（随机延迟、逐字符打字），可降低风控触发率。
- `RATE_LIMIT_REQUESTS_PER_MINUTE=10` 控制默认每分钟请求数，风控严重的船司（万海 3 次/分钟、以星达飞 5 次/分钟）在代码中单独限流。
- 配置 `DATABASE_URL` 后，服务启动会自动创建/升级 PostgreSQL 表，并将用户、系统设置、自动化任务和运行记录写入数据库；未配置时继续使用现有本地 JSON 文件模式。订单 Excel、备份文件和浏览器截图仍保留在本地文件系统，便于导入、导出和证据查看。
- PostgreSQL 使用连接池，`DB_POOL_MAX` 默认 10；云数据库通常需要 `DATABASE_SSL=true`。数据库连接失败时服务会直接启动失败并提示原因，不会静默切回另一套数据源。
- 修改 `.env` 后必须重启服务。
- 首次启用登录后，服务会在 `data/users.json` 保存密码哈希（不会保存明文密码）；后续账号、角色、启停和密码请在“系统设置 → 账号与权限”中管理。不要把该文件提交到 Git。
- `APP_HOST=127.0.0.1` 只允许本机和 Cloudflare Tunnel 访问；如果确实需要局域网直连，再改成 `0.0.0.0` 并配合防火墙限制来源。
- `APP_ORIGIN` 是允许跨域请求的前端来源，多个来源用英文逗号分隔；不要配置为 `*`。
- `APP_TRUST_PROXY=true` 只应在确定请求只能经过可信反向代理时启用；否则客户端可能伪造转发 IP，影响限流判断。
- `APP_RATE_LIMIT_ENABLED=true` 会启用基础请求限流；它与下面的登录、Session、CSRF 和管理员权限共同生效。
- `AUTH_ENABLED=true` 开启登录 Session；必须同时设置 `AUTH_ADMIN_PASSWORD`（建议至少 16 位随机密码）。可选设置 `AUTH_USER_USERNAME` 与 `AUTH_USER_PASSWORD` 创建一个普通用户账号。
- 如果只是本机临时开发且暂不需要登录，可显式设置 `AUTH_ENABLED=false`；公网或 Tunnel 访问不要关闭。
- `.env` 中的账号只用于首次初始化 `data/users.json`；如果已经生成用户文件，后续请使用可视化账号管理，不要直接依赖修改环境变量。
- 管理员可以修改系统设置、创建/删除/执行自动化任务、删除/恢复备份、导入 Excel、删除或人工修改船期；普通用户可以查看、筛选、导出和发起同步，但不能执行上述危险操作。
- 管理员可在“系统设置 → 账号与权限”中可视化新增账号、切换管理员/普通用户、启用/停用、重置密码和删除账号；删除当前账号、停用最后一个管理员等高风险操作会被拒绝。
- Session 使用 HttpOnly、SameSite=Strict Cookie；所有写请求要求 CSRF Token。启用 HTTPS 反向代理时将 `APP_HTTPS=true`，Cookie 会自动启用 Secure 属性。
- `.env`、`data/settings.json`、浏览器 Cookie 和查询截图均为本地敏感数据，禁止提交到 Git。

### 5. 首次验证并启动

```bash
npm test
npm run build
npm start
```

### PostgreSQL（现在启用时）

macOS 可使用 Homebrew 安装：

```bash
brew install postgresql@16
brew services start postgresql@16
createdb port_ops
psql port_ops -c "CREATE USER port_ops WITH PASSWORD '请替换为强密码';"
psql postgres -c "ALTER DATABASE port_ops OWNER TO port_ops;"
psql port_ops -c "GRANT ALL ON SCHEMA public TO port_ops;"
```

然后在 `.env` 中配置：

```dotenv
DATABASE_URL=postgresql://port_ops:你的密码@127.0.0.1:5432/port_ops
DATABASE_SSL=false
```

重启 `npm start` 后，项目会自动执行表结构迁移。首次启用数据库时，会把现有 `data/users.json`、`data/settings.json`、`data/tasks.json` 和 `data/runs.json` 导入 PostgreSQL。建议确认迁移成功后再做一次数据库备份。

看到以下提示表示启动成功：

```text
Port operations API listening on http://localhost:8787
Schedules enabled: 09:00, 11:00, 17:30 Asia/Shanghai
```

浏览器访问：

- 工作台：<http://localhost:8787>
- 健康检查：<http://localhost:8787/api/health>
- 采集 API：<http://localhost:8787/api/dashboard>

macOS / Linux 也可以用命令检查：

```bash
curl http://localhost:8787/api/health
```

Windows PowerShell：

```powershell
Invoke-RestMethod http://localhost:8787/api/health
```

### 6. 局域网访问与防火墙

默认生产服务只监听本机 `127.0.0.1:8787`，同一局域网的其他电脑不能直接访问。若不使用 Cloudflare Tunnel、确实需要局域网直连，可将 `.env` 中的 `APP_HOST` 改为 `0.0.0.0`，再配合操作系统防火墙限制来源。

查看服务器 IP：

```bash
# macOS
ipconfig getifaddr en0

# Ubuntu/Linux
hostname -I
```

Windows PowerShell：

```powershell
ipconfig
New-NetFirewallRule -DisplayName "港航工作台 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

Ubuntu 启用 UFW 时：

```bash
sudo ufw allow 8787/tcp
sudo ufw status
```

不要将 `8787` 端口直接暴露到公网；如需公网使用，应增加 HTTPS、登录认证和访问控制。当前版本已加入登录 Session、角色权限、CSRF 校验、安全响应头、关闭 `X-Powered-By`、限制跨域、限制请求体大小和基础 API 限流。

### 公网共享安全基线

第一阶段安全加固已经包含：

- 默认绑定 `127.0.0.1`，适合 Cloudflare Tunnel 转发
- 仅允许 `APP_ORIGIN` 配置的前端来源跨域
- 移除 Express `X-Powered-By` 标识
- 增加 `nosniff`、禁止 iframe、Referrer-Policy、Permissions-Policy 等响应头
- 限制 JSON 请求体为 1 MB，URL 编码请求体为 100 KB
- 对全部请求和 API 请求启用基础限流，超过限制返回 HTTP 429

这只是公网发布前的边界加固；仍建议通过 Cloudflare Tunnel 或其他 HTTPS 反向代理发布，并定期更换管理员密码和 Tunnel 凭据。

### 7. 后台常驻运行

每天三次定时任务只有在服务持续运行时才会执行。macOS / Linux 推荐使用 PM2：

```bash
sudo npm install -g pm2
npm run build
pm2 start npm --name port-ops-workbench -- start
pm2 save
pm2 startup
```

`pm2 startup` 会输出一条带 `sudo` 的命令，继续复制执行该命令即可完成开机自启。

常用维护命令：

```bash
pm2 status
pm2 logs port-ops-workbench
pm2 restart port-ops-workbench
pm2 stop port-ops-workbench
```

Windows 如需开机自启，可使用 Windows“任务计划程序”创建任务：开机时在项目目录执行 `npm start`。运行账户必须对项目的 `data/` 目录有读写权限。

### 8. 开发模式

同时启动前后端：

```bash
npm run dev
```

也可以分别启动，便于单独查看日志。请打开两个终端并在项目目录中依次执行：

```bash
# 终端 1：前端
npm run dev:web

# 终端 2：后端
npm run dev:api
```

- 前端开发地址：<http://localhost:5173>
- API 地址：<http://localhost:8787>
- 开发模式仅用于修改代码；正式使用请运行 `npm run build` 和 `npm start`。
- 不要重复启动后端。如果旧进程占用 `8787` 端口，前端可能仍连接旧版 API，并出现“接口不存在”。拉取或修改代码后必须停止旧后端，再重新执行 `npm run dev:api` 或 `npm start`。

### 9. 更新项目

```bash
git pull origin main
npm ci
npm test
npm run build
pm2 restart port-ops-workbench
```

如果未使用 PM2，最后一步改为停止旧的 `npm start`，再重新执行 `npm start`。

### 10. 迁移已有数据

全新安装会自动创建 `data/` 目录。迁移旧电脑时，停止两台电脑上的服务，再复制以下文件：

- `data/current.xlsx`：当前工作簿
- `data/backups/`：历史备份
- `data/settings.json`：企业微信和自动化设置，包含敏感信息
- `data/tasks.json`：工作台中创建的自定义任务及执行顺序
- `data/browser-state/`：旧版本各船司 Cookie，可选；新版运行数据位于 `data/sources/{船司代码}/`
- `data/sources/{船司代码}/browser-state/`：该船司专用 Cookie/localStorage，禁止对外暴露
- `data/sources/{船司代码}/evidence/`：该船司浏览器查询截图证据

不要复制旧的 `data/browser-evidence/` 也能正常运行；该目录只是失败截图证据。迁移后重新执行 `npm start`，并在“系统设置”中发送一次企业微信测试。

## 使用步骤

1. 打开工作台，点击“新增单号”，每行填写“提单号 柜号 船司备注”，也可从 Excel 批量粘贴。
2. 点击“添加并立即查询”。没有现有文件时会自动创建 `data/current.xlsx`，不需要先制作表格。
3. 也可以下载 Excel 模板并批量填写后，通过“导入 Excel”接管已有记录。船司映射按提单前缀固定执行：`MAEU` 是马士基，`MEDU` 是地中海。
4. 点击“同步最新数据”可手动执行；服务保持运行时还会在每天 09:00、11:00、17:30 自动执行。
5. 点击“下载当前 Excel”取得更新后的文件。每次更新前的副本存放在 `data/backups/`。
6. 在“自动化任务”中点击“新建任务”，可选择全部未完成记录、指定船司或指定单条船期；任务支持启用/停用、单条删除和批量删除。
7. 任务列表按创建顺序保存。勾选多条任务后点击“按顺序执行”，系统会等待上一条真实查询完成并保存 Excel 后再执行下一条。
8. 在“数据源管理”中可点击“只更新此船司”，在“船期追踪”中可点击行内刷新按钮只更新一条船期；这两种操作都会生成更新前备份。
9. 如需人工修正或补录，在“运营总览”或“船期追踪”点击“人工补录”；已有记录也可以在行操作或详情抽屉点击“人工修改状态”。可填写到港时间、卸船时间、船只状态和备注，保存前会自动备份并写回 Excel。

## 真实采集与数据核验说明

- 工作台固定使用真实官网/官方接口。只有官方查询成功并解析出字段时才写入时间；验证码、风控、接口错误或格式异常都会明确写入“失败”和原因，不会伪造结果。
- 系统设置中可启用“网页模拟点击”。官方接口或直连失败后，系统使用本机 Chrome 串行打开船司页面、填写单号并读取渲染结果；无需手工操作。
- 浏览器页面必须同时显示对应提单号/柜号和明确的 ATA、ETA 或实际卸船字段才会写入。成功和失败都会尝试按船司保存页面截图至 `data/sources/{船司代码}/evidence/`；成功证据显示在追踪列表和详情页，失败证据显示在运行历史中。只有截图实际保存成功时才生成查看入口。
- 浏览器会按船司复用会话，并将 Cookie 同意状态保存到本机 `data/sources/{船司代码}/browser-state/`；中远海运会自动点击“允许全部”，后续任务不再重复弹窗。旧版本的 `data/browser-evidence/` 截图 URL 和 `data/browser-state/` Cookie 仍可兼容读取。
- 万海先按提单查询，提单失败且 Excel 有柜号时会自动改用柜号再次查询；成功结果和两次失败原因都会标明实际查询方式。
- 船期追踪列表和详情页提供“官网核验”入口，使用本次抓取保存的官方来源地址，并自动复制提单号；不支持结果直链的官网会打开官方查询页供粘贴复查。

## 已实现范围

- 多模块工作台：运营总览、船期追踪、数据源管理、自动化任务、导出与备份、系统设置
- 支持通过 URL Hash 直接打开模块，例如 `/#sources`、`/#automation`、`/#exports`
- 运营总览的 5 个统计卡片可点击进入对应记录列表，列表支持日期筛选、时间排序和结果导出
- 按提单号、箱号、船名、码头、中文船司名、船只状态与人工标记筛选
- 人工标记支持“未标记 / 已清关 / 查验中 / 其他”；已清关记录会从自动追踪范围移除
- 单条/批量选择、详情时间线、单条更新和仅更新选中记录
- 新增单号只验证并查询本次新增记录，不会触发全部记录同步
- 船期记录支持单条和批量删除，删除前自动生成 Excel 备份
- Excel 导入、表头校验、更新前自动备份及原格式回写
- 旧版 Excel 打开后会自动补充“人工标记”列，并保留原有数据
- 每日 09:00、11:00、17:30 定时执行，时区固定为 Asia/Shanghai
- 只继续查询未到港/未卸船记录，已卸船记录自动跳过
- 企业微信汇总通知，可通过系统设置或环境变量配置 Webhook；失败内容按船司和分类汇总，每组最多展示 3 个提单号
- 15 家船司前缀路由，以及是否移除前缀的规则
- 东方海外 OOCL 保留 `OOLU` 前缀、ATA/ETA 和指定柜号解析器；当前旧官方接口持续返回 `SVC_ERR_001` 且网页触发 Cloudflare，数据源状态会明确显示“官网接口异常”，不会把解析器存在误报成实时可用
- MAEU 马士基、MEDU 地中海固定映射；马士基去前缀、完整提单号、柜号三级回退；ZIM 提单号/柜号双查合并逻辑
- 森罗提单号按官网要求去除 `SMLM` 前缀，并与柜号分别查询；任一路成功即可采用，两路成功时合并结果
- 万海提单号去除前缀后与柜号并行查询；任一路成功即可采用，相比旧版串行兜底，并行查询速度更快且容错性更高
- 韩新海运使用有界面 Chrome 调用官网真实查询，并校验返回提单号和柜号；时间按官网注明保留为港口当地时间，实际到港、预计到港和实际卸船不会混写
- 浏览器反指纹优化：隐藏 webdriver 特征、User-Agent 轮换、伪装 plugins 和 chrome 对象，降低风控检测率
- 真人行为模拟：随机延迟、逐字符打字、思考时间，模拟真人操作节奏
- 按船司分别限流：风控严重的船司（万海 3 次/分钟、以星达飞 5 次/分钟）使用更严格的速率限制
- 最近 30 次运行历史、成功/失败统计和通知状态
- 失败明细会在 Excel 备注和运行历史中保留船司、提单号、柜号、失败分类、官网具体原因和数据来源；企业微信仅发送简要失败概况
- 自动备份列表与历史 `.xlsx` 文件下载
- 同步采集 API
- Playwright 浏览器备用采集、单线程查询、导航超时后继续检查和失败截图证据
- 导出带表头样式、筛选器、冻结首行及日期格式的 `.xlsx` 文件
- 响应式桌面与移动端界面

工作台固定使用官网模式，不会展示或写入虚构结果。海洋网联、森罗、长荣、合德、美森、阳明和韩新海运使用各自官方查询接口或专用页面解析器；其余船司也会真实请求对应官网并检查响应。OOCL 解析器仍保留，但官方旧接口当前持续返回 `SVC_ERR_001`，因此不会在数据源管理中标为实时可用。若官网返回 Cloudflare/验证页面、官方服务错误、动态页面或字段不完整，工作台会保留失败分类、船司、提单号、柜号、官网具体原因和来源地址，不会写入假时间。

## 真实船司接入所需信息

1. 实际使用的 Excel 样例文件，用于确认是否存在合并单元格、隐藏列、公式或特殊格式
2. 覆盖全部船司的已知测试单号及人工查询结果
3. 优先联调顺序；建议先从每日单量最高的 3–5 家船司开始

凭证应通过环境变量或密钥服务提供，禁止直接写入代码仓库。使用网页采集前，请确认网站服务条款、robots.txt 与允许的访问频率。
