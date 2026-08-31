export const CHILD_BRIDGE_EXTENSION_PATH = "<inline:olive-agent-bridge>";

/** Keep the child-return bridge alongside the parent extension allow-list. */
export function keepChildExtension(extensionPath, parentExtensionPaths) {
  return extensionPath === CHILD_BRIDGE_EXTENSION_PATH || parentExtensionPaths.includes(extensionPath);
}
