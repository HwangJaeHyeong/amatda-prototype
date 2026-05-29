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
      "너는 외출 준비물 추천 비서야. 핵심 목표는 '신뢰할 수 있는' 추천 — 이 일정에 진짜 필요한 것만, 군더더기 없이.\n" +
      "규칙:\n" +
      "1) 일정/장소/목적/추가답변/날씨/사용자 특성에 근거가 있는 항목만 추천한다. 확신이 없으면 빼라(개수를 억지로 채우지 마). 보통 4~9개, 품질 우선. 일정과 무관한 일반론적 물건은 절대 넣지 마.\n" +
      "2) 각 항목은 구체적으로 — 종류·수량·규격을 명시. 예: '충전기'→'노트북 충전기(C타입)', '우산'→'접이식 우산', '약'→'두통약', '물'→'500ml 텀블러', '서류'→'계약서 2부'. 한 항목 16자 이내.\n" +
      "3) 지갑·휴대폰·교통카드 같은 기본 소지품과 '자주 깜빡하는 물건'은 이 외출에 필요할 때만 포함(무관하면 제외).\n" +
      "4) 일정이 모호해 신뢰도 높은 추천이 어려우면(실내/실외·활동 종류·격식·숙박 여부 등 불명확) 추측하지 말고, 결과를 가장 크게 가르는 '한 가지'만 묻는 질문을 1개 해. 단, 아래 '되물은 횟수'가 2 이상이면 더 묻지 말고 최선의 추천을 확정한다.\n" +
      "출력은 JSON 객체 하나만:\n" +
      "- 더 물어야 할 때: {\"ask\":\"질문\",\"options\":[\"보기1\",\"보기2\",\"보기3\"]}\n" +
      "- 추천 확정: {\"items\":[\"구체항목1\",\"구체항목2\"]}\n" +
      "설명·문장·코드블록 없이 JSON만 출력." },
    { role: "user", content:
      `일정: ${p.schedule || "(미입력)"}\n` +
      `장소: ${p.place || "미지정"}\n` +
      `목적: ${p.purpose || "미지정"}\n` +
      `추가 답변: ${(p.notes && p.notes.length) ? p.notes.join(" / ") : "없음"}\n` +
      `되물은 횟수: ${p.round || 0} (2 이상이면 더 묻지 말 것)\n` +
      `실시간 날씨: ${w.sky || "?"}, 강수확률 ${w.rainProb ?? "?"}%, 기온 ${w.temp || "?"}\n` +
      `사용자 라이프스타일: ${life}\n` +
      `자주 깜빡하는 물건: ${forget}\n` +
      `덜렁거림 정도: ${level}` },
  ];
}

function parseResult(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (Array.isArray(o.items)) o.items = o.items.map(x => String(x).trim()).filter(Boolean).slice(0, 14);
    if (Array.isArray(o.options)) o.options = o.options.map(x => String(x).trim()).filter(Boolean).slice(0, 4);
    return o;
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
        const r = parseResult(content);
        res.writeHead((r && (r.items?.length || r.ask)) ? 200 : 502, { "Content-Type": "application/json" });
        if (r && Array.isArray(r.items) && r.items.length) res.end(JSON.stringify({ items: r.items, source: "ai", model: MODEL }));
        else if (r && r.ask) res.end(JSON.stringify({ ask: String(r.ask), options: r.options || [], source: "ai", model: MODEL }));
        else res.end(JSON.stringify({ error: "PARSE" }));
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
