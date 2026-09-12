/**
 * Aether Cloudflare Worker API
 * Direct TCP connection to MongoDB instance via Node/Socket compatibility layer
 * Handles CORS, User Registration, Login, and One-time Activation Code Redemption
 */

import { MongoClient } from 'mongodb';

// 你的 MongoDB 连接 URI
const MONGO_URI = "mongodb://aleafs%40aliyun.com:Xl32cVfKQ6SJ@120.55.50.18:27017/CorporateDB?authSource=admin";
const DB_NAME = "CorporateDB";

// 全局客户端连接池缓存，避免每次冷启动重复建联
let cachedClient = null;

async function getDatabase() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGO_URI, {
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      maxPoolSize: 10,
    });
    await cachedClient.connect();
  }
  return cachedClient.db(DB_NAME);
}

// 统一 CORS 响应头配置
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
  async fetch(request, env, ctx) {
    // 处理浏览器 Preflight OPTIONS 请求
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const db = await getDatabase();
      const usersCollection = db.collection("users");
      const codesCollection = db.collection("activation_codes");

      // 1. 用户注册接口
      if (path === "/api/register" && request.method === "POST") {
        const { username, password } = await request.json();
        if (!username || !password) {
          return jsonResponse({ message: "Username and password required" }, 400);
        }

        const existingUser = await usersCollection.findOne({ username });
        if (existingUser) {
          return jsonResponse({ message: "Username already taken" }, 409);
        }

        const newUser = {
          username,
          password, // 生产环境建议先由客户端 SHA-256 哈希
          isActivated: false,
          redeemedCode: null,
          createdAt: new Date()
        };

        const result = await usersCollection.insertOne(newUser);
        return jsonResponse({
          message: "User registered successfully",
          user: {
            id: result.insertedId,
            username: newUser.username,
            isActivated: false,
            token: "auth_" + result.insertedId
          }
        });
      }

      // 2. 用户登录接口
      if (path === "/api/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const user = await usersCollection.findOne({ username, password });

        if (!user) {
          return jsonResponse({ message: "Invalid username or password" }, 401);
        }

        return jsonResponse({
          user: {
            id: user._id,
            username: user.username,
            isActivated: !!user.isActivated,
            redeemedCode: user.redeemedCode || null,
            token: "auth_" + user._id
          }
        });
      }

      // 3. 激活码兑换接口（原子验证并物理删除）
      if (path === "/api/redeem" && request.method === "POST") {
        const { username, code } = await request.json();
        if (!username || !code) {
          return jsonResponse({ message: "Missing username or code" }, 400);
        }

        const cleanCode = code.trim();

        // 查找并从集合中物理删除该激活码，防止并发重复兑换
        const deleteResult = await codesCollection.findOneAndDelete({ code: cleanCode });

        if (!deleteResult) {
          return jsonResponse({ message: "Invalid or expired activation code" }, 400);
        }

        // 更新目标用户的激活状态
        const updateResult = await usersCollection.updateOne(
          { username },
          { $set: { isActivated: true, redeemedCode: cleanCode, activatedAt: new Date() } }
        );

        if (updateResult.matchedCount === 0) {
          return jsonResponse({ message: "User account not found" }, 404);
        }

        return jsonResponse({
          message: "Account successfully activated",
          isActivated: true,
          redeemedCode: cleanCode
        });
      }

      // 4. 管理员接口：生成激活码（为后续管理面板预留）
      if (path === "/api/admin/create-code" && request.method === "POST") {
        const { adminKey, code } = await request.json();
        if (adminKey !== "YOUR_SECURE_ADMIN_SECRET") {
          return jsonResponse({ message: "Unauthorized admin key" }, 403);
        }

        const newCode = code ? code.trim() : "AETH-" + Math.random().toString(36).substring(2, 10).toUpperCase();
        await codesCollection.insertOne({ code: newCode, createdAt: new Date() });
        return jsonResponse({ message: "Code created", code: newCode });
      }

      return jsonResponse({ message: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ message: "Internal Engine Error", error: err.message }, 500);
    }
  }
};
