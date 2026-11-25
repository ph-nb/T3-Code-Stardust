// @effect-diagnostics nodeBuiltinImport:off -- Build-time compatibility inventory; no backend runtime is started.
import * as NodeFSP from "node:fs/promises";
import ts from "typescript-legacy";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { WsRpcGroup } from "@t3tools/contracts";

const source = await NodeFSP.readFile(
  new URL("../packages/contracts/src/ipc.ts", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile("ipc.ts", source, ts.ScriptTarget.Latest, true);
const interfaces = new Map(
  tree.statements.filter(ts.isInterfaceDeclaration).map((item) => [item.name.text, item]),
);
function methods(name: string, prefix = "", visited = new Set<string>()): string[] {
  if (visited.has(name)) return [];
  const declaration = interfaces.get(name);
  if (!declaration) return [];
  const next = new Set([...visited, name]);
  return declaration.members.flatMap((member) => {
    if (!member.name || !ts.isIdentifier(member.name)) return [];
    const path = `${prefix}${member.name.text}`;
    if (ts.isMethodSignature(member)) return [path];
    if (!ts.isPropertySignature(member) || !member.type) return [];
    if (ts.isFunctionTypeNode(member.type)) return [path];
    if (ts.isTypeReferenceNode(member.type) && ts.isIdentifier(member.type.typeName))
      return methods(member.type.typeName.text, `${path}.`, next);
    if (ts.isTypeLiteralNode(member.type))
      return member.type.members.flatMap((child) =>
        child.name && ts.isIdentifier(child.name) ? [`${path}.${child.name.text}`] : [],
      );
    return [];
  });
}
const inventory = {
  schemaVersion: 1,
  rpcs: [...WsRpcGroup.requests.values()]
    .map((rpc) => ({
      tag: rpc._tag,
      streaming: RpcSchema.isStreamSchema(rpc.successSchema),
    }))
    .toSorted((left, right) => left.tag.localeCompare(right.tag)),
  desktopMethods: methods("DesktopBridge").toSorted(),
};
const directory = new URL("../native/stardust/schema/", import.meta.url);
await NodeFSP.mkdir(directory, { recursive: true });
const encoded = `${JSON.stringify(inventory, null, 2)}\n`;
const destination = new URL("client-contracts.json", directory);
if (process.argv.includes("--check")) {
  if ((await NodeFSP.readFile(destination, "utf8")) !== encoded)
    throw new Error("Rust compatibility inventory is stale");
} else await NodeFSP.writeFile(destination, encoded);
