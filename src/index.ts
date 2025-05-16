import { openai } from "@ai-sdk/openai";
import { Memory } from "@mastra/memory";
import { Browser, BrowserContext, Beam } from "beam";

import "dotenv/config";

const b = new Browser({
  headless: false,
});

const example = async () => {
  console.log("starting example");
  const context = new BrowserContext({
    browser: b,
    config: {},
  });

  const newBeam = new Beam({
    browser: b,
    llm: openai("gpt-4o"),
    useVision: true,
    context: context,
  });

  newBeam.on("tool-call", (toolCall) => {
    console.log(toolCall);
  });

  newBeam.on("tool-result", (toolResult) => {
    console.log(toolResult);
  });

  newBeam.on("step", (step) => {
    console.log(step);
  });

  newBeam.on("done", (result) => {
    console.log(result);
  });

  newBeam.on("error", (error) => {
    console.log(error);
  });

  await newBeam.initialize();

  const result = await newBeam.run({
    task: "Go to news.ycombinator.com and click on the 1st AI / LLM related article",
  });

  console.log(result);
};

const promises = Array.from({ length: 2 }, async (_, i) => {
  return example();
});

await Promise.all(promises);
