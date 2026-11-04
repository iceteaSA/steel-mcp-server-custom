import { expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { renderSigninReview, renderSigninList } from "../signin-ui.js";

const html = '<img src=x onerror="globalThis.compromised=true"><script>bad()</script>';
const request = {
  id: "one",
  site: html,
  profile: "work",
  caller: { agent: html, title: html },
  reason: html,
  domains: [html],
  expires: Date.now() + 300_000,
};

it("renders caller site, agent, title and reason as text, never HTML", () => {
  const { document } = parseHTML('<main id="review"></main><ul id="pending"></ul>');
  const preview = {
    cookies: [{ name: html, domain: ".example.com" }],
    cookieCount: 1,
    storage: [{ origin: "https://example.com", keyCount: 2 }],
    storageAvailable: true,
  };
  renderSigninReview(document.getElementById("review"), request, preview);
  renderSigninList(document.getElementById("pending"), [request], { review() {}, deny() {} });
  expect(document.querySelectorAll("img,script").length).toBe(0);
  expect(document.getElementById("review").textContent).toContain(html);
  expect(document.getElementById("review").textContent).toContain("1 cookies");
  expect(document.getElementById("review").textContent).toContain("https://example.com: 2 keys");
  expect(document.getElementById("pending").textContent).toContain(html);
});

it("binds Approve and Deny to the exact request id without invoking them during render", () => {
  const { document } = parseHTML('<ul id="pending"></ul>');
  const actions = [];
  const list = document.getElementById("pending");
  renderSigninList(list, [request], {
    review(id) {
      actions.push(["review", id]);
    },
    deny(id) {
      actions.push(["deny", id]);
    },
  });
  expect(actions).toEqual([]);
  const buttons = list.querySelectorAll("button");
  buttons[0].click();
  buttons[1].click();
  expect(actions).toEqual([
    ["review", "one"],
    ["deny", "one"],
  ]);
});
