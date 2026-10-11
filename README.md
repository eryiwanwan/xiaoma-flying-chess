# 小妈飞行棋

女S男M主题的双人／多人互动飞行棋，**纯单文件离线网页**：无需联网、无后端、无依赖，双击 `index.html` 即可开玩。

> ⚠️ **内容提示**：本游戏包含成人向（18+）文字内容，请确认你已成年并自愿参与后再打开。

## 玩法概览

- **自定义对局**：1–8 人，玩家名／身份／颜色均可自定义
- **动态棋盘**：格数 12–96 可调；5 种环绕布局 —— 方形、蛇形、圆形、回形针形、菱形
- **身份系统**：主导方 / 顺从方 等，决定惩罚卡由谁执行
- **可自定义内容库**：惩罚卡、道具、随机事件、身份都能增删改，改动存本机
- **通关条件**：先到终点 / 跑满圈数 / 排位赛，结局文案可自定义
- **异地对局**：通过房间号 + WebSocket 中继，两人连同一局（伪静态实时对战）
- **其他**：掷骰动画、移动光效、暂停跳过额度自定义、移动端适配

## 目录

| 文件 | 说明 |
| --- | --- |
| `index.html` | 游戏本体（单文件，含全部 HTML/CSS/JS） |
| `文案库.md` | 全部文案资产的 Markdown 快照，便于通读与改稿 |
| `文案库.json` | 同上，机器可读格式 |
| `server/` | WebSocket 实时中继 + 游戏页静态托管（Node.js），供「异地对局」与 Railway 一体化部署 |
| `server/public/` | 部署进中继的游戏页副本（改动 `index.html` 后需同步拷贝，Railway 只部署 `server/` 目录） |

## 本地运行

直接双击 `index.html` 即可。
若需测试「异地对局」，请用本地 HTTP 服务打开（`file://` 下 localStorage 受限）：

```bash
python -m http.server 8000
# 然后访问 http://localhost:8000
```

## 联机中继（Railway 部署）

「异地对局」的实时同步需要一个 WebSocket 中继（协议 `mjq-relay-v1`，只做同房间转发，
不解析、不存储玩家内容）。`server/` 目录就是一个约 100 行的 Node.js 中继，Railway 免配置部署：

1. 登录 [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → 选择本仓库
2. 服务卡片 → Settings → **Root Directory** 填 `server`（只部署中继目录）
3. 构建完成后 → Settings → Networking → **Generate Domain**，得到 `xxx.up.railway.app`
4. 同一域名双用途：浏览器打开 `https://xxx.up.railway.app/` 就是游戏页，中继地址填 `wss://xxx.up.railway.app`（探活接口：`/health`）
5. GitHub Pages 不可用时的兜底：直接用 Railway 托管的页面玩即可

之后每次 push 都会自动重新部署中继。可选环境变量（Variables 页）：

- `ALLOWED_ORIGINS`：逗号分隔的来源白名单，如 `https://你的用户名.github.io`；留空不限制
- `PORT`：Railway 自动注入，无需手动设置

本地调试中继：`cd server && npm install && npm start`（默认 `ws://localhost:8787`）；
协议自测：`npm test`。

## 在线地址

推送 `main` 分支后由 GitHub Actions 自动构建并发布到 GitHub Pages，网址形如：

```
https://<你的用户名>.github.io/<仓库名>/
```

## 修改文案

改 `index.html` 里的默认文案后，可同步更新 `文案库.md` / `文案库.json`，
也可以在游戏内「内容库」面板直接编辑（改动保存在浏览器 localStorage）。

## 许可证

仅供个人私下娱乐使用。
