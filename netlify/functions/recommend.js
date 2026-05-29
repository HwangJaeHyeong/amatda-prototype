// Netlify 서버리스 함수: FactChat(OpenAI 호환) 추천 프록시
// 키는 Netlify 환경변수 FACTCHAT_KEY 에서만 읽음 (브라우저로 전송 안 됨)
const FACT_URL = "https://factchat-cloud.mindlogic.ai/v1/api/openai/chat/completions";
const MODEL = process.env.FACTCHAT_MODEL || "gpt-5-chat-latest";

function buildPrompt(p) {
  const life = (p.profile?.lifestyle || []).join(", ") || "없음";
  const forget = (p.profile?.forget || []).join(", ") || "없음";
  const level = ({ high: "자주 두고 나감(덜렁이)", mid: "가끔 깜빡", low: "거의 안 잊음" })[p.profile?.level] || "보통";
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

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "METHOD" });
  const key = process.env.FACTCHAT_KEY;
  if (!key) return json(502, { error: "NO_KEY" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "BAD_JSON" }); }

  try {
    const res = await fetch(FACT_URL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: buildPrompt(payload) }),
    });
    if (!res.ok) {
      const t = await res.text();
      return json(502, { error: "LLM " + res.status + ": " + t.slice(0, 200) });
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const items = parseItems(content);
    if (!items || !items.length) return json(502, { error: "PARSE" });
    return json(200, { items, source: "ai", model: MODEL });
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }
};
