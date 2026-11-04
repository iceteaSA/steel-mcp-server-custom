import childProcess, { type ChildProcess } from "node:child_process";

export const chromiumPath = "/home/icetea/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
export const systemChromiumPath = "/usr/bin/chromium";

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
if (Bun.version.startsWith("1.3.")) {
  childProcess.spawn = retainedSpawn;
  process.once("exit", () => {
    if (childProcess.spawn === retainedSpawn) childProcess.spawn = nativeSpawn;
  });
}

export function retainedBrowserCount(): number {
  return retainedChildren.length;
}
