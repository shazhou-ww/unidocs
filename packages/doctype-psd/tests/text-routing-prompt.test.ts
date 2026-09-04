/**
 * 文字层的分流规则（"这层的字该用 setText 还是 editPixels"）。
 *
 * 修的是一次真实故障：用户要把 PSD 里的 `WWW.YOURSITE.COM` 改成
 * `WWW.UNIDOCS.COM`，那是一个真的文字层，模型却把它交给了生图模型重画，
 * 连试两次画成 `WWW.NOUCNIDE.COM`，最后道歉说做不到。
 *
 * **本文件的断言刻意不写 `toContain("setText")`。** 那种断言在把规则写反的
 * 实现下（"文字层用 editPixels"）照样是绿的 —— 它只钉住了"提到过这个词"。
 * 这里一律先把管辖某一类图层的那条 bullet **摘出来**，再分别钉住句子里两个
 * 工具名的**极性**：谁是被指定的那个、谁是被禁止的那个。把两个名字对调就红。
 */
import { describe, expect, it } from "vitest";
import { instructions, setTextInstructions, textRoutingInstructions } from "../src/tools.js";
import { createPsdAgent } from "../src/agent.js";
import { createStubEditor } from "../src/testing/stub-editor.js";
import type { FontIndexSource } from "../src/text/set-text.js";
import { runQuery } from "../src/queries.js";
import type { Layer, PsdDoc } from "../src/model/types.js";

const fontIndex: FontIndexSource = {
  load: async () => new Map(),
  fallbacks: [],
  blobFor: () => { throw new Error("unused"); },
};

/** 提示词里的一条规则 = 一个 `- ` 开头的行。 */
const bullets = (text: string): string[] =>
  text.split("\n").filter(l => l.startsWith("- "));

/** 摘出唯一一条管辖某类图层的规则；摘不到或摘到多条都是失败，不是"跳过"。 */
const ruleAbout = (text: string, re: RegExp): string => {
  const hit = bullets(text).filter(b => re.test(b));
  expect(hit, `没有恰好一条匹配 ${re} 的规则`).toHaveLength(1);
  return hit[0];
};

/**
 * 某个词**所在的那半句**。极性是逐句的：整条 bullet 里同时有 "setText" 和
 * "NEVER" 说明不了任何事，"NEVER" 贴着哪个名字才说明得了。
 */
const clauseWith = (rule: string, word: string): string => {
  const hit = rule.split(/[,;.—:]/).find(c => c.includes(word));
  if (!hit) throw new Error(`这条规则里没有 ${word}：${rule}`);
  return hit;
};

/** 禁令词。刻意不含 refuse —— "setText 会拒绝这层"是在陈述事实，不是禁令。 */
const FORBIDDEN = /\b(never|not|no)\b/i;

describe("分流规则：可编辑文字层归 setText", () => {
  const rule = () => ruleAbout(textRoutingInstructions, /text\.editable true/);

  it("指定的工具是 setText，且它没有被禁", () => {
    expect(clauseWith(rule(), "setText")).not.toMatch(FORBIDDEN);
  });

  it("editPixels 在这条规则里只以被禁的形式出现", () => {
    expect(clauseWith(rule(), "editPixels")).toMatch(FORBIDDEN);
  });
});

describe("分流规则：画上去的字归 editPixels", () => {
  // raster / fill / smartObject 里的字：getLayers 根本不给它们 text 字段。
  const rule = () => ruleAbout(textRoutingInstructions, /raster/);

  it("指定的工具是 editPixels，且它没有被禁", () => {
    expect(clauseWith(rule(), "editPixels")).not.toMatch(FORBIDDEN);
  });

  it("这条规则不把 setText 当解法 —— 那层没有字可排", () => {
    expect(rule()).not.toContain("setText");
  });
});

describe("分流规则：重排不了的文字层落回 editPixels", () => {
  const rule = () => ruleAbout(textRoutingInstructions, /text\.editable false/);

  it("setText 在这里是会被拒绝的那个，不是被指定的那个", () => {
    expect(clauseWith(rule(), "setText")).toMatch(/refuse/i);
  });

  it("editPixels 是剩下的唯一出路，没有被禁", () => {
    expect(clauseWith(rule(), "editPixels")).not.toMatch(FORBIDDEN);
  });

  it("说明白像素重画过，让模型据实告诉用户", () => {
    expect(rule().toLowerCase()).toContain("redraw");
  });
});

describe("基础提示词里的规则不点名任何条件工具", () => {
  it("基础提示词既不提 setText 也不提 editPixels —— 两个都可能不在", () => {
    expect(instructions).not.toContain("setText");
    expect(instructions).not.toContain("editPixels");
  });

  it("可编辑文字层的字必须重排，不许当像素重画（这条不依赖任何工具在场）", () => {
    const rule = ruleAbout(instructions, /text\.editable true/);
    expect(clauseWith(rule, "re-typeset")).not.toMatch(FORBIDDEN);
    expect(clauseWith(rule, "redraw")).toMatch(FORBIDDEN);
  });

  it("排不了时的出路是停下来说，不是拿像素凑", () => {
    const rule = ruleAbout(instructions, /text\.editable true/);
    expect(rule).toMatch(/stop/i);
  });

  it("真文字与画上去的字靠字段区分，不靠看图", () => {
    // 两个断言必须成对。评审证明过：只断言"含 picture 的从句里有否定词"是空转的
    // —— 把整句判据反过来写成"从图判断、绝不从字段判断"，只要 field 和 picture
    // 挤在同一个从句里（clauseWith 按 ,;.—: 切），拿到的就是整句，否定词到底
    // 贴着哪个词分辨不出来，17 例照样全绿。所以提示词那句被拆成了两个从句，
    // 这里正反各钉一次：picture 那半必须带否定，field 那半必须不带。
    const rule = ruleAbout(instructions, /no text field at all/);
    expect(clauseWith(rule, "picture")).toMatch(FORBIDDEN);
    expect(clauseWith(rule, "that field")).not.toMatch(FORBIDDEN);
  });

  it("READING 段落不许声称 getDoc 报 editable —— 它不报", () => {
    // 与"幽灵工具"同一类错误，对象从工具换成字段：getDoc 走 stripLayer，
    // 把原始 Layer.text 原样 spread 出去,既没有 editable 也没有平铺的 font
    // （评审实测过两个查询的真实返回）。而 setTextInstructions 让模型
    // "先用 getDoc{layerId} 读当前内容" —— 提示词若声称那里有 editable,
    // 模型会找不到、据此认定这层不可编辑、退回 editPixels,**正好复现要修的
    // 那次故障**。
    const reading = ruleAbout(instructions, /REAL TEXT vs\. LETTERING/);
    // 不用 clauseWith：`text:{…}` 里的冒号会把从句切断。改成钉相对位置 ——
    // editable 必须出现在 getLayers 之后、getDoc 之前，且 getDoc 那一句要
    // 明说它不带这个字段。把两个查询名对调会让第一条断言变红。
    const atLayers = reading.indexOf("getLayers reports");
    const atEditable = reading.indexOf("editable");
    const atDoc = reading.indexOf("getDoc");
    expect(atLayers).toBeGreaterThanOrEqual(0);
    expect(atEditable).toBeGreaterThan(atLayers);
    expect(atDoc).toBeGreaterThan(atEditable);
    expect(reading.slice(atDoc)).toMatch(/does NOT carry the editable flag/);
  });
});

describe("分流块与两个工具一起条件化", () => {
  const combos = [
    { name: "都不注入", deps: {} },
    { name: "只有 editor", deps: { editor: createStubEditor() } },
    { name: "只有 fontIndex", deps: { fontIndex } },
    { name: "两个都有", deps: { editor: createStubEditor(), fontIndex } },
  ] as const;

  it("只有两个工具都在场时才出现分流块 —— 只有一个工具时没有流可分", () => {
    for (const { name, deps } of combos) {
      const agent = createPsdAgent(deps);
      const both = "editor" in deps && "fontIndex" in deps;
      expect(agent.instructions.includes(textRoutingInstructions), name).toBe(both);
    }
  });

  it("四种注入组合下，提示词里出现的工具名都真的在工具表里", () => {
    for (const { name, deps } of combos) {
      const agent = createPsdAgent(deps);
      const names = new Set(agent.tools.map(t => t.name));
      for (const candidate of ["setText", "editPixels"]) {
        if (agent.instructions.includes(candidate)) {
          expect(names, `${name}：提示词提到 ${candidate}，工具表却没有`).toContain(candidate);
        }
      }
    }
  });

  it("反过来也成立：工具在表里，提示词就得讲它", () => {
    for (const { name, deps } of combos) {
      const agent = createPsdAgent(deps);
      for (const candidate of ["setText", "editPixels"]) {
        if (agent.tools.some(t => t.name === candidate)) {
          expect(agent.instructions, `${name}：工具表有 ${candidate}，提示词却不提`).toContain(candidate);
        }
      }
    }
  });
});

describe("分流判据必须是 getLayers 真的给得出的字段", () => {
  const textLayer = (id: string, uneditable?: ("warp" | "text-path" | "grid")[]): Layer => ({
    id, type: "text", name: id, bounds: [0, 0, 10, 10], opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false,
    text: { content: "WWW.YOURSITE.COM", style: { font: "Arial" }, ...(uneditable ? { uneditable } : {}) },
  });
  const raster = (id: string): Layer => ({
    id, type: "raster", name: id, bounds: [0, 0, 10, 10], opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false,
    pixels: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
  });
  const doc = (layers: Layer[]): PsdDoc => ({
    canvas: { width: 10, height: 10, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers,
  });

  // 提示词让模型读 `text.editable` 来分流。它要是拼错了、或者 summarize 哪天
  // 改了字段名，上面所有断言仍然全绿 —— 规则会指着一个不存在的字段。
  it("可重排的文字层，getLayers 给出 text.editable === true", async () => {
    const out = await runQuery({ kind: "getLayers" }, doc([textLayer("t")])) as any[];
    expect(out[0].text.editable).toBe(true);
    expect(out[0].text.content).toBe("WWW.YOURSITE.COM");
  });

  it("重排不了的文字层，text.editable === false 并附上原因", async () => {
    const out = await runQuery({ kind: "getLayers" }, doc([textLayer("t", ["warp"])])) as any[];
    expect(out[0].text.editable).toBe(false);
    expect(out[0].text.uneditable).toEqual(["warp"]);
  });

  it("画上去的字没有 text 字段 —— 提示词说的那个「缺席」是真的", async () => {
    const out = await runQuery({ kind: "getLayers" }, doc([raster("r")])) as any[];
    expect(out[0].text).toBeUndefined();
  });
});

describe("setText 的说明块把四个报告字段都点到了", () => {
  // 整分支最终评审找到的：structuredContent 有四个报告字段,提示词却只点名三个,
  // 还写死"当这三个里任何一个非空时"——把 glyphFallbacks 结构性地排除在外。
  // 后果:用户在英文标题里加两个中文字,另外三个字段全空,模型按提示词检查
  // "这三个"、全空,于是报告"改好了,和原来一模一样"——而字形其实换了。
  // 那正是裁定 R37 说"静默换字形是本任务要消灭的东西"的场景。
  const block = setTextInstructions;

  it("四个字段一个都不漏", () => {
    for (const field of ["ignored", "missing", "fontFallbacks", "glyphFallbacks"]) {
      expect(block, `说明块没点名 ${field}`).toContain(field);
    }
  });

  it("数量词说的是四个,不是三个 —— 写死数字就会把新字段排除在外", () => {
    expect(block).toMatch(/any of the four/);
    expect(block).not.toMatch(/any of the three/);
  });

  it("拒绝理由里有缩放 transform 那一档", () => {
    // 这一档是 R36 新增的第四种拒绝,原先的枚举漏了它。
    expect(block).toMatch(/scale\/rotate\/skew|transform/);
  });
});
