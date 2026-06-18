import { execFileSync } from "node:child_process";

export function openFile(path: string): void {
  const platform = process.platform;
  if (platform === "darwin") execFileSync("open", [path], { stdio: "ignore" });
  else if (platform === "win32") execFileSync("cmd", ["/c", "start", "", path], { stdio: "ignore" });
  else execFileSync("xdg-open", [path], { stdio: "ignore" });
}
