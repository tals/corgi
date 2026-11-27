import * as acorn from "acorn";
import * as walk from "acorn-walk";

type Node = acorn.AnyNode;
type Tool = { name: string; args: string[]; description: string };

function literal(node: Node | null | undefined) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
}

function property(node: Node | undefined, name: string) {
  if (node?.type !== "ObjectExpression") return;
  for (const p of node.properties)
    if (p.type === "Property" && !p.computed && (p.key.type === "Identifier" ? p.key.name : literal(p.key)) === name)
      return p.value;
}

/** A preceding const initializer in the same block as its use. */
function initializer(node: Node, parents: Node[]) {
  if (node.type !== "Identifier") return node;
  const block = parents.findLast(
    p =>
      p.type === "Program" ||
      p.type === "BlockStatement" ||
      p.type === "ArrowFunctionExpression" ||
      p.type === "FunctionExpression" ||
      p.type === "FunctionDeclaration",
  );
  if (block?.type !== "Program" && block?.type !== "BlockStatement") return;
  for (const statement of block.body) {
    if (statement.start >= node.start) break;
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const decl of statement.declarations)
      if (decl.id.type === "Identifier" && decl.id.name === node.name) return decl.init;
  }
}

/** Resolve the command argument for a literal batch such as pairs.map(([label, cmd]) => run({cmd})). */
function commands(node: Node | undefined, parents: Node[]) {
  if (!node) return [];
  const value = literal(initializer(node, parents));
  if (value != null) return [value];
  if (node?.type !== "Identifier") return [];
  const i = parents.findLastIndex(
    p => p.type === "ArrowFunctionExpression" || p.type === "FunctionExpression" || p.type === "FunctionDeclaration",
  );
  const fn = parents[i],
    map = parents[i - 1];
  if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") return [];
  if (
    map?.type !== "CallExpression" ||
    map.arguments[0] !== fn ||
    map.callee.type !== "MemberExpression" ||
    map.callee.computed ||
    map.callee.property.type !== "Identifier" ||
    map.callee.property.name !== "map"
  )
    return [];
  const parameter = fn.params[0];
  const column =
    parameter?.type === "ArrayPattern"
      ? parameter.elements.findIndex(p => p?.type === "Identifier" && p.name === node.name)
      : -1;
  if (column < 0 && !(parameter?.type === "Identifier" && parameter.name === node.name)) return [];
  const batch = initializer(map.callee.object, parents.slice(0, i - 1));
  if (batch?.type !== "ArrayExpression") return [];
  return batch.elements.flatMap(row => {
    const cmd = literal(column < 0 ? row : row?.type === "ArrayExpression" ? row.elements[column] : null);
    return cmd ? [cmd] : [];
  });
}

/** Inspect tool invocations without executing code or treating its quoted strings as calls. */
export function read(code: string): Tool[] {
  const tools: Tool[] = [];
  try {
    if (!code.includes("tools.") || code.length > 256 * 1024) return [];
    const tree = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
    walk.ancestor(tree, {
      CallExpression(node, _, parents) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "tools" ||
          callee.property.type !== "Identifier"
        )
          return;
        const name = callee.property.name,
          input = node.arguments[0];
        const args =
          name === "exec_command"
            ? commands(property(input, "cmd"), parents)
            : name === "apply_patch"
              ? [literal(input) ?? ""]
              : [];
        const description = literal(property(input, "description")) || literal(property(input, "title")) || "";
        tools.push({ name, args, description });
      },
    });
  } catch {
    // A partial or non-JavaScript payload has no inspectable invocations.
  }
  return tools;
}
