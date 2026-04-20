# Lighthouse Monitor

监控 [Lighthouse (lhdao)](https://app.lhdao.top/campaigns) 平台新任务，自动占位、自动完成 Twitter 操作并验证，推送结果到企业微信。

## 功能

- 轮询 Lighthouse 平台的推文任务和互动任务
- 推文任务：自动抢位，不受奖励阈值限制
- 互动任务：实际到手奖励 >= 阈值时自动占位
- **Twitter 自动化**：点赞、转推、关注任务自动完成
- **自动验证**：纯自动任务完成后自动调用验证接口
- 评论/发推文任务：只占位，通知手动完成
- 占位成功推送企业微信，附带任务链接和执行结果
- 已通知任务自动去重，不会重复推送
- Token 过期前 24 小时自动推送提醒
- `MIN_REWARD_LUX` 和 `AUTO_GRAB` 改 `.env` 即时生效，无需重启

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 复制配置文件

```bash
cp .env.example .env
```

3. 编辑 `.env`，填入所有必要配置（见下方配置项）

4. 运行

```bash
node monitor.js
```

> 需要 Node.js 18+（使用了全局 fetch）

## 服务器部署

```bash
# 后台运行
nohup node ~/lighthouse-monitor/monitor.js > ~/lighthouse-monitor/monitor.log 2>&1 &

# 查看日志
tail -f ~/lighthouse-monitor/monitor.log

# 停止
kill $(pgrep -f monitor.js)
```

换 Token 或改阈值时直接编辑服务器上的 `.env`，下次轮询自动生效，不用重启。

## 配置项

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LH_GRAPHQL_URL` | Lighthouse GraphQL API | `https://service.lhdao.top/graphql` |
| `LH_ACCESS_TOKEN` | 登录 JWT token | - |
| `LH_OPEN_API_KEY` | Lighthouse Open API Key | - |
| `WECHAT_WEBHOOK_URL` | 企业微信机器人 webhook | - |
| `POLL_INTERVAL_MS` | 轮询间隔（毫秒） | `30000` |
| `AUTO_GRAB` | 是否自动占位 | `true` |
| `MIN_REWARD_LUX` | 互动任务最低奖励阈值（LUX） | `0.5` |
| `TWITTER_API_KEY` | Twitter API Key (Consumer Key) | - |
| `TWITTER_API_SECRET` | Twitter API Secret | - |
| `TWITTER_ACCESS_TOKEN` | Twitter Access Token | - |
| `TWITTER_ACCESS_SECRET` | Twitter Access Token Secret | - |
| `HTTPS_PROXY` | 代理地址（国内服务器访问 Twitter 需要） | - |

## 自动化流程

```
发现新任务 → 自动占位 → 判断 actions 类型
  ├─ LIKE/RETWEET/FOLLOW → Twitter API 自动执行 → 自动验证 → 通知结果
  └─ COMMENT/TWEET → 通知手动完成 → 手动验证
```

## 获取 Access Token

1. 浏览器登录 https://app.lhdao.top
2. 按 `F12` 打开 DevTools → Application → Cookie
3. 找到 `access_token`，复制值填入 `.env`

> Token 有效期约 7 天，过期前 24 小时会自动推送提醒。

## 获取 Twitter API 凭证

1. 前往 [Twitter Developer Portal](https://developer.twitter.com)
2. 创建 App，确保权限为 Read and Write
3. 生成 API Key/Secret 和 Access Token/Secret
4. 填入 `.env` 对应字段
