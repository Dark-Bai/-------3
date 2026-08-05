/**
 * PHILIA AI - API Key 加密存储工具
 *
 * 使用 AES-256-GCM 对用户 OpenRouter API Key 做静态加密, 密钥来自:
 *  1. 环境变量 PHILIA_ENC_KEY(32 字节 hex)
 *  2. 否则首次启动生成随机密钥并持久化到 server/data/philia-secret.key
 *
 * 设计目标:
 *  - 密钥明文仅在 /api/philia/analyze 发起 LLM 请求时于服务端解密使用, 绝不下发前端
 *  - 密文 + 随机 IV + authTag 一起持久化(GCM 自带完整性校验, 防篡改)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SECRET_FILE = path.join(__dirname, "data", "philia-secret.key");

/** 加载或生成 32 字节加密密钥 */
function loadKey() {
  if (process.env.PHILIA_ENC_KEY) {
    const buf = Buffer.from(process.env.PHILIA_ENC_KEY, "hex");
    if (buf.length === 32) return buf;
    console.error("[philia-keystore] PHILIA_ENC_KEY 长度非法(需 32 字节 hex), 回退为文件密钥");
  }
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE);
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 });
  console.log("[philia-keystore] 已生成加密密钥并持久化到", SECRET_FILE);
  return key;
}

const KEY = loadKey();

/**
 * 加密明文, 返回 { encKey, encIv } 两个字段(对应 ai_key 表列)
 *  - encKey: AES-256-GCM 密文(base64)
 *  - encIv:  JSON.stringify({ iv, tag })(base64), IV 每次随机
 */
function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encKey: enc.toString("base64"),
    encIv: JSON.stringify({ iv: iv.toString("base64"), tag: tag.toString("base64") }),
  };
}

/** 解密由 encrypt 返回的 { encKey, encIv }; 失败(密钥不符/被篡改)抛错 */
function decrypt({ encKey, encIv }) {
  const { iv, tag } = JSON.parse(encIv);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encKey, "base64")), decipher.final()]).toString("utf8");
}

/** 取掩码, 形如 sk-or-****abcd; 明文为空返回 null */
function maskKey(plain) {
  if (!plain) return null;
  const t = String(plain).trim();
  if (t.length <= 8) return t.slice(0, 2) + "***";
  return t.slice(0, 6) + "****" + t.slice(-4);
}

module.exports = { encrypt, decrypt, maskKey };