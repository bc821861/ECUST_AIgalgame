import { describe, expect, it } from "vitest";
import { safeParseJson } from "./json.ts";

describe("safeParseJson", () => {
  it("解析纯 JSON 对象", () => {
    const r = safeParseJson('{"mood":"calm","trust":50}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ mood: "calm", trust: 50 });
  });

  it("去掉 ```json 围栏", () => {
    const r = safeParseJson('```json\n{"ops":[{"op":"attr.delta","args":{"delta":1}}]}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.value.ops)).toBe(true);
  });

  it("容忍前后废话，只取第一个 { 到最后一个 }", () => {
    const r = safeParseJson('好的，结果如下：{"a":1,"b":{"c":2}} 希望有帮助');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.a).toBe(1);
      expect(r.value.b).toEqual({ c: 2 });
    }
  });

  it("空字符串与纯空白必须失败（DeepSeek U+0020 坑）", () => {
    for (const raw of ["", "   ", "\n\t ", "\u0020".repeat(40)]) {
      const r = safeParseJson(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("E_LLM_FORMAT");
    }
  });

  it("修掉对象和数组的尾逗号", () => {
    const r = safeParseJson('{"a":1,"list":[1,2,],}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1, list: [1, 2] });
  });

  it("字符串里的 ,} 不会被误删", () => {
    const r = safeParseJson('{"note":"a,} b","n":1,}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.note).toBe("a,} b");
  });

  it("支持嵌套，shape 完整保留", () => {
    const raw = '{"turn":{"actor":{"id":"plr_self"},"ops":[{"op":"time.advance","args":{"ticks":1}}]}}';
    const r = safeParseJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(JSON.parse(raw));
  });

  it("顶层非对象（数组/字符串/数字/null）判失败", () => {
    for (const raw of ["[1,2,3]", '"ok"', "42", "null", "true"]) {
      const r = safeParseJson(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("E_LLM_FORMAT");
    }
  });

  it("截断/残缺 JSON 判失败而不是抛异常", () => {
    const r = safeParseJson('{"narrative":"说到一半，然后');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("E_LLM_FORMAT");
  });

  it("完全没有花括号的文本判失败", () => {
    const r = safeParseJson("模型拒绝回答，请重试");
    expect(r.ok).toBe(false);
  });
});
