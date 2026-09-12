/**
 * JR AI Cloudflare Worker Gateway: jrmusic-premium
 * Complete Admin API: Create, List, Delete, Lock/Unlock Codes
 */

import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = "mongodb://aleafs%40aliyun.com:Xl32cVfKQ6SJ@120.55.50.18:27017/CorporateDB?authSource=admin";
const DB_NAME = "CorporateDB";

// 管理员校验秘钥（可在前端面板登录时输入）
const ADMIN_SECRET = "JR_SECRET_ADMIN_KEY_2026";

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
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查
    if (path === "/" || path === "") {
      return jsonResponse({
        status: "online",
        service: "Aether Premium Control API",
        version: "2.1.0"
      });
    }

    try {
      const db = await getDatabase();
      const usersCollection = db.collection("users");
      const codesCollection = db.collection("activation_codes");

      /* -------------------------------------------------------------
         用户端核心路由
      ------------------------------------------------------------- */

      // 1. 用户注册
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
          password,
          isActivated: false,
          redeemedCode: null,
          createdAt: new Date()
        };

        const result = await usersCollection.insertOne(newUser);
        return jsonResponse({
          message: "User registered successfully",
          user: {
            id: result.insertedId.toString(),
            username: newUser.username,
            isActivated: false,
            token: "auth_" + result.insertedId.toString()
          }
        });
      }

      // 2. 用户登录
      if (path === "/api/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const user = await usersCollection.findOne({ username, password });

        if (!user) {
          return jsonResponse({ message: "Invalid credentials" }, 401);
        }

        return jsonResponse({
          user: {
            id: user._id.toString(),
            username: user.username,
            isActivated: !!user.isActivated,
            redeemedCode: user.redeemedCode || null,
            token: "auth_" + user._id.toString()
          }
        });
      }

      // 3. 激活码兑换（原子校验锁定状态并在成功后物理删除）
      if (path === "/api/redeem" && request.method === "POST") {
        const { username, code } = await request.json();
        if (!username || !code) {
          return jsonResponse({ message: "Missing username or code" }, 400);
        }

        const cleanCode = code.trim();

        // 优先检查该码是否存在或是否已被锁定
        const targetCode = await codesCollection.findOne({ code: cleanCode });
        if (!targetCode) {
          return jsonResponse({ message: "Invalid or already used activation code" }, 400);
        }

        if (targetCode.isLocked) {
          return jsonResponse({ message: "This activation code is currently locked by administrator" }, 403);
        }

        // 原子删除
        const deleteResult = await codesCollection.findOneAndDelete({ _id: targetCode._id });
        const wasDeleted = deleteResult && (deleteResult.value || deleteResult._id || deleteResult.ok);
        if (!wasDeleted) {
          return jsonResponse({ message: "Code redemption conflict. Please try again" }, 409);
        }

        // 更新用户激活标记
        const updateResult = await usersCollection.updateOne(
          { username },
          { $set: { isActivated: true, redeemedCode: cleanCode, activatedAt: new Date() } }
        );

        if (updateResult.matchedCount === 0) {
          return jsonResponse({ message: "Target account not found" }, 404);
        }

        return jsonResponse({
          message: "Account successfully activated",
          isActivated: true,
          redeemedCode: cleanCode
        });
      }

      /* -------------------------------------------------------------
         管理员接口路由 (需校验 Header 或 Body 中的 x-admin-key)
      ------------------------------------------------------------- */
      const reqAdminKey = request.headers.get("x-admin-key");

      // 4. 管理员验证密码登录
      if (path === "/api/admin/verify" && request.method === "POST") {
        const { adminKey } = await request.json();
        if (adminKey !== ADMIN_SECRET) {
          return jsonResponse({ message: "Invalid Admin Secret Key" }, 403);
        }
        return jsonResponse({ message: "Admin authenticated" });
      }

      // 所有管理操作统一鉴权
      if (path.startsWith("/api/admin/")) {
        if (reqAdminKey !== ADMIN_SECRET) {
          return jsonResponse({ message: "Unauthorized admin access" }, 403);
        }

        // 5. 获取全部激活码列表
        if (path === "/api/admin/list-codes" && request.method === "GET") {
          const list = await codesCollection.find({}).sort({ createdAt: -1 }).toArray();
          return jsonResponse({
            codes: list.map(c => ({
              id: c._id.toString(),
              code: c.code,
              isLocked: !!c.isLocked,
              createdAt: c.createdAt
            }))
          });
        }

        // 6. 创建单个或批量生成激活码
        if (path === "/api/admin/create-codes" && request.method === "POST") {
          const { customCode, count = 1, prefix = "JR" } = await request.json();
          const toInsert = [];

          if (customCode && customCode.trim()) {
            const codeClean = customCode.trim();
            const exists = await codesCollection.findOne({ code: codeClean });
            if (exists) return jsonResponse({ message: "Code already exists" }, 409);

            toInsert.push({
              code: codeClean,
              isLocked: false,
              createdAt: new Date()
            });
          } else {
            const genCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 50);
            for (let i = 0; i < genCount; i++) {
              const randPart = Math.random().toString(36).substring(2, 6).toUpperCase() + "-" +
                               Math.random().toString(36).substring(2, 6).toUpperCase();
              toInsert.push({
                code: `${prefix}-${randPart}`,
                isLocked: false,
                createdAt: new Date()
              });
            }
          }

          if (toInsert.length > 0) {
            await codesCollection.insertMany(toInsert);
          }
          return jsonResponse({ message: `Successfully created ${toInsert.length} code(s)` });
        }

        // 7. 删除指定激活码
        if (path === "/api/admin/delete-code" && request.method === "POST") {
          const { id } = await request.json();
          if (!id) return jsonResponse({ message: "Code ID required" }, 400);

          await codesCollection.deleteOne({ _id: new ObjectId(id) });
          return jsonResponse({ message: "Activation code deleted permanently" });
        }

        // 8. 切换 锁定/解锁 状态
        if (path === "/api/admin/toggle-lock" && request.method === "POST") {
          const { id, isLocked } = await request.json();
          if (!id) return jsonResponse({ message: "Code ID required" }, 400);

          await codesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isLocked: !!isLocked, updatedAt: new Date() } }
          );

          return jsonResponse({
            message: `Code ${isLocked ? "locked" : "unlocked"} successfully`
          });
        }
      }

      return jsonResponse({ message: "Route Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ message: "Internal Server Error", error: err.message }, 500);
    }
  }
};
