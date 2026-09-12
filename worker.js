/**
 * JR AI Cloudflare Worker Gateway: jrmusic-premium
 * Handles User Auth & One-Time Code Redemption against CorporateDB
 */

import { MongoClient } from 'mongodb';

const MONGO_URI = "mongodb://aleafs%40aliyun.com:Xl32cVfKQ6SJ@120.55.50.18:27017/CorporateDB?authSource=admin";
const DB_NAME = "CorporateDB";

let cachedClient = null;

async function getDatabase() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGO_URI, {
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      maxPoolSize: 5,
    });
    await cachedClient.connect();
  }
  return cachedClient.db(DB_NAME);
}

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
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const db = await getDatabase();
      const usersCollection = db.collection("users");
      const codesCollection = db.collection("activation_codes");

      // 1. User Register
      if (path === "/api/register" && request.method === "POST") {
        const { username, password } = await request.json();
        if (!username || !password) {
          return jsonResponse({ message: "Username and password are required" }, 400);
        }

        const existingUser = await usersCollection.findOne({ username });
        if (existingUser) {
          return jsonResponse({ message: "Username already exists" }, 409);
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

      // 2. User Login
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

      // 3. Redeem Activation Code (Atomic verification and deletion)
      if (path === "/api/redeem" && request.method === "POST") {
        const { username, code } = await request.json();
        if (!username || !code) {
          return jsonResponse({ message: "Username and code are required" }, 400);
        }

        const cleanCode = code.trim();
        const deleteResult = await codesCollection.findOneAndDelete({ code: cleanCode });

        if (!deleteResult || !deleteResult.value && !deleteResult._id) {
          return jsonResponse({ message: "Invalid or already used activation code" }, 400);
        }

        const updateResult = await usersCollection.updateOne(
          { username },
          { $set: { isActivated: true, redeemedCode: cleanCode, activatedAt: new Date() } }
        );

        if (updateResult.matchedCount === 0) {
          return jsonResponse({ message: "User account not found" }, 404);
        }

        return jsonResponse({
          message: "Account activated successfully",
          isActivated: true,
          redeemedCode: cleanCode
        });
      }

      // 4. Admin Code Generator
      if (path === "/api/admin/create-code" && request.method === "POST") {
        const { adminKey, code } = await request.json();
        if (adminKey !== "JR_SECRET_ADMIN_KEY_2026") {
          return jsonResponse({ message: "Unauthorized admin access" }, 403);
        }

        const newCode = code ? code.trim() : "JR-" + Math.random().toString(36).substring(2, 10).toUpperCase();
        await codesCollection.insertOne({ code: newCode, createdAt: new Date() });
        return jsonResponse({ message: "Code created successfully", code: newCode });
      }

      return jsonResponse({ message: "Route Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ message: "Internal Server Error", error: err.message }, 500);
    }
  }
};
