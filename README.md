# 港航工作台

## 1、项目介绍

港航工作台是一个本地运行的船期数据工作台。它根据提单号或柜号访问船司公开网站，整理到港、卸船、船只状态和完整运输线路，并同步到 Excel。

当前支持 15 家船司：

海洋网联、马士基、地中海、长荣、东方海外、万海、以星、美森、阳明、森罗、达飞、中远海运、赫伯罗特、合德、韩新海运。

主要功能：

- ATA/ETA 区分：有实际到港时优先使用 ATA，否则使用 ETA；
- 区分最终目的港与中转港，提取当前港口、预计到达港口和预计到达时间；
- 识别实际卸船、后续提货/配送事件和多地点、多次卸船；
- 显示完整路线、事件详情、官网来源和采集证据；
- Excel 导入、导出、备份、恢复、删除和历史归档；
- 单条、选中、批量更新，以及人工补录和人工修改时间/状态；
- 自定义自动化任务、执行时间、任务队列和运行记录；
- 登录、Session、管理员/普通用户权限和独立工作区；
- PostgreSQL 结构化存储，业务表按 `workspace_id` 隔离；
- 可选企业微信汇总通知。

官方接口优先使用公开数据，必要时使用浏览器自动化。达飞和赫伯罗特使用普通 Chrome/Edge 加浏览器扩展采集，遇到验证码或风控时仍可能需要人工完成验证。

仓库不包含账号密码、Cookie、浏览器 Profile、截图证据或运行数据。模板文件保留了项目联调使用的示例订单号，当前版本没有演示模式；正式使用时请导入并维护自己的真实 Excel，不要把业务订单文件提交到公开仓库。

## 2、部署要求

### 软件

- macOS、Windows 或 Linux；
- Git；
- Node.js 20 或更高版本，推荐 Node.js 22 LTS；
- Google Chrome 或 Microsoft Edge；
- PostgreSQL 16，建议正式启用；多用户或多实例部署时应使用 PostgreSQL；
- 可选：pgAdmin4，用于图形化查看数据库；
- 可选：Cloudflare Tunnel，用于不开放本机端口的公网访问。

macOS 安装示例：

```bash
brew install git node@22 postgresql@16
brew install --cask google-chrome
brew services start postgresql@16
```

### 资源和网络

- 最低建议 2 核 CPU、4 GB 内存；多人使用建议 4 核、8 GB 内存；
- 本机需要能够访问各船司官网；
- 生产端口：后端 `8787`；开发前端：`5173`；PostgreSQL：`5432`；
- 浏览器自动化会占用额外内存，任务应按船司串行执行，不要同时启动多个后端实例共享同一个 Excel 目录。

## 3、操作步骤

### 3.1 下载并安装依赖

```bash
git clone https://github.com/yelvnanxian/Port-and-Shipping-Workbench.git
cd Port-and-Shipping-Workbench
npm ci
npm run setup
```

`npm run setup` 会创建本地 `.env`、生成运行目录和随机管理员密码。密码只在首次创建 `.env` 时显示，请立即保存；已有 `.env` 不会被覆盖。

### 3.2 创建 PostgreSQL 数据库

macOS Homebrew 示例：

```bash
brew services start postgresql@16
createuser port_ops
createdb -O port_ops port_ops
```

如果提示用户或数据库已存在，可以跳过对应命令。

在项目根目录 `.env` 中确认：

```dotenv
DATABASE_URL=postgresql://port_ops@127.0.0.1:5432/port_ops
DATABASE_SSL=false
DB_POOL_MAX=10
```

首次启动会自动创建表并执行迁移。旧版本数据会归入 `admin` 工作区，普通账号使用 `user-账号ID` 工作区。

### 3.3 配置登录和浏览器

至少确认以下配置：

```dotenv
PORT=8787
APP_HOST=127.0.0.1
AUTH_ENABLED=true
AUTH_ADMIN_USERNAME=admin
AUTH_ADMIN_PASSWORD=替换为至少16位随机强密码
BROWSER_HEADLESS=true
BROWSER_HUMAN_VERIFY=true
```

首次处理以星、东方海外或万海的人工验证时，改为：

```dotenv
BROWSER_HEADLESS=false
BROWSER_HUMAN_VERIFY_TIMEOUT_MS=180000
```

验证完成后继续使用同一台电脑的 `data/browser-profile/`，不要复制 Cookie 或 Profile 到其他电脑。

达飞和赫伯罗特需要安装浏览器扩展：

1. Chrome 打开 `chrome://extensions`；
2. 开启“开发者模式”；
3. 点击“加载已解压的扩展程序”；
4. 选择项目中的 `browser-extension` 目录；
5. 在记录详情中点击“普通浏览器采集”，完成官网查询后用扩展提交当前结果页。

### 3.4 导入和使用数据

1. 启动项目并登录管理员账号；
2. 在工作台上传真实 `.xlsx` 文件；
3. 检查船司、提单号和柜号是否正确；
4. 先使用单条更新验证结果，再执行选中或批量更新；
5. 在“自动化任务”中创建任务并设置执行时间；
6. 在“系统设置”中创建普通账号；
7. 需要人工修正时，在记录详情中修改到港时间、卸船时间和船只状态。

Excel 表头应保持以下顺序或至少包含这些列：

```text
船司｜到港时间｜提单号｜柜号｜卸船时间｜船只状态｜人工标记｜最后更新时间｜备注｜进度
```

旧版 Excel 如果没有“人工标记”列，首次导入时会自动补到表格末尾；下载的新模板已经包含该列。

### 3.5 使用 pgAdmin4 查看数据库

注册本地服务器时填写：

```text
Host：127.0.0.1
Port：5432
Maintenance database：port_ops
Username：port_ops
```

连接后打开 `Databases → port_ops → Schemas → public → Tables`。常用表为 `shipments`、`auth_users`、`automation_tasks`、`automation_runs` 和 `automation_settings`。

## 4、启动项目

### 4.1 生产模式

```bash
cd Port-and-Shipping-Workbench
npm run preflight
npm test
npm run build
npm start
```

浏览器打开：

```text
http://127.0.0.1:8787
```

### 4.2 开发模式

前端和后端一起启动：

```bash
npm run dev
```

分别启动：

```bash
npm run dev:web
npm run dev:api
```

开发前端地址：`http://127.0.0.1:5173`。

拉取新版代码后：

```bash
git pull
npm ci
npm run preflight
npm run build
npm start
```

### 4.3 使用 Cloudflare Tunnel 公网访问

Cloudflare Tunnel 会把公网请求转发到本机服务，不需要直接开放 `8787` 端口。

#### 临时 Tunnel（测试）

macOS 安装：

```bash
brew install cloudflared
```

Windows PowerShell 可以使用：

```powershell
winget install --id Cloudflare.cloudflared
```

先启动项目：

```bash
npm start
```

再打开第二个终端运行临时 Tunnel：

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

命令输出的 `https://xxxx.trycloudflare.com` 就是临时访问地址。临时地址每次启动可能变化，适合测试和少量临时使用。

#### 固定域名 Tunnel（长期使用）

先在 Cloudflare 账号中添加已经拥有的域名，然后在终端登录并创建 Named Tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create port-ops
cloudflared tunnel route dns port-ops work.example.com
```

`cloudflared tunnel create` 会输出 Tunnel UUID 和凭据文件路径。创建
`~/.cloudflared/config.yml`（Windows 通常为 `%USERPROFILE%\\.cloudflared\\config.yml`）：

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /Users/你的用户名/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: work.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

把 `work.example.com`、`<TUNNEL_UUID>` 和凭据文件路径替换成实际值后，启动项目并运行 Tunnel：

```bash
npm start
cloudflared tunnel run port-ops
```

固定域名场景的 `.env` 示例：

```dotenv
APP_HOST=127.0.0.1
APP_ORIGIN=https://work.example.com
APP_TRUST_PROXY=true
APP_HTTPS=true
AUTH_ENABLED=true
```

Cloudflare 只负责转发流量，项目后端和 PostgreSQL 仍运行在本机。需要后台常驻时，使用操作系统的服务管理器运行 `cloudflared tunnel run port-ops`，不要重复启动多个 Tunnel 指向同一个端口。

## 5、注意事项

### 数据真实性

- 官网返回 ETA 时，不能当作实际 ATA；
- 中转港到港/卸船不能覆盖最终目的港字段；
- 预计卸船不能写入实际卸船时间；
- 官网只确认“已卸船”但没有精确时间时，状态可以是已卸船，但不会伪造时间；
- 查询失败会清理本次自动结果，避免把旧数据误认为本次成功结果；
- 自动解析结果应通过官网来源、截图、原始页面文本和路线详情复核。

### 人工修改

- 时间没有时区时按北京时间处理；
- 未来到港时间不会提前标记为已到港；
- 未来卸船时间不会提前标记为已卸船；
- 人工修改目前只修改时间和船只状态，不修改当前港口、预计到达港口和路线详情；
- 后续重新执行自动查询时，官网结果可能覆盖人工修改；
- 人工修改和导入替换前会自动创建 Excel 备份。

### PostgreSQL 和工作区

- PostgreSQL 启用后，业务表按 `workspace_id` 隔离；
- `admin` 是管理员工作区，普通账号使用独立工作区；
- 账号、任务和船期数据不能通过前端参数互相访问；
- PostgreSQL 物理数据目录不能直接修改或删除；
- 升级前可以创建数据库备份：

```bash
./scripts/backup_postgres.sh
```

- 恢复数据库前必须确认目标数据库，恢复操作会覆盖同名表：

```bash
CONFIRM_RESTORE=YES ./scripts/restore_postgres.sh data/db-backups/port_ops_YYYYMMDD-HHMMSS.dump
```

### 公网和安全

- 不要把 `8787` 或 `5432` 直接暴露到公网；
- 公网访问必须保持 `AUTH_ENABLED=true`，并使用强管理员密码；
- 只有确认请求经过本机 Cloudflare Tunnel 或可信反向代理时，才设置 `APP_TRUST_PROXY=true`；
- `.env`、真实 Excel、`data/`、备份、截图、Cookie 和浏览器 Profile 不得提交到 GitHub；
- 同一账号在新设备登录会撤销旧 Session；多人使用时应为每个人创建独立账号；
- 系统任务会进入队列，船司查询按顺序执行，遇到验证码或官网风控时可能暂停该船司后续记录；
- 达飞、赫伯罗特的浏览器扩展默认只允许连接本机工作台地址，异地用户不能直接代替本机完成人工采集；
- Cloudflare 临时 Tunnel 地址不固定，不适合长期生产使用；长期使用请配置固定域名和 Named Tunnel。

遇到启动、数据库或接口问题，先执行：

```bash
npm run preflight
```

再查看后端终端日志，不要只依据前端的“模块数据加载失败”判断真实原因。
