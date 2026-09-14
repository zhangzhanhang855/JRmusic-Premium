/**
 * JR AI Cloudflare Worker Gateway: jrmusic-premium
 * Features: Auth, License Codes, Push Subscription & Cron Scheduler (06:00 AM)
 */

import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = "mongodb://aleafs%40aliyun.com:Xl32cVfKQ6SJ@120.55.50.18:27017/CorporateDB?authSource=admin";
const DB_NAME = "CorporateDB";
const ADMIN_SECRET = "JR_SECRET_ADMIN_KEY_2026";

// Web Push 公私鑰（請在生產環境替換或用 wrangler secret 配置）
const VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const VAPID_PRIVATE_KEY = "YOUR_VAPID_PRIVATE_KEY"; // 需配置

let cachedClient = null;

async function getDatabase() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGO_URI, {
      connectTimeoutMS: 8000,
      socketTimeoutMS: 15000,
      maxPoolSize: 5,
    });
    await cachedClient.connect();
  }
  return cachedClient.db(DB_NAME);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-key",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}

export default {
  // HTTP 請求入口
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const db = await getDatabase();
      const usersCollection = db.collection("users");
      const codesCollection = db.collection("activation_codes");

      // 1. 註冊
      if (path === "/api/register" && request.method === "POST") {
        const { username, password } = await request.json();
        if (!username || !password) return jsonResponse({ message: "Fields required" }, 400);

        const existing = await usersCollection.findOne({ username });
        if (existing) return jsonResponse({ message: "Username already exists" }, 409);

        const newUser = {
          username,
          password,
          isActivated: false,
          redeemedCode: null,
          pushSubscription: null,
          favorites: [],
          customPlaylists: [],
          createdAt: new Date()
        };

        const res = await usersCollection.insertOne(newUser);
        return jsonResponse({
          message: "Registered",
          user: { id: res.insertedId.toString(), username: newUser.username, isActivated: false, token: "auth_" + res.insertedId }
        });
      }

      // 2. 登錄
      if (path === "/api/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const user = await usersCollection.findOne({ username, password });
        if (!user) return jsonResponse({ message: "Invalid credentials" }, 401);

        return jsonResponse({
          user: {
            id: user._id.toString(),
            username: user.username,
            isActivated: !!user.isActivated,
            redeemedCode: user.redeemedCode || null,
            favorites: user.favorites || [],
            customPlaylists: user.customPlaylists || [],
            token: "auth_" + user._id.toString()
          }
        });
      }

      // 3. 激活碼核銷
      if (path === "/api/redeem" && request.method === "POST") {
        const { username, code } = await request.json();
        const cleanCode = (code || '').trim();

        const targetCode = await codesCollection.findOne({ code: cleanCode });
        if (!targetCode) return jsonResponse({ message: "Invalid code" }, 400);
        if (targetCode.isLocked) return jsonResponse({ message: "Code locked by admin" }, 403);

        await codesCollection.deleteOne({ _id: targetCode._id });
        await usersCollection.updateOne({ username }, { $set: { isActivated: true, redeemedCode: cleanCode } });

        return jsonResponse({ message: "Activated successfully", isActivated: true });
      }

      // 4. 註冊 Web Push 訂閱 Token
      if (path === "/api/push/subscribe" && request.method === "POST") {
        const { username, subscription } = await request.json();
        if (!username || !subscription) return jsonResponse({ message: "Parameters missing" }, 400);

        await usersCollection.updateOne(
          { username },
          { $set: { pushSubscription: subscription, pushUpdatedAt: new Date() } }
        );
        return jsonResponse({ message: "Push notifications subscribed successfully" });
      }

      // 5. 同步用戶播放清單與收藏
      if (path === "/api/user/sync-meta" && request.method === "POST") {
        const { username, favorites, customPlaylists } = await request.json();
        await usersCollection.updateOne(
          { username },
          { $set: { favorites: favorites || [], customPlaylists: customPlaylists || [], lastSynced: new Date() } }
        );
        return jsonResponse({ message: "User library synced" });
      }

      return jsonResponse({ message: "Route Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ message: "Server Error", error: err.message }, 500);
    }
  },

  // 每天早上 6:00 (UTC 22:00) 自動觸發的 Cron 定時推送
  async scheduled(event, env, ctx) {
    try {
      const db = await getDatabase();
      const usersCollection = db.collection("users");

      // 找出所有已啟用通知並有離線收藏的用戶
      const subscribedUsers = await usersCollection.find({
        isActivated: true,
        pushSubscription: { $ne: null }
      }).toArray();

      for (const user of subscribedUsers) {
        if (!user.favorites || user.favorites.length === 0) continue;

        // 隨機抽選一首用戶收藏的音樂
        const randomTrack = user.favorites[Math.floor(Math.random() * user.favorites.length)];

        const payload = JSON.stringify({
          title: "晨間旋律 · 點擊立即播放",
          body: `早安！今天為你推薦收藏的歌曲：${randomTrack.title} - ${randomTrack.artist}`,
          trackId: randomTrack.id,
          actionUrl: `/?action=play&trackId=${encodeURIComponent(randomTrack.id)}`
        });

        // 通過 Web Push 發送（標準 Fetch Push 協議）
        try {
          await fetch(user.pushSubscription.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "TTL": "86400"
            },
            body: payload
          });
        } catch (pushErr) {
          console.error("Push delivery failure for user:", user.username, pushErr);
        }
      }
    } catch (e) {
      console.error("Scheduled cron job error:", e);
    }
  }
};
