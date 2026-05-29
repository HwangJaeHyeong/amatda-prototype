// 아맞다! 프로토타입 로컬 서버 (Node 내장 모듈만 사용, 의존성 없음)
// - 정적 파일 서빙
// - POST /api/recommend : FactChat(OpenAI 호환) LLM 호출 프록시
//   키는 브라우저로 가지 않고 서버에서만 사용 (env FACTCHAT_KEY 또는 .factchat_key 파일)
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const PORT = process.env.PORT || 8000;
const FACT_URL = "https://factchat-cloud.mindlogic.ai/v1/api/openai/chat/completions";
const MODEL = process.env.FACTCHAT_MODEL || "gpt-5-chat-latest";

function getKey() {
  if (process.env.FACTCHAT_KEY) return process.env.FACTCHAT_KEY.trim();
  // 키 파일은 배포(publish) 폴더 바깥(상위 디렉터리)에 두어 공개 노출을 방지
  try { return fs.readFileSync(path.join(DIR, "..", ".factchat_key"), "utf8").trim(); }
  catch (e) {}
  try { return fs.readFileSync(path.join(DIR, ".factchat_key"), "utf8").trim(); }
  catch (e) { return ""; }
}

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css",
  ".png":"image/png", ".json":"application/json", ".svg":"image/svg+xml" };

// FactChat(OpenAI 호환) 호출
function callLLM(messages) {
  const key = getKey();
  if (!key) return Promise.reject(new Error("NO_KEY"));
  const body = JSON.stringify({ model: MODEL, messages });
  return new Promise((resolve, reject) => {
    const u = new URL(FACT_URL);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = ""; res.on("data", d => data += d);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("LLM " + res.statusCode + ": " + data.slice(0,200)));
        try { resolve(JSON.parse(data).choices[0].message.content); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function buildPrompt(p) {
  const life = (p.profile?.lifestyle || []).join(", ") || "없음";
  const forget = (p.profile?.forget || []).join(", ") || "없음";
  const level = ({high:"자주 두고 나감(덜렁이)", mid:"가끔 깜빡", low:"거의 안 잊음"})[p.profile?.level] || "보통";
  const w = p.weather || {};
  return [
    { role: "developer", content:
      "너는 외출 준비물 추천 비서야. 사용자의 일정/장소/목적/실시간 날씨/사용자 특성을 종합해, " +
      "실제로 챙겨야 할 준비물을 한국어 명사(구)로 6~12개 추천해. " +
      "지갑·휴대폰·열쇠 같은 기본 소지품도 포함하고, 날씨(비/추위/더위)와 목적에 꼭 맞는 항목을 우선해. " +
      "'자주 깜빡하는 물건'은 반드시 포함시켜. " +
      "출력은 오직 JSON 배열 하나만. 예: [\"우산\",\"노트북\",\"보조배터리\"]. 설명/문장/코드블록 금지." },
    { role: "user", content:
      `일정: ${p.schedule || "(미입력)"}\n` +
      `장소: ${p.place || "미지정"}\n` +
      `목적: ${p.purpose || "미지정"}\n` +
      `실시간 날씨: ${w.sky || "?"}, 강수확률 ${w.rainProb ?? "?"}%, 기온 ${w.temp || "?"}\n` +
      `사용자 라이프스타일: ${life}\n` +
      `자주 깜빡하는 물건(꼭 포함): ${forget}\n` +
      `덜렁거림 정도: ${level}` },
  ];
}

function parseItems(text) {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.map(x => String(x).trim()).filter(Boolean).slice(0, 14) : null;
  } catch (e) { return null; }
}

const server = http.createServer((req, res) => {
  // API: 추천
  if (req.method === "POST" && req.url === "/api/recommend") {
    let raw = ""; req.on("data", d => raw += d);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(raw || "{}");
        const content = await callLLM(buildPrompt(payload));
        const items = parseItems(content);
        if (!items || !items.length) throw new Error("PARSE");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items, source: "ai", model: MODEL }));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }
  // API: 상태
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ai: !!getKey(), model: MODEL }));
    return;
  }
  // 정적 파일
  let fp = decodeURIComponent(req.url.split("?")[0]);
  if (fp === "/") fp = "/index.html";
  const full = path.join(DIR, fp);
  if (!full.startsWith(DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎒 아맞다! 프로토타입 → http://localhost:${PORT}`);
  console.log(`   AI 추천: ${getKey() ? "사용 가능 ✅ (FactChat · " + MODEL + ")" : "키 없음 ⚠️ (규칙 엔진으로 폴백)"}\n`);
});
