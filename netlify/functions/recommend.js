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
    const r = parseResult(content);
    if (r && Array.isArray(r.items) && r.items.length) return json(200, { items: r.items, source: "ai", model: MODEL });
    if (r && r.ask) return json(200, { ask: String(r.ask), options: r.options || [], source: "ai", model: MODEL });
    return json(502, { error: "PARSE" });
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }
};
