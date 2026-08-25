# 港航工作台

根据提单号、柜号查询船司官网数据，整理到港时间、卸船时间、船只状态和完整运输线路，并保存到 Excel。

## 主要功能

- 支持 15 家船司的提单号、柜号识别与查询
- 官方公开接口优先，失败时可使用 Chrome 网页模拟查询
- 提取 ATA、ETA、实际卸船时间、货柜事件和完整线路
- 展示线路图、查询记录和采集证据
- Excel 导入、导出、备份、恢复与删除
- 单条更新、选中更新、批量更新和人工补录
- 自定义自动化任务及运行记录
- 登录、管理员/普通用户权限和独立用户工作区；同一账号采用单设备登录
- 多账号抓取进入全局队列，避免自动化浏览器并发冲突
- PostgreSQL 数据存储（可选，不配置时使用本地文件）
- 企业微信任务汇总通知（可选）

达飞和赫伯罗特采用“普通 Chrome/Edge + 浏览器扩展采集”。工作台不会为这两家启动自动化 Chrome：用户在普通浏览器完成官网验证和查询后，由扩展把当前结果页和截图交给对应解析器。

## 本地配置

### 1. 安装环境

需要安装：

- Git
- Node.js 20 或更高版本，推荐 Node.js 22 LTS
- Google Chrome
- PostgreSQL 16（可选）

macOS 可以使用 Homebrew：

```bash
brew install git node@22
brew install --cask google-chrome
```

### 2. 下载项目

```bash
git clone https://github.com/yelvnanxian/Port-and-Shipping-Workbench.git
cd Port-and-Shipping-Workbench
npm ci
npm run setup
```

`npm run setup` 只会在没有 `.env` 时创建配置文件，并自动生成一组随机管理员密码；已有 `.env` 不会被覆盖。

终端会显示一次管理员密码，请立即保存。`.env`、`data/`、真实订单 Excel、浏览器 Cookie 和验证 Profile 都只保存在本机，不要复制到其他电脑或提交到 GitHub。

### 3. 检查本地环境

```bash
npm run preflight
```

检查失败时先按终端提示修复，不要直接启动服务。

### 4. 修改配置文件

至少确认管理员账号和密码：

```dotenv
PORT=8787
APP_HOST=127.0.0.1
AUTH_ENABLED=true
AUTH_ADMIN_USERNAME=admin
AUTH_ADMIN_PASSWORD=请替换为至少16位的随机强密码
```

需要打开 Chrome 完成人工验证时，增加或修改：

```dotenv
BROWSER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
BROWSER_HEADLESS=false
BROWSER_HUMAN_VERIFY=true
BROWSER_HUMAN_VERIFY_TIMEOUT_MS=180000
```

以星、东方海外和万海的验证会保存在本机 `data/browser-profile/` 中，不会提交到 GitHub，也不要在不同电脑之间复制。新电脑首次查询时请使用有界面浏览器完成验证，之后继续使用同一个本地 Profile。

Windows 的 Chrome 路径通常为：

```dotenv
BROWSER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

达飞、赫伯罗特不使用上面的自动化浏览器配置。首次使用时打开 `chrome://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择项目中的 `browser-extension` 目录。之后在单号详情点击“普通浏览器采集”，按页面提示操作即可。

如需 PostgreSQL，可安装并创建数据库：

```bash
brew install postgresql@16
brew services start postgresql@16
createuser port_ops
createdb -O port_ops port_ops
```

然后在 `.env` 中配置：

```dotenv
DATABASE_URL=postgresql://port_ops@127.0.0.1:5432/port_ops
DATABASE_SSL=false
```

不配置 `DATABASE_URL` 时，项目会继续使用本地文件保存数据。

单机单用户可以不安装 PostgreSQL；需要多实例或集中式数据存储时再配置 PostgreSQL。

真实订单 Excel、浏览器 Profile、截图证据、账号和运行记录都属于本机运行数据，不要提交到 GitHub。仓库只保留脱敏模板；首次使用请在工作台中导入自己的 `.xlsx` 文件。

通过 Cloudflare Tunnel 开放访问时，服务仍应只监听本机，并信任本机反向代理传入的真实客户端地址：

```dotenv
APP_HOST=127.0.0.1
APP_TRUST_PROXY=true
```

不要在直接暴露端口到公网时开启 `APP_TRUST_PROXY`，否则攻击者可能伪造来源地址绕过按 IP 的登录限流。

## 启动项目

生产方式启动：

```bash
npm ci
npm run preflight
npm test
npm run build
npm start
```

浏览器打开：

```text
http://127.0.0.1:8787
```

首次使用时，登录管理员账号后请先下载模板或上传自己的 `.xlsx` 文件，再选择一条真实记录测试。仓库不包含业务订单数据，Excel 表头应保持：

```text
船司｜到港时间｜提单号｜柜号｜卸船时间｜船只状态｜最后更新时间｜备注｜进度
```

开发模式启动前后端：

```bash
npm run dev
```

前端和后端也可以分别启动：

```bash
npm run dev:web
npm run dev:api
```

拉取新版代码后重新启动：

```bash
git pull
npm ci
npm run preflight
npm run build
npm start
```

## 新电脑完整配置流程

macOS/Linux：

```bash
git clone https://github.com/yelvnanxian/Port-and-Shipping-Workbench.git
cd Port-and-Shipping-Workbench
npm ci
npm run setup
npm run preflight
npm run dev
```

Windows PowerShell 使用相同的 Git、Node.js 和 npm 命令即可。生产模式启动前执行：

```bash
npm run preflight
npm test
npm run build
npm start
```

开发模式访问 `http://127.0.0.1:5173`，生产模式访问 `http://127.0.0.1:8787`。

## 首次人工验证

以星、东方海外和万海首次遇到安全验证时，在 `.env` 中设置：

```dotenv
BROWSER_HEADLESS=false
BROWSER_HUMAN_VERIFY=true
BROWSER_HUMAN_VERIFY_TIMEOUT_MS=180000
```

重启服务后，在打开的浏览器窗口中完成验证。验证状态会保存在本机 `data/browser-profile/`，后续查询会复用同一会话。不同电脑必须分别验证，不要共享 Profile 或 Cookie。

达飞和赫伯罗特使用普通 Chrome/Edge 加扩展采集：打开 `chrome://extensions`，开启“开发者模式”，选择项目中的 `browser-extension` 目录加载，然后在单号详情中点击“普通浏览器采集”。

## 多用户和运行数据

管理员登录后可在系统设置中创建普通账号。普通用户使用独立工作区；不要让多个用户共享同一个 `data` 目录，也不要提交 `.env`、`data/`、真实订单 Excel、备份、截图证据、账号文件或浏览器 Profile。

系统不包含固定的 09:00、11:00、17:30 后台任务。需要定时更新时，请登录工作台，在“自动化任务”中自行创建任务并设置执行时间。
