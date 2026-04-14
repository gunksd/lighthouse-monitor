#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

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
      if (result.ok) grabbed.push({ name, rewardStr, link });
      seen.add(c.id);
    }

    if (lines.length > 0) {
      await sendWechat(
        `🔔 Lighthouse 新任务 (${lines.length}个)\n\n${lines.join("\n\n")}`,
      );
    }

    for (const g of grabbed) {
      await sendWechat(
        `✅ 自动占位成功!\n\n项目: ${g.name}\n奖励: ${g.rewardStr}\n链接: ${g.link}`,
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
console.log(
  `🚀 Lighthouse 监控启动 | 轮询 ${POLL_INTERVAL / 1000}s | 自动占位: ${initGrab} | 最低奖励: ${initMin} LUX (改 .env 即时生效)`,
);
poll();
setInterval(poll, POLL_INTERVAL);
