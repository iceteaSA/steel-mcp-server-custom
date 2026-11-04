import type { Frame, Page } from "patchright";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { stripUnsafeControls } from "./untrusted.js";

export type HiddenTextMode = "drop" | "flag" | "off";

function guardDocument(mode: HiddenTextMode, stripControls: (text: string) => string) {
  const doc = document.cloneNode(true) as Document;
  const originals = Array.from(document.querySelectorAll("*"));
  const copies = Array.from(doc.querySelectorAll("*"));
  const hiddenTexts: string[] = [];
  const visibleTexts: string[] = [];
  let hidden = 0;
  const clipsAll = (style: CSSStyleDeclaration, rect: DOMRect): boolean => {
    const clip = style.getPropertyValue("clip").match(/^rect\((.*)\)$/);
    if (clip) {
      const [top, right, bottom, left] = clip[1].split(/[,\s]+/).map(Number.parseFloat);
      if (bottom <= top || right <= left) return true;
    }
    const path = style.clipPath;
    if (/^(?:circle|ellipse)\(0(?:px|%|\s|\))/.test(path)) return true;
    const inset = /^inset\(([^)]+)\)/.exec(path);
    if (inset) {
      const values = inset[1]
        .split(/\s+round\s+/)[0]
        .trim()
        .split(/\s+/);
      const sides =
        values.length === 1
          ? [values[0], values[0], values[0], values[0]]
          : values.length === 2
            ? [values[0], values[1], values[0], values[1]]
            : values.length === 3
              ? [values[0], values[1], values[2], values[1]]
              : values;
      const [top, right, bottom, left] = sides.map(
        (value, i) =>
          parseFloat(value) * (value.endsWith("%") ? (i % 2 ? rect.width : rect.height) / 100 : 1),
      );
      if (top + bottom >= rect.height || left + right >= rect.width) return true;
    }
    const polygon = /^polygon\((.*)\)$/.exec(path);
    if (polygon) {
      const points = polygon[1]
        .replace(/^(?:evenodd|nonzero),\s*/, "")
        .split(",")
        .map((point) =>
          point
            .trim()
            .split(/\s+/)
            .map(
              (value, i) =>
                parseFloat(value) *
                (value.endsWith("%") ? (i ? rect.height : rect.width) / 100 : 1),
            ),
        );
      let area = 0;
      for (let i = 0; i < points.length; i++) {
        const next = points[(i + 1) % points.length];
        area += points[i][0] * next[1] - next[0] * points[i][1];
      }
      if (Math.abs(area) < 0.01) return true;
    }
    return false;
  };
  const reason = (el: Element): boolean => {
    const effective = getComputedStyle(el);
    if (
      ["hidden", "collapse"].includes(effective.visibility) ||
      parseFloat(effective.fontSize) < 2 ||
      effective.color === "rgba(0, 0, 0, 0)"
    )
      return true;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName)) return true;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const clipped = clipsAll(style, rect);
      const reader =
        ["absolute", "fixed"].includes(style.position) &&
        rect.width <= 1 &&
        rect.height <= 1 &&
        style.overflow === "hidden" &&
        clipped;
      if (style.display === "none" || Number(style.opacity) === 0) return true;
      if (!reader) {
        if (clipped) return true;
        if (style.display !== "contents" && (rect.width === 0 || rect.height === 0)) return true;
        // Scrollable content is not hidden merely because it is outside the viewport.
        let scrollable = false;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const parentStyle = getComputedStyle(parent);
          if (
            (/(auto|scroll)/.test(parentStyle.overflowX) &&
              parent.scrollWidth > parent.clientWidth) ||
            (/(auto|scroll)/.test(parentStyle.overflowY) &&
              parent.scrollHeight > parent.clientHeight)
          )
            scrollable = true;
        }
        if (!scrollable && (rect.right + scrollX < 0 || rect.bottom + scrollY < 0)) return true;
        if (
          !scrollable &&
          (["absolute", "fixed"].includes(style.position) || style.transform !== "none") &&
          (rect.left >= innerWidth || rect.top >= innerHeight)
        )
          return true;
      }
    }
    const color = getComputedStyle(el).color;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return color === bg;
    }
    return color === "rgb(255, 255, 255)";
  };
  const walk = (original: Node, copy: Node): string => {
    if (original.nodeType === Node.TEXT_NODE) {
      const clean = stripControls(original.textContent ?? "");
      if (clean !== original.textContent) {
        hidden++;
        copy.textContent = (mode === "flag" ? "[hidden unicode] " : "") + clean;
      }
    }
    if (
      original.nodeType === Node.COMMENT_NODE ||
      (original.nodeType === Node.TEXT_NODE &&
        original.textContent?.trim() &&
        original.parentElement &&
        reason(original.parentElement))
    ) {
      hidden++;
      if (original.nodeType === Node.TEXT_NODE || mode === "flag")
        hiddenTexts.push(original.textContent!);
      if (mode === "drop") copy.parentNode?.removeChild(copy);
      else if (original.nodeType === Node.COMMENT_NODE)
        copy.parentNode?.replaceChild(
          doc.createTextNode(`[hidden] ${stripControls(original.textContent ?? "")} [/hidden]`),
          copy,
        );
      else copy.textContent = `[hidden] ${stripControls(original.textContent ?? "")} [/hidden]`;
      return "";
    }
    if (original.nodeType === Node.TEXT_NODE) return stripControls(original.textContent ?? "");
    const children = Array.from(copy.childNodes);
    const visible = Array.from(original.childNodes)
      .map((child, i) => walk(child, children[i]))
      .join("");
    if (original instanceof Element && visible.trim()) visibleTexts.push(visible);
    return original instanceof Element &&
      /^(P|DIV|BR|LI|H[1-6]|SECTION|ARTICLE|TR)$/.test(original.tagName)
      ? `\n${visible}\n`
      : visible;
  };
  walk(document, doc);
  for (let i = 0; i < originals.length; i++) {
    const el = originals[i];
    const concealed = reason(el);
    for (const name of ["aria-label", "alt", "title", "value", "href"]) {
      const value = el.getAttribute(name);
      if (!value) continue;
      if (!concealed) {
        visibleTexts.push(stripControls(value));
        continue;
      }
      hidden++;
      hiddenTexts.push(value);
      if (name === "href" && el instanceof HTMLAnchorElement && el.href !== value)
        hiddenTexts.push(el.href);
      if (mode === "drop") copies[i].removeAttribute(name);
      else if (name !== "href") copies[i].setAttribute(name, `[hidden] ${value} [/hidden]`);
    }
  }
  // Detached innerText does not preserve block boundaries. Reconstruct them on the copy only.
  for (const el of copies) {
    Object.defineProperty(el, "innerText", {
      get() {
        const text = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
          const inner = Array.from(node.childNodes).map(text).join("");
          return node instanceof Element &&
            /^(P|DIV|BR|LI|H[1-6]|SECTION|ARTICLE|TR)$/.test(node.tagName)
            ? `\n${inner}\n`
            : inner;
        };
        return text(el);
      },
    });
  }
  return { doc, hidden, hiddenTexts, visibleTexts, originals, copies };
}

const GUARD_SOURCE = `function(mode) { return (${guardDocument})(mode, ${stripUnsafeControls}); }`;

export function hiddenReadContext<T extends Page | Frame>(ctx: T, mode: HiddenTextMode) {
  const state = { hidden: 0, applied: false };
  if (mode === "off") return { context: ctx, state };
  const evaluate = async (fn: Function, args: unknown, selector?: string) => {
    const payload = { guard: GUARD_SOURCE, fn: fn.toString(), args, mode };
    const run = (root: Element | null, p: typeof payload) => {
      const data = new Function(`return (${p.guard})`)()(p.mode);
      const value = root
        ? new Function("document", `return (${p.fn})`)(data.doc)(
            data.copies[data.originals.indexOf(root)],
            p.args,
          )
        : new Function("document", `return (${p.fn})`)(data.doc)(p.args);
      return { __steelGuard: true, value, hidden: data.hidden };
    };
    const result = selector
      ? await ctx.locator(selector).evaluate(run, payload)
      : await ctx.evaluate(({ run, payload }) => new Function(`return (${run})`)()(null, payload), {
          run: run.toString(),
          payload,
        });
    if (result?.__steelGuard) {
      state.hidden = Math.max(state.hidden, result.hidden);
      state.applied = true;
      return result.value;
    }
    return result;
  };
  const context = new Proxy(ctx, {
    get(target, key) {
      if (key === "evaluate") return (fn: Function, args: unknown) => evaluate(fn, args);
      if (key === "content")
        return () =>
          evaluate(
            ({ flag }: { flag: boolean }) => {
              // Readability otherwise removes accessible text before it can reach the result.
              for (const el of document.querySelectorAll("[aria-hidden]"))
                el.removeAttribute("aria-hidden");
              if (flag)
                for (const el of document.querySelectorAll<HTMLElement>("*")) {
                  el.removeAttribute("hidden");
                  el.style.removeProperty("display");
                  el.style.removeProperty("visibility");
                }
              return document.documentElement.outerHTML;
            },
            { flag: mode === "flag" },
          );
      if (key === "locator")
        return (selector: string) =>
          new Proxy(target.locator(selector), {
            get(locator, prop) {
              if (prop === "evaluate")
                return (fn: Function, args: unknown) => evaluate(fn, args, selector);
              const value = Reflect.get(locator, prop);
              return typeof value === "function" ? value.bind(locator) : value;
            },
          });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { context, state };
}

export async function guardSnapshot(ctx: Page | Frame, text: string, mode: HiddenTextMode) {
  if (mode === "off") return { text, hidden: 0, applied: false };
  const result = await ctx.evaluate(
    ({ source, mode }) => {
      const data = new Function(`return (${source})`)()(mode);
      return {
        hidden: data.hidden,
        hiddenTexts: data.hiddenTexts,
        visibleTexts: data.visibleTexts,
      };
    },
    { source: GUARD_SOURCE, mode },
  );
  if (!Array.isArray(result?.hiddenTexts)) return { text, hidden: 0, applied: false };
  text = stripUnsafeControls(text);
  const visible = (result.visibleTexts as string[]).map((value) =>
    value.replace(/\s+/g, " ").trim(),
  );
  for (const value of new Set(result.hiddenTexts as string[])) {
    const normalized = stripUnsafeControls(value).replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    // An identical visible string carries no new hidden content. Keep action labels intact.
    if (visible.some((value) => value.includes(normalized))) continue;
    const variants = [...new Set([normalized, JSON.stringify(normalized).slice(1, -1)])].sort(
      (a, b) => b.length - a.length,
    );
    let present = false;
    const redact = (part: string) => {
      for (const value of variants) {
        if (part.includes(value)) present = true;
        part = part.split(value).join(mode === "drop" ? "" : `[hidden] ${value} [/hidden]`);
      }
      return part;
    };
    text = text
      .split("\n")
      .map((line) => {
        const match = /^(\s*-\s+[\w/.-]+)(.*)$/.exec(line);
        if (!match) return line;
        const name = /^(\s*)("(?:\\.|[^"\\])*")/.exec(match[2]);
        const tail = name ? match[2].slice(name[0].length) : match[2];
        const colon = tail.indexOf(":");
        const suffix = colon < 0 ? tail : tail.slice(0, colon + 1) + redact(tail.slice(colon + 1));
        return match[1] + (name ? name[1] + redact(name[2]) : "") + suffix;
      })
      .join("\n");
    if (mode === "flag" && !present)
      text += `\n- text: [hidden] ${JSON.stringify(normalized)} [/hidden]`;
  }
  return { text: stripUnsafeControls(text), hidden: result.hidden, applied: true };
}

export function hiddenNotice<T extends CallToolResult>(
  result: T,
  hidden: number,
  mode: HiddenTextMode,
): T {
  if (mode === "off") return result;
  const notice = `\nhidden: ${hidden}`;
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === "text" ? { ...block, text: block.text + notice } : block,
    ),
    ...(typeof result.structuredContent?.text === "string"
      ? {
          structuredContent: {
            ...result.structuredContent,
            text: result.structuredContent.text + notice,
          },
        }
      : {}),
  };
}
