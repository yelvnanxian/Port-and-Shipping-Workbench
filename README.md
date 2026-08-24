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
npm install
```

### 3. 创建配置文件

```bash
cp .env.example .env
```

至少修改管理员账号和密码：

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

通过 Cloudflare Tunnel 开放访问时，服务仍应只监听本机，并信任本机反向代理传入的真实客户端地址：

```dotenv
APP_HOST=127.0.0.1
APP_TRUST_PROXY=true
```

不要在直接暴露端口到公网时开启 `APP_TRUST_PROXY`，否则攻击者可能伪造来源地址绕过按 IP 的登录限流。

## 启动项目

生产方式启动：

```bash
npm install
npm test
npm run build
npm start
```

浏览器打开：

```text
http://127.0.0.1:8787
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
npm install
npm run build
npm start
```

系统不包含固定的 09:00、11:00、17:30 后台任务。需要定时更新时，请登录工作台，在“自动化任务”中自行创建任务并设置执行时间。
