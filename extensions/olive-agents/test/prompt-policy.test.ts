import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CHILD_BRIDGE_EXTENSION_PATH, keepChildExtension } from "../src/child-extension-filter.mjs";
import { registerPromptPolicy } from "../src/prompt-policy.mjs";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function inspectPrompt(policy: "native" | "inherit") {
  const cwd = mkdtempSync(resolve(tmpdir(), "olive-prompt-policy-"));
  workspaces.push(cwd);
  const agentDir = mkdtempSync(resolve(tmpdir(), "olive-prompt-policy-agent-"));
  workspaces.push(agentDir);

  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);

  let nativePrompt: string | undefined;
  let receivedPrompt: string | undefined;
  const bridgeFactory = (pi: any) => {
    registerPromptPolicy(pi, policy, () => nativePrompt);
  };
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: {
      additionalExtensionPaths: [resolve(process.cwd(), "extensions/muon/index.ts")],
      extensionFactories: [{ name: "olive-agent-bridge", factory: bridgeFactory }],
      noContextFiles: true,
      noPromptTemplates: true,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(cwd, cwd),
    model: faux.getModel(),
    tools: ["read"],
  });
  nativePrompt = session.systemPrompt;
  faux.setResponses([
    (context) => {
      receivedPrompt = context.systemPrompt;
      return fauxAssistantMessage("captured");
    },
  ]);

  await session.prompt("capture the effective system prompt");
  return { nativePrompt, receivedPrompt };
}

describe("child prompt policy", () => {
  it("preserves the inline /or bridge through the parent-extension allow-list", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "olive-child-bridge-"));
    workspaces.push(cwd);
    const agentDir = mkdtempSync(resolve(tmpdir(), "olive-child-bridge-agent-"));
    workspaces.push(agentDir);
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [{
          name: "olive-agent-bridge",
          factory: (pi: any) => pi.registerCommand("or", { handler: async () => {} }),
        }],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) => keepChildExtension(extension.path, [])),
        }),
        noContextFiles: true,
        noPromptTemplates: true,
      },
    });

    const bridge = services.resourceLoader.getExtensions().extensions.find(
      (extension) => extension.path === CHILD_BRIDGE_EXTENSION_PATH,
    );
    expect(bridge?.commands.has("or")).toBe(true);
  });

  it("keeps the child return command unsuffixed when Olive is inherited", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "olive-child-command-"));
    workspaces.push(cwd);
    const agentDir = mkdtempSync(resolve(tmpdir(), "olive-child-command-agent-"));
    workspaces.push(agentDir);

    const parent = SessionManager.create(cwd, cwd);
    parent.appendMessage({ role: "user", content: "parent" });
    const child = SessionManager.create(cwd, cwd, {
      id: "child-command-test",
      parentSession: parent.getSessionFile(),
    });
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const olivePath = resolve(process.cwd(), "extensions/olive-agents/index.ts");
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        additionalExtensionPaths: [olivePath],
        extensionFactories: [{
          name: "olive-agent-bridge",
          factory: (pi: any) => pi.registerCommand("or", {
            description: "Return new child context to the parent",
            handler: async () => {},
          }),
        }],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) =>
            extension.path === olivePath || keepChildExtension(extension.path, [])
          ),
        }),
        noContextFiles: true,
        noPromptTemplates: true,
        noSkills: true,
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: child,
      model: faux.getModel(),
      tools: ["read"],
    });

    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    const returnCommands = session.extensionRunner.getRegisteredCommands()
      .filter((command) => command.name === "or")
      .map((command) => ({ invocationName: command.invocationName, description: command.description }));
    expect(returnCommands).toEqual([{
      invocationName: "or",
      description: "Return new child context to the parent",
    }]);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });

  it("keeps all extensions while restoring the native Pi prompt", async () => {
    const { nativePrompt, receivedPrompt } = await inspectPrompt("native");
    expect(receivedPrompt).toBe(nativePrompt);
    expect(receivedPrompt).toContain("You are an expert coding assistant");
    expect(receivedPrompt).not.toContain("The user requires your involvement");
  });

  it("inherits the active mode prompt when no policy is selected", async () => {
    const { nativePrompt, receivedPrompt } = await inspectPrompt("inherit");
    expect(receivedPrompt).not.toBe(nativePrompt);
    expect(receivedPrompt).toContain("The user requires your involvement");
  });
});
