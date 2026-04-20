#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ProxyAgent } = require("undici");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) process.env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
}

const GRAPHQL_URL = process.env.LH_GRAPHQL_URL;
const ACCESS_TOKEN = process.env.LH_ACCESS_TOKEN;
const WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const SEEN_FILE = path.join(__dirname, "seen_campaigns.json");

// Twitter credentials
const TW_API_KEY = process.env.TWITTER_API_KEY;
const TW_API_SECRET = process.env.TWITTER_API_SECRET;
const TW_ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const TW_ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;
const LH_OPEN_API_KEY = process.env.LH_OPEN_API_KEY;
const HTTPS_PROXY = process.env.HTTPS_PROXY;
const proxyDispatcher = HTTPS_PROXY ? new ProxyAgent(HTTPS_PROXY) : undefined;
let twitterUserId = null;

function reloadEnv() {
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) env[t.slice(0, i)] = t.slice(i + 1);
    }
  }
  return {
    autoGrab: (env.AUTO_GRAB ?? "true") !== "false",
    minReward: parseFloat(env.MIN_REWARD_LUX || "0.5"),
  };
}

// --- QUERIES ---
const Q_TWEETS = `{ availableTweets {
  id title projectName totalBudget status isSoldOut
  rewardRatios reward1st reward2nd reward3rd
  actions { actionType baseReward } createdAt
  creator { username nickname }
}}`;

const Q_ENGAGEMENTS = `{ availableEngagements {
  id title projectName totalBudget status expectedReward effectiveTier
  targetUrl tweetId targetUsername
  actions { actionType baseReward } createdAt
  creator { username nickname }
}}`;

const M_GRAB_TWEET = `mutation GrabTweetCampaign($campaignId: String!) {
  grabTweetCampaign(campaignId: $campaignId) {
    id campaignId grabStatus status
  }
}`;

const M_RESERVE_ENGAGEMENT = `mutation ReserveEngagementSlot($campaignId: String!) {
  reserveEngagementSlot(campaignId: $campaignId) {
    reserved cooldownSeconds
  }
}`;

const M_VERIFY_ENGAGEMENT = `mutation VerifyEngagement($campaignId: String!) {
  verifyEngagement(campaignId: $campaignId) {
    id campaignId userId completedActions actualReward status createdAt
  }
}`;

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}

async function gql(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

let tokenWarned = false;
function checkTokenExpiry() {
  try {
    const payload = JSON.parse(
      Buffer.from(ACCESS_TOKEN.split(".")[1], "base64").toString(),
    );
    const exp = payload.exp * 1000;
    const hoursLeft = (exp - Date.now()) / 3600000;
    if (hoursLeft <= 0) {
      console.error("❌ Token 已过期，请更换");
      sendWechat("❌ Lighthouse Token 已过期，请立即更换！");
      process.exit(1);
    }
    if (hoursLeft <= 24 && !tokenWarned) {
      tokenWarned = true;
      console.warn(`⚠️ Token 将在 ${hoursLeft.toFixed(1)} 小时后过期`);
      sendWechat(
        `⚠️ Lighthouse Token 将在 ${hoursLeft.toFixed(1)} 小时后过期，请尽快更换！`,
      );
    }
  } catch {}
}

function campaignName(c) {
  return (
    c.projectName ||
    c.title ||
    c.creator?.nickname ||
    c.creator?.username ||
    c.id
  );
}

function effectiveReward(campaign) {
  if (campaign.expectedReward > 0) return campaign.expectedReward;
  const fromActions = Math.max(
    0,
    ...(campaign.actions || []).map((a) => a.baseReward || 0),
  );
  return fromActions > 0 ? fromActions : campaign.totalBudget || 0;
}

function formatReward(campaign) {
  if (campaign.reward1st) {
    return `总预算: ${campaign.totalBudget} LUX (1st: ${campaign.reward1st}, 2nd: ${campaign.reward2nd}, 3rd: ${campaign.reward3rd})`;
  }
  const parts = (campaign.actions || []).map(
    (a) => `${a.actionType}: ${a.baseReward} LUX`,
  );
  const base = parts.join(", ") || `总预算: ${campaign.totalBudget} LUX`;
  if (campaign.expectedReward > 0)
    return `${base} (实际到手≈${campaign.expectedReward} LUX)`;
  return base;
}

async function tryGrab(campaign) {
  const isTweet = campaign._type === "tweet";
  const mutation = isTweet ? M_GRAB_TWEET : M_RESERVE_ENGAGEMENT;
  const json = await gql(mutation, { campaignId: campaign.id });

  if (json.errors)
    return { ok: false, msg: `占位失败: ${json.errors[0].message}` };
  if (isTweet) {
    const s = json.data.grabTweetCampaign.grabStatus;
    return { ok: true, msg: `占位成功 (${s})` };
  }
  const reserved = json.data.reserveEngagementSlot.reserved;
  return reserved
    ? { ok: true, msg: "占位成功" }
    : { ok: false, msg: "占位失败(已满或冷却中)" };
}

async function sendWechat(text) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  });
  const json = await res.json();
  if (json.errcode !== 0) console.error("企业微信推送失败:", json);
}

// --- Twitter API (OAuth 1.0a + v2) ---
function oauthSign(method, url, params = {}) {
  const oauthParams = {
    oauth_consumer_key: TW_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: TW_ACCESS_TOKEN,
    oauth_version: "1.0",
    ...params,
  };
  const sorted = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join("&");
  const base = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(sorted)}`;
  const signingKey = `${encodeURIComponent(TW_API_SECRET)}&${encodeURIComponent(TW_ACCESS_SECRET)}`;
  const sig = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  oauthParams.oauth_signature = sig;
  const header = Object.keys(oauthParams)
    .filter((k) => k.startsWith("oauth_"))
    .sort()
    .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(", ");
  return `OAuth ${header}`;
}

async function getTwitterUserId() {
  if (twitterUserId) return twitterUserId;
  const url = "https://api.twitter.com/2/users/me";
  const auth = oauthSign("GET", url);
  const res = await fetch(url, { headers: { Authorization: auth }, dispatcher: proxyDispatcher });
  const json = await res.json();
  if (json.data?.id) {
    twitterUserId = json.data.id;
    console.log(`🐦 Twitter 用户: @${json.data.username} (${twitterUserId})`);
  } else {
    console.error("❌ 获取 Twitter 用户ID失败:", json);
  }
  return twitterUserId;
}

async function twitterLike(tweetId) {
  const userId = await getTwitterUserId();
  if (!userId) return { ok: false, msg: "无法获取Twitter用户ID" };
  const url = `https://api.twitter.com/2/users/${userId}/likes`;
  const auth = oauthSign("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: tweetId }),
    dispatcher: proxyDispatcher,
  });
  const json = await res.json();
  if (json.data?.liked) return { ok: true, msg: "点赞成功" };
  return { ok: false, msg: `点赞失败: ${JSON.stringify(json)}` };
}

async function twitterRetweet(tweetId) {
  const userId = await getTwitterUserId();
  if (!userId) return { ok: false, msg: "无法获取Twitter用户ID" };
  const url = `https://api.twitter.com/2/users/${userId}/retweets`;
  const auth = oauthSign("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: tweetId }),
    dispatcher: proxyDispatcher,
  });
  const json = await res.json();
  if (json.data?.retweeted) return { ok: true, msg: "转推成功" };
  return { ok: false, msg: `转推失败: ${JSON.stringify(json)}` };
}

async function twitterFollow(targetUsername) {
  const userId = await getTwitterUserId();
  if (!userId) return { ok: false, msg: "无法获取Twitter用户ID" };
  // First get target user ID by username
  const lookupUrl = `https://api.twitter.com/2/users/by/username/${targetUsername}`;
  const lookupAuth = oauthSign("GET", lookupUrl);
  const lookupRes = await fetch(lookupUrl, {
    headers: { Authorization: lookupAuth },
    dispatcher: proxyDispatcher,
  });
  const lookupJson = await lookupRes.json();
  const targetId = lookupJson.data?.id;
  if (!targetId) return { ok: false, msg: `找不到用户 @${targetUsername}` };
  // Follow
  const url = `https://api.twitter.com/2/users/${userId}/following`;
  const auth = oauthSign("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ target_user_id: targetId }),
    dispatcher: proxyDispatcher,
  });
  const json = await res.json();
  if (json.data?.following) return { ok: true, msg: `关注 @${targetUsername} 成功` };
  if (json.data?.pending_follow) return { ok: true, msg: `已请求关注 @${targetUsername}(待对方批准)` };
  return { ok: false, msg: `关注失败: ${JSON.stringify(json)}` };
}

async function fetchTargetUrl(campaignId) {
  // First try Open API, fallback to GraphQL unifiedCampaignDetail
  try {
    const res = await fetch(
      `https://service.lhdao.top/open-api/v1/campaigns/${campaignId}`,
      { headers: { "X-API-Key": LH_OPEN_API_KEY } },
    );
    const json = await res.json();
    return json.targetUrl || null;
  } catch (e) {
    console.error(`  ⚠️ 获取 campaign 详情失败:`, e.message);
    return null;
  }
}

function extractTweetIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/status\/(\d+)/);
  return match ? match[1] : null;
}

function extractUsernameFromUrl(url) {
  if (!url) return null;
  const match = url.match(/(?:twitter\.com|x\.com)\/(@?(\w+))/);
  return match ? match[2] : null;
}

async function verifyEngagement(campaignId) {
  const json = await gql(M_VERIFY_ENGAGEMENT, { campaignId });
  if (json.errors) {
    return { ok: false, msg: `验证失败: ${json.errors[0].message}` };
  }
  const data = json.data?.verifyEngagement;
  if (data) {
    return { ok: true, msg: `验证成功 (奖励: ${data.actualReward} LUX, 完成: ${data.completedActions}个动作)` };
  }
  return { ok: false, msg: "验证失败(未知原因)" };
}

async function autoCompleteActions(campaign) {
  // Get tweet ID from campaign data or fetch via API
  let tweetId = campaign.tweetId;
  if (!tweetId) {
    const url = campaign.targetUrl || (LH_OPEN_API_KEY ? await fetchTargetUrl(campaign.id) : null);
    tweetId = extractTweetIdFromUrl(url);
  }
  const results = [];
  const manualActions = [];
  for (const action of campaign.actions || []) {
    const type = (action.actionType || "").toUpperCase();
    if (type === "LIKE" || type === "TWITTER_LIKE") {
      if (!tweetId) { manualActions.push(action.actionType); continue; }
      const r = await twitterLike(tweetId);
      console.log(`  🐦 自动点赞: ${r.msg}`);
      results.push({ action: "点赞", ...r });
    } else if (type === "RETWEET" || type === "TWITTER_RETWEET") {
      if (!tweetId) { manualActions.push(action.actionType); continue; }
      const r = await twitterRetweet(tweetId);
      console.log(`  🐦 自动转推: ${r.msg}`);
      results.push({ action: "转推", ...r });
    } else if (type === "FOLLOW" || type === "TWITTER_FOLLOW") {
      const username = campaign.targetUsername || extractUsernameFromUrl(campaign.targetUrl);
      if (username) {
        const r = await twitterFollow(username);
        console.log(`  🐦 自动关注: ${r.msg}`);
        results.push({ action: "关注", ...r });
      } else {
        console.log(`  ⚠️ 无法获取目标用户名，跳过关注`);
        manualActions.push(action.actionType);
      }
    } else {
      manualActions.push(action.actionType);
    }
  }
  if (manualActions.length > 0) {
    console.log(`  📝 需手动完成: ${manualActions.join(", ")}`);
  }
  return { results, manualActions, tweetUrl: campaign.targetUrl };
}

async function poll() {
  checkTokenExpiry();
  const { autoGrab, minReward } = reloadEnv();
  const seen = loadSeen();
  console.log(
    `[${new Date().toLocaleString()}] 检查中... (已记录 ${seen.size} 个 | 阈值 ${minReward} LUX)`,
  );

  try {
    const [tweetsRes, engRes] = await Promise.all([
      gql(Q_TWEETS),
      gql(Q_ENGAGEMENTS),
    ]);

    const tweets = (tweetsRes.data?.availableTweets || []).map((c) => ({
      ...c,
      _type: "tweet",
    }));
    const engs = (engRes.data?.availableEngagements || []).map((c) => ({
      ...c,
      _type: "engagement",
    }));
    const all = [...tweets, ...engs];

    const newOnes = all.filter((c) => !seen.has(c.id));
    if (newOnes.length === 0) {
      console.log("  无新任务");
      return;
    }

    const lines = [];
    const grabbed = [];
    for (const c of newOnes) {
      const reward = effectiveReward(c);
      const rewardStr = formatReward(c);
      const name = campaignName(c);
      const link = `https://app.lhdao.top/campaigns/${c.id}`;

      const isTweet = c._type === "tweet";
      const shouldGrab =
        autoGrab && !c.isSoldOut && (isTweet || reward >= minReward);

      if (!shouldGrab) {
        seen.add(c.id);
        continue;
      }

      const result = await tryGrab(c);
      console.log(`  🤖 自动占位 ${name}: ${result.msg}`);

      lines.push(
        `📢 ${name} - ${c.title || ""}\n` +
          `  类型: ${isTweet ? "推文" : "互动"}\n` +
          `  奖励: ${rewardStr}\n` +
          `  占位: ${result.msg}`,
      );
      if (result.ok) grabbed.push({ campaign: c, name, rewardStr, link });
      seen.add(c.id);
    }

    if (lines.length > 0) {
      await sendWechat(
        `🔔 Lighthouse 新任务 (${lines.length}个)\n\n${lines.join("\n\n")}`,
      );
    }

    for (const g of grabbed) {
      // Auto-complete like/retweet via Twitter API
      let twitterMsg = "";
      if (TW_API_KEY) {
        const tw = await autoCompleteActions(g.campaign);
        if (tw.results && tw.results.length > 0) {
          const done = tw.results.filter((r) => r.ok).map((r) => r.action);
          const failed = tw.results.filter((r) => !r.ok).map((r) => `${r.action}:${r.msg}`);
          if (done.length) twitterMsg += `\n🐦 已自动完成: ${done.join(", ")}`;
          if (failed.length) twitterMsg += `\n⚠️ 失败: ${failed.join("; ")}`;

          // Auto-verify if all actions are auto-completable (no manual actions)
          if (done.length > 0 && (!tw.manualActions || tw.manualActions.length === 0)) {
            console.log(`  🔄 自动验证中...`);
            const vr = await verifyEngagement(g.campaign.id);
            console.log(`  ✔️ ${vr.msg}`);
            twitterMsg += `\n${vr.ok ? "✅" : "❌"} ${vr.msg}`;
          }
        }
        if (tw.manualActions && tw.manualActions.length > 0) {
          twitterMsg += `\n📝 需手动: ${tw.manualActions.join(", ")}`;
          if (tw.tweetUrl) twitterMsg += `\n🔗 推文: ${tw.tweetUrl}`;
          twitterMsg += `\n👉 完成后请手动验证`;
        }
      }
      await sendWechat(
        `✅ 自动占位成功!\n\n项目: ${g.name}\n奖励: ${g.rewardStr}\n链接: ${g.link}${twitterMsg}`,
      );
    }
    saveSeen(seen);
    console.log(`✅ 处理 ${newOnes.length} 个新任务`);
  } catch (err) {
    console.error("❌ 查询失败:", err.message);
  }
}

if (!ACCESS_TOKEN || ACCESS_TOKEN === "your_token_here") {
  console.error("请在 .env 中填写 LH_ACCESS_TOKEN");
  process.exit(1);
}

const { autoGrab: initGrab, minReward: initMin } = reloadEnv();
const hasTwitter = !!(TW_API_KEY && TW_API_SECRET && TW_ACCESS_TOKEN && TW_ACCESS_SECRET && LH_OPEN_API_KEY);
console.log(
  `🚀 Lighthouse 监控启动 | 轮询 ${POLL_INTERVAL / 1000}s | 自动占位: ${initGrab} | 最低奖励: ${initMin} LUX | Twitter自动: ${hasTwitter ? "开启" : "关闭"} (改 .env 即时生效)`,
);
if (hasTwitter) getTwitterUserId().catch(() => {});
poll();
setInterval(poll, POLL_INTERVAL);
