import childProcess, { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "patchright";

export const systemChromiumPath = "/usr/bin/chromium";
const bundledChromium = chromium.executablePath();
export const chromiumPath =
  process.env.STEEL_TEST_CHROMIUM ??
  (existsSync(bundledChromium) ? bundledChromium : systemChromiumPath);
export const bun13 = () => Bun.version.startsWith("1.3.");

// Bun #34785 double-closes extra stdio fds after child GC.
// Keep closed child references for this test process. Remove at Bun ≥ 1.4.0.
const retainedChildren: Array<{ child: ChildProcess; stdio: ChildProcess["stdio"] }> = [];
const executablePaths = new Set([chromiumPath, systemChromiumPath]);
const nativeSpawn = childProcess.spawn;
const retainedSpawn = new Proxy(nativeSpawn, {
  apply(target, receiver, args) {
    const child: ChildProcess = Reflect.apply(target, receiver, args);
    const options = args[2] ?? args[1];
    if (
      executablePaths.has(args[0]) &&
      options &&
      Array.isArray(options.stdio) &&
      options.stdio.length > 3
    ) {
      retainedChildren.push({ child, stdio: child.stdio });
    }
    return child;
  },
});
if (bun13()) {
  childProcess.spawn = retainedSpawn;
  process.once("exit", () => {
    if (childProcess.spawn === retainedSpawn) childProcess.spawn = nativeSpawn;
  });
}

export function retainedBrowserCount(): number {
  return retainedChildren.length;
}
