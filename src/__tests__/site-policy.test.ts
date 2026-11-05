import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "patchright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { makeRegistrar, ALL_TOOLSETS } from "../tools/shared.js";
import * as groups from "../tools/index.js";
import { chromiumPath } from "./browser-processes.js";

async function fixture(mode = "on", shared = "", limits: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "site-policy-"));
  await writeFile(join(dir, "deny.txt"), shared);
  const hits: string[] = [];
  const pending = new Set<() => void>();
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const u = new URL(request.url);
    hits.push(u.hostname + u.pathname);
    if (u.pathname === "/redirect") return Response.redirect(`http://sub.example.com:${site.port}/blocked`, 302);
    if (u.pathname.startsWith("/chain/")) {
      const n = Number(u.pathname.split("/").pop());
      if (n > 0) return Response.redirect(`http://allowed.test:${site.port}/chain/${n - 1}`, 302);
    }
    if (u.pathname === "/hang") return new Promise<Response>(resolve => { const timer=setTimeout(()=>resolve(new Response("released")),1000); pending.add(() => {clearTimeout(timer);resolve(new Response("released"));}); });
    if (u.pathname === "/resources") return new Response(`<body><img src="http://sub.example.com:${site.port}/image"><script>fetch('http://sub.example.com:${site.port}/fetch').then(()=>document.body.dataset.fetch='allowed',()=>document.body.dataset.fetch='blocked')</script>`, {headers:{"content-type":"text/html"}});
    return new Response("<title>Policy fixture</title><p>ok</p>", {headers:{"content-type":"text/html","access-control-allow-origin":"*"}});
  }});
  const browser = await chromium.launch({executablePath:chromiumPath,headless:true,args:["--no-sandbox","--no-proxy-server","--host-resolver-rules=MAP * 127.0.0.1"]});
  const env = EnvSchema.parse({BROWSER_MODE:"local",STEEL_LANES:mode,STEEL_SITE_DENY_FILE:join(dir,"deny.txt"),OUTPUT_DIR:dir,RELAY_PORT:"0",TAB_IDLE_TIMEOUT_MS:"0",SETTLE_TIMEOUT_MS:"0",...limits});
  const root = new BrowserManager(env);
  const operator = await browser.newContext();
  const primary = await operator.newPage();
  Object.assign(root,{_connectSteel:async()=>{Object.assign(root,{browser,browserContext:operator}); const id=(root as unknown as {allocateTab(page:typeof primary):number}).allocateTab(primary);Object.assign(root,{currentTabId:id,primaryTabId:id});}});
  Object.assign(env,{BROWSER_MODE:"steel"});
  const server = new McpServer({name:"policy-test",version:"1"});
  const handle = makeRegistrar(server,new Set(ALL_TOOLSETS),{manager:root,env});
  for(const register of Object.values(groups)) register(handle.register,handle.manager??root,env);
  const [ct,st]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:"policy-test",version:"1"});
  await Promise.all([server.connect(st),client.connect(ct)]);
  const call=(caller:string,name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args,_meta:{"ai.opencode/sessionID":caller}});
  const url=(host="allowed.test",path="/")=>`http://${host}:${site.port}${path}`;
  return {call,client,hits,browser,url,async close(){for(const release of pending)release();await handle.close?.();await root.stop();await client.close();await server.close();await browser.close();site.stop(true);await rm(dir,{recursive:true,force:true});}};
}

test("block_site has exact schema and annotations in both modes",async()=>{
  for(const mode of ["on","off"]){const f=await fixture(mode);try{const tools=(await f.client.listTools()).tools;expect(tools.filter(t=>t.name==="block_site")).toHaveLength(1);const tool=tools.find(t=>t.name==="block_site")!;expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(["reason","site"]);expect(tool.inputSchema.required??[]).toEqual([]);expect(tool.annotations).toEqual({title:"Block Site",readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false});}finally{await f.close();}}
});

for(const mode of ["on","off"])test(`shared domain blocks navigation, subdomains, not lookalikes: ${mode}`,async()=>{
  const f=await fixture(mode,"# Reviewed test list\nexample.com\n");try{
    for(const host of ["example.com","sub.example.com"]){const result=await f.call("a","new_tab",{url:f.url(host)});expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({error:"site_blocked",domain:"example.com",source:"shared"});}
    expect((await f.call("a","new_tab",{url:f.url("notexample.com")})).isError).not.toBe(true);
    expect(f.hits.some(h=>h.startsWith("example.com/")||h.startsWith("sub.example.com/"))).toBe(false);
  }finally{await f.close();}
});

test("block_site is additive, lane-local and dies with the lane",async()=>{
  const f=await fixture();try{
    expect((await f.call("a","block_site",{site:"https://sub.example.com",reason:"Untrusted site"})).isError).not.toBe(true);
    expect((await f.call("a","block_site")).structuredContent).toMatchObject({sites:[{domain:"example.com",source:"lane",reason:"Untrusted site"}]});
    expect((await f.call("b","block_site")).structuredContent).toEqual({sites:[]});
    expect((await f.call("a","new_tab",{url:f.url("example.com")})).structuredContent).toMatchObject({error:"site_blocked",source:"lane"});
    expect((await f.call("b","new_tab",{url:f.url("example.com")})).isError).not.toBe(true);
    await f.call("a","close_lane");
    expect((await f.call("a","block_site")).structuredContent).toEqual({sites:[]});
  }finally{await f.close();}
});

test("shared policy blocks img and fetch even with interception active",async()=>{
  const f=await fixture("on","example.com\n");try{
    const opened=await f.call("a","new_tab");const tabId=Number(JSON.stringify(opened).match(/Opened Tab (\d+)/)![1]);
    await f.call("a","intercept",{tabId,action:"continue",pattern:"**/*"});
    await f.call("a","go_to_url",{tabId,url:f.url("allowed.test","/resources")});
    const page=f.browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes("/resources"))!;
    await page.waitForFunction(()=>document.body.dataset.fetch);
    expect(await page.locator("body").getAttribute("data-fetch")).toBe("blocked");
    await page.waitForLoadState("load");
    expect(f.hits.filter(h=>h.startsWith("sub.example.com"))).toEqual([]);
  }finally{await f.close();}
});

test("redirect into blocked domain never reaches server",async()=>{
  const f=await fixture("on","example.com\n");try{const result=await f.call("a","new_tab",{url:f.url("allowed.test","/redirect")});expect(result.structuredContent).toMatchObject({error:"site_blocked",domain:"example.com",source:"shared"});expect(f.hits).not.toContain("sub.example.com/blocked");}finally{await f.close();}
});

test("popup inherits the lane deny list",async()=>{
  const f=await fixture();try{
    await f.call("a","block_site",{site:"example.com",reason:"test"});await f.call("a","new_tab",{url:f.url()});
    const page=f.browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()===f.url())!;
    const popupEvent=page.context().waitForEvent("page");
    await page.evaluate(url=>{window.open(url);},f.url("sub.example.com"));const popup=await popupEvent;await popup.waitForLoadState("load",{timeout:1000}).catch(()=>{});
    expect(f.hits.filter(h=>h.startsWith("sub.example.com"))).toEqual([]);
  }finally{await f.close();}
});

test("redirect budget accepts limit and rejects next hop",async()=>{
  for(const [depth,blocked] of [[2,false],[3,true]] as const){const f=await fixture("on","",{STEEL_MAX_REDIRECTS:"2"});try{const r=await f.call("a","new_tab",{url:f.url("allowed.test",`/chain/${depth}`)});if(blocked)expect(r.structuredContent).toMatchObject({error:"budget_exceeded",budget:"redirects",limit:2,observed:3});else expect(r.isError).not.toBe(true);}finally{await f.close();}}
});

test("request budget accepts limit and rejects next request without stopping another lane",async()=>{
  const f=await fixture("on","",{STEEL_MAX_REQUESTS:"2"});try{
    for(let n=0;n<2;n++)expect((await f.call("a","new_tab",{url:f.url("allowed.test",`/n${n}`)})).isError).not.toBe(true);
    expect((await f.call("a","new_tab",{url:f.url("allowed.test","/over")})).structuredContent).toMatchObject({error:"budget_exceeded",budget:"requests",limit:2,observed:3});
    expect((await f.call("b","new_tab",{url:f.url()})).isError).not.toBe(true);
  }finally{await f.close();}
});

test("navigation wall budget stops a hung response but not another lane",async()=>{
  const f=await fixture("on","",{STEEL_NAVIGATION_TIMEOUT_MS:"300"});try{
    expect((await f.call("a","new_tab",{url:f.url("allowed.test","/hang")})).structuredContent).toMatchObject({error:"budget_exceeded",budget:"navigation_ms",limit:300});
    expect((await f.call("b","new_tab",{url:f.url()})).isError).not.toBe(true);
  }finally{await f.close();}
});

test("off mode empty list leaves browsing unchanged and block_site is process-wide",async()=>{
  const f=await fixture("off");try{expect((await f.call("a","new_tab",{url:f.url("example.com")})).isError).not.toBe(true);await f.call("a","block_site",{site:"example.com",reason:"test"});expect((await f.call("b","new_tab",{url:f.url("example.com")})).structuredContent).toMatchObject({error:"site_blocked",source:"lane"});}finally{await f.close();}
});
