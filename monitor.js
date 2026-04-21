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
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "10000", 10);
const SEEN_FILE = path.join(__dirname, "seen_campaigns.json");
const GRAB_RETRY = parseInt(process.env.GRAB_RETRY || "3", 10);
const GRAB_RETRY_DELAY = parseInt(process.env.GRAB_RETRY_DELAY_MS || "500", 10);

// Twitter credentials
const TW_API_KEY = process.env.TWITTER_API_KEY;
const TW_API_SECRET = process.env.TWITTER_API_SECRET;
const TW_ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const TW_ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;
const LH_OPEN_API_KEY = process.env.LH_OPEN_API_KEY;
const HTTPS_PROXY = process.env.HTTPS_PROXY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const expected = campaign.expectedReward || 0;
  const fromActions = Math.max(
    0,
    ...(campaign.actions || []).map((a) => a.baseReward || 0),
  );
  const best = Math.max(expected, fromActions);
  return best > 0 ? best : campaign.totalBudget || 0;
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

let myUserId = null;
async function getMyUserId() {
  if (myUserId) return myUserId;
  const res = await gql("{ me { id } }");
  myUserId = res.data?.me?.id;
  return myUserId;
}

async function verifyReservation(campaignId) {
  const uid = await getMyUserId();
  if (!uid) return false;
  const res = await gql(
    "query($cid: String!) { reservedEngagementKols(campaignId: $cid) { userId } }",
    { cid: campaignId },
  );
  const kols = res.data?.reservedEngagementKols || [];
  return kols.some((k) => k.userId === uid);
}

async function tryGrab(campaign, retries = GRAB_RETRY) {
  const isTweet = campaign._type === "tweet";
  const mutation = isTweet ? M_GRAB_TWEET : M_RESERVE_ENGAGEMENT;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const json = await gql(mutation, { campaignId: campaign.id });

      if (json.errors) {
        const msg = json.errors[0].message;
        if (
          msg.includes("已满") ||
          msg.includes("sold out") ||
          msg.includes("already") ||
          msg.includes("CAPTCHA")
        ) {
          return { ok: false, msg: `占位失败: ${msg}`, reason: "full" };
        }
        if (attempt < retries) {
          console.log(`  ⏳ 重试 ${attempt}/${retries}: ${msg}`);
          await sleep(GRAB_RETRY_DELAY * attempt);
          continue;
        }
        return {
          ok: false,
          msg: `占位失败(${retries}次): ${msg}`,
          reason: "error",
        };
      }

      if (isTweet) {
        const s = (json.data.grabTweetCampaign.grabStatus || "").toUpperCase();
        if (s === "GRABBED" || s === "SUCCESS" || s === "WRITING") {
          return { ok: true, msg: `占位成功 (${s})`, reason: "ok" };
        }
        if (s === "ALREADY_GRABBED" || s === "ALREADY") {
          return { ok: false, msg: `已抢过 (${s})`, reason: "already" };
        }
        return {
          ok: false,
          msg: `占位失败 (${s})`,
          reason: s.includes("SOLD") || s.includes("FULL") ? "full" : "error",
        };
      }

      // Engagement
      const data = json.data.reserveEngagementSlot;
      if (data.reserved) {
        const confirmed = await verifyReservation(campaign.id);
        if (!confirmed) {
          console.log(`  ⚠️ API返回成功但验证未通过，占位实际失败`);
          return { ok: false, msg: "占位失败(验证未通过)", reason: "full" };
        }
        return { ok: true, msg: "占位成功(已验证)", reason: "ok" };
      }

      const cd = data.cooldownSeconds;
      if (cd && cd > 0) {
        console.log(`  ⏳ 冷却中 (${cd}s)，等待后重试...`);
        await sleep(cd * 1000);
        return tryGrab(campaign, 1);
      }
      return { ok: false, msg: "占位失败(已满)", reason: "full" };
    } catch (err) {
      if (attempt < retries) {
        console.log(`  ⏳ 网络重试 ${attempt}/${retries}: ${err.message}`);
        await sleep(GRAB_RETRY_DELAY * attempt);
        continue;
      }
      return {
        ok: false,
        msg: `网络错误(${retries}次): ${err.message}`,
        reason: "error",
      };
    }
  }
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
    .map(
      (k) => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`,
    )
    .join("&");
  const base = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(sorted)}`;
  const signingKey = `${encodeURIComponent(TW_API_SECRET)}&${encodeURIComponent(TW_ACCESS_SECRET)}`;
  const sig = crypto
    .createHmac("sha1", signingKey)
    .update(base)
    .digest("base64");
  oauthParams.oauth_signature = sig;
  const header = Object.keys(oauthParams)
    .filter((k) => k.startsWith("oauth_"))
    .sort()
    .map(
      (k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`,
    )
    .join(", ");
  return `OAuth ${header}`;
}

async function getTwitterUserId() {
  if (twitterUserId) return twitterUserId;
  const url = "https://api.twitter.com/2/users/me";
  const auth = oauthSign("GET", url);
  const res = await fetch(url, {
    headers: { Authorization: auth },
    dispatcher: proxyDispatcher,
  });
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

// 兜底话术池（DeepSeek 不可用时使用）
const COMMENT_FALLBACKS = [
  "这个观点很有意思，值得深入思考一下",
  "说得很到位，学到了不少东西",
  "分析得挺透彻的，感谢分享这些见解",
  "这个角度之前没想到过，受教了",
  "内容很有深度，收藏慢慢消化",
  "总结得很好，对我帮助很大",
  "很有启发性的内容，期待后续更新",
  "这个思路确实值得借鉴，感谢整理",
  "干货满满，每次看都有新收获",
  "分享得很及时，正好需要这方面的信息",
];

function pickFallback() {
  return COMMENT_FALLBACKS[
    Math.floor(Math.random() * COMMENT_FALLBACKS.length)
  ];
}

async function fetchTweetText(tweetId) {
  const url = `https://api.twitter.com/2/tweets/${tweetId}`;
  const auth = oauthSign("GET", url);
  try {
    const res = await fetch(url, {
      headers: { Authorization: auth },
      dispatcher: proxyDispatcher,
    });
    const json = await res.json();
    return json.data?.text || null;
  } catch {
    return null;
  }
}

async function generateComment(tweetText) {
  if (!DEEPSEEK_API_KEY || !tweetText) return pickFallback();
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              '你是一个中文推特用户。根据推文内容写一条自然的中文评论回复。要求：6-20个字，像真人随手写的，口语化，不要用emoji，不要太正式，不要说"学习了老师"这种套话，可以表达认同、补充观点、或提出轻松的看法。只输出评论内容，不要任何解释。',
          },
          {
            role: "user",
            content: `推文内容：${tweetText.slice(0, 500)}`,
          },
        ],
        max_tokens: 60,
        temperature: 0.9,
      }),
    });
    const json = await res.json();
    const reply = json.choices?.[0]?.message?.content?.trim();
    if (reply && reply.length >= 5) {
      console.log(`  🤖 DeepSeek 生成评论: "${reply}"`);
      return reply;
    }
  } catch (e) {
    console.log(`  ⚠️ DeepSeek 调用失败: ${e.message}`);
  }
  return pickFallback();
}

async function twitterReply(tweetId, text) {
  const url = "https://api.twitter.com/2/tweets";
  const auth = oauthSign("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      reply: { in_reply_to_tweet_id: tweetId },
    }),
    dispatcher: proxyDispatcher,
  });
  const json = await res.json();
  if (json.data?.id) return { ok: true, msg: `评论成功 (${json.data.id})` };
  return { ok: false, msg: `评论失败: ${JSON.stringify(json)}` };
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
  if (json.data?.following)
    return { ok: true, msg: `关注 @${targetUsername} 成功` };
  if (json.data?.pending_follow)
    return { ok: true, msg: `已请求关注 @${targetUsername}(待对方批准)` };
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
    return {
      ok: true,
      msg: `验证成功 (奖励: ${data.actualReward} LUX, 完成: ${data.completedActions}个动作)`,
    };
  }
  return { ok: false, msg: "验证失败(未知原因)" };
}

async function autoCompleteActions(campaign) {
  // Get tweet ID from campaign data or fetch via API
  let tweetId = campaign.tweetId;
  if (!tweetId) {
    const url =
      campaign.targetUrl ||
      (LH_OPEN_API_KEY ? await fetchTargetUrl(campaign.id) : null);
    tweetId = extractTweetIdFromUrl(url);
  }
  // 需要评论时，先拉推文内容给 DeepSeek 生成
  const needsComment = (campaign.actions || []).some((a) => {
    const t = (a.actionType || "").toUpperCase();
    return (
      t === "COMMENT" ||
      t === "COMMENT_LIKE" ||
      t === "TWITTER_COMMENT" ||
      t === "TWITTER_COMMENT_LIKE"
    );
  });
  let commentText = null;
  if (needsComment && tweetId) {
    const tweetContent = await fetchTweetText(tweetId);
    commentText = await generateComment(tweetContent);
  }

  const results = [];
  const manualActions = [];
  for (const action of campaign.actions || []) {
    const type = (action.actionType || "").toUpperCase();
    if (type === "LIKE" || type === "TWITTER_LIKE") {
      if (!tweetId) {
        manualActions.push(action.actionType);
        continue;
      }
      const r = await twitterLike(tweetId);
      console.log(`  🐦 自动点赞: ${r.msg}`);
      results.push({ action: "点赞", ...r });
    } else if (type === "RETWEET" || type === "TWITTER_RETWEET") {
      if (!tweetId) {
        manualActions.push(action.actionType);
        continue;
      }
      const r = await twitterRetweet(tweetId);
      console.log(`  🐦 自动转推: ${r.msg}`);
      results.push({ action: "转推", ...r });
    } else if (type === "FOLLOW" || type === "TWITTER_FOLLOW") {
      const username =
        campaign.targetUsername || extractUsernameFromUrl(campaign.targetUrl);
      if (username) {
        const r = await twitterFollow(username);
        console.log(`  🐦 自动关注: ${r.msg}`);
        results.push({ action: "关注", ...r });
      } else {
        console.log(`  ⚠️ 无法获取目标用户名，跳过关注`);
        manualActions.push(action.actionType);
      }
    } else if (type === "COMMENT" || type === "TWITTER_COMMENT") {
      if (!tweetId) {
        manualActions.push(action.actionType);
        continue;
      }
      const r = await twitterReply(tweetId, commentText || pickFallback());
      console.log(`  🐦 自动评论 "${commentText}": ${r.msg}`);
      results.push({ action: "评论", ...r });
    } else if (type === "COMMENT_LIKE" || type === "TWITTER_COMMENT_LIKE") {
      if (!tweetId) {
        manualActions.push(action.actionType);
        continue;
      }
      const r = await twitterReply(tweetId, commentText || pickFallback());
      console.log(`  🐦 自动评论 "${commentText}": ${r.msg}`);
      results.push({ action: "评论", ...r });
      const rLike = await twitterLike(tweetId);
      console.log(`  🐦 自动点赞: ${rLike.msg}`);
      results.push({ action: "点赞", ...rLike });
    } else {
      manualActions.push(action.actionType);
    }
  }
  if (manualActions.length > 0) {
    console.log(`  📝 需手动完成: ${manualActions.join(", ")}`);
  }
  return { results, manualActions, tweetUrl: campaign.targetUrl };
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (checkStop()) return;
    checkTokenExpiry();
    const { autoGrab, minReward } = reloadEnv();
    const seen = loadSeen();
    console.log(
      `[${new Date().toLocaleString()}] 检查中... (已记录 ${seen.size} 个 | 阈值 ${minReward} LUX)`,
    );

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

    // 分类：需要抢的 vs 跳过的
    const toGrab = [];
    for (const c of newOnes) {
      const reward = effectiveReward(c);
      const isTweet = c._type === "tweet";
      const shouldGrab =
        autoGrab && !c.isSoldOut && (isTweet || reward >= minReward);
      if (shouldGrab) {
        toGrab.push(c);
      }
      seen.add(c.id);
    }

    if (toGrab.length === 0) {
      console.log(`  ${newOnes.length} 个新任务均不符合条件`);
      saveSeen(seen);
      return;
    }

    // 并发抢所有任务
    console.log(`  🚀 并发抢 ${toGrab.length} 个任务...`);
    const grabResults = await Promise.all(
      toGrab.map(async (c) => {
        const result = await tryGrab(c);
        const name = campaignName(c);
        console.log(`  🤖 ${name}: ${result.msg}`);
        return {
          campaign: c,
          result,
          name,
          rewardStr: formatReward(c),
          link: `https://app.lhdao.top/campaigns/${c.id}`,
        };
      }),
    );

    const validResults = grabResults.filter((g) => g.result.reason !== "full");
    const grabbed = grabResults.filter((g) => g.result.ok);

    // Process Twitter actions and build per-campaign details
    const grabMsgs = [];
    for (const g of grabbed) {
      let twitterMsg = "";
      if (TW_API_KEY) {
        const tw = await autoCompleteActions(g.campaign);
        if (tw.results && tw.results.length > 0) {
          const done = tw.results.filter((r) => r.ok).map((r) => r.action);
          const failed = tw.results
            .filter((r) => !r.ok)
            .map((r) => `${r.action}:${r.msg}`);
          if (done.length)
            twitterMsg += `\n  🐦 已自动完成: ${done.join(", ")}`;
          if (failed.length) twitterMsg += `\n  ⚠️ 失败: ${failed.join("; ")}`;

          if (
            done.length > 0 &&
            (!tw.manualActions || tw.manualActions.length === 0)
          ) {
            console.log(`  🔄 自动验证中...`);
            const vr = await verifyEngagement(g.campaign.id);
            console.log(`  ✔️ ${vr.msg}`);
            twitterMsg += `\n  ${vr.ok ? "✅" : "❌"} ${vr.msg}`;
          }
        }
        if (tw.manualActions && tw.manualActions.length > 0) {
          twitterMsg += `\n  📝 需手动: ${tw.manualActions.join(", ")}`;
          if (tw.tweetUrl) twitterMsg += `\n  🔗 推文: ${tw.tweetUrl}`;
          twitterMsg += `\n  👉 完成后请手动验证`;
        }
      }
      grabMsgs.push(
        `✅ ${g.name} | ${g.rewardStr}\n  🔗 ${g.link}${twitterMsg}`,
      );
    }

    // Send ONE combined notification
    const lines = validResults.map(
      (g) =>
        `📢 ${g.name} - ${g.campaign.title || ""}\n` +
        `  类型: ${g.campaign._type === "tweet" ? "推文" : "互动"}\n` +
        `  奖励: ${g.rewardStr}\n` +
        `  占位: ${g.result.msg}`,
    );
    if (lines.length > 0 || grabMsgs.length > 0) {
      let msg = `🔔 Lighthouse 新任务 (${toGrab.length}个)\n\n${lines.join("\n\n")}`;
      if (grabMsgs.length > 0) {
        msg += `\n\n--- 占位结果 ---\n${grabMsgs.join("\n\n")}`;
      }
      await sendWechat(msg);
    }
    saveSeen(seen);
    console.log(
      `✅ 处理 ${newOnes.length} 个新任务, 抢到 ${grabbed.length} 个`,
    );
  } catch (err) {
    console.error("❌ 查询失败:", err.message);
  } finally {
    polling = false;
  }
}

const http = require("http");

// --- Stop signal: file-based + HTTP ---
const STOP_FILE = path.join(__dirname, ".stop");

function checkStop() {
  if (fs.existsSync(STOP_FILE)) {
    fs.unlinkSync(STOP_FILE);
    console.log("🛑 收到停止信号，正在退出...");
    sendWechat("🛑 Lighthouse 监控已停止").finally(() => process.exit(0));
    return true;
  }
  return false;
}

// HTTP server for remote shutdown (port 9898)
const stopServer = http.createServer((req, res) => {
  if (req.url === "/stop") {
    res.writeHead(200);
    res.end("stopping");
    console.log("🛑 收到 HTTP 停止请求，正在退出...");
    sendWechat("🛑 Lighthouse 监控已停止").finally(() => process.exit(0));
  } else {
    res.writeHead(200);
    res.end("ok");
  }
});
stopServer.listen(9898, "127.0.0.1", () => {
  console.log("🔌 停止接口: curl http://127.0.0.1:9898/stop");
});

if (!ACCESS_TOKEN || ACCESS_TOKEN === "your_token_here") {
  console.error("请在 .env 中填写 LH_ACCESS_TOKEN");
  process.exit(1);
}

const { autoGrab: initGrab, minReward: initMin } = reloadEnv();
const hasTwitter = !!(
  TW_API_KEY &&
  TW_API_SECRET &&
  TW_ACCESS_TOKEN &&
  TW_ACCESS_SECRET &&
  LH_OPEN_API_KEY
);
console.log(
  `🚀 Lighthouse 监控启动 | 轮询 ${POLL_INTERVAL / 1000}s | 自动占位: ${initGrab} | 最低奖励: ${initMin} LUX | 重试: ${GRAB_RETRY}次 | Twitter自动: ${hasTwitter ? "开启" : "关闭"} (改 .env 即时生效)`,
);
if (hasTwitter) getTwitterUserId().catch(() => {});
poll();
setInterval(poll, POLL_INTERVAL);
