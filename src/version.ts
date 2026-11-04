/** Public package version shared by protocol metadata and checked against the package manifest. */
export const PACKAGE_VERSION = "0.1.5";

/** Describe this CLI process without reading configuration files or contacting a hub. */
export function runtimeInfo() {
  return { name: "agent-tcdh", version: PACKAGE_VERSION, node: process.versions.node, platform: process.platform, arch: process.arch };
}
