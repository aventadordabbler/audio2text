import assert from "node:assert/strict";
import { test } from "node:test";
import { MeetingApi } from "../src/services/meeting-api.js";

const draft = {
  base_url: "https://model.example/v1",
  model: "example-model",
  timeout_seconds: 120,
};

test("model test sends draft settings through the server without saving them", async (t) => {
  const requests = [];
  const result = { success: true, message: "连接成功", elapsed_ms: 123 };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return Response.json(result);
  });
  const api = new MeetingApi({
    baseUrl: "https://meeting.example/prefix",
    apiKey: "meeting-service-key",
  });
  assert.deepEqual(await api.testModelConfig("llm", draft), result);
  assert.deepEqual(
    await api.testModelConfig("llm", { ...draft, api_key: "draft-model-key" }),
    result,
  );
  assert.equal(requests.length, 2);
  for (const { url, init } of requests) {
    assert.equal(
      url,
      "https://meeting.example/prefix/api/model-configs/llm/test",
    );
    assert.equal(init.method, "POST");
    assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, undefined);
  }
  assert.deepEqual(JSON.parse(requests[0].init.body), draft);
  assert.equal(
    Object.hasOwn(JSON.parse(requests[0].init.body), "api_key"),
    false,
    "omitting the key preserves server-side credential reuse",
  );
  assert.equal(JSON.parse(requests[1].init.body).api_key, "draft-model-key");
});

test("an HTTP 200 response can still report failed model authentication", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: false,
      message: "鉴权失败（HTTP 401）",
      elapsed_ms: 12,
    }),
  );
  const result = await new MeetingApi({
    baseUrl: "https://meeting.example",
  }).testModelConfig("llm", draft);
  assert.equal(result.success, false);
  assert.match(result.message, /401/);
});

test("malformed results and HTTP errors cannot be mistaken for successful tests", async (t) => {
  const responses = [
    Response.json({ success: "true" }),
    Response.json({ detail: "测试服务暂不可用" }, { status: 503 }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  const api = new MeetingApi({ baseUrl: "https://meeting.example" });
  await assert.rejects(api.testModelConfig("llm", draft), /无效结果/);
  await assert.rejects(api.testModelConfig("llm", draft), /测试服务暂不可用/);
});

test("leaving model settings can cancel the pending connection test", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const controller = new AbortController();
  const request = new MeetingApi({
    baseUrl: "https://meeting.example",
  }).testModelConfig("llm", draft, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});
