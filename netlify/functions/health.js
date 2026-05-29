// Netlify 서버리스 함수: 연동 상태 확인
exports.handler = async () => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ok: true,
    ai: !!process.env.FACTCHAT_KEY,
    model: process.env.FACTCHAT_MODEL || "gpt-5-chat-latest",
  }),
});
