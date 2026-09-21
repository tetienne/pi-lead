import { createProposedChangePolicy } from "./proposed-change-policy.ts";

export type ParsedProposedChangeInput = {
  namedBase: string;
  validationTasks: string[];
  dependencyHosts: string[];
  specSource?: string;
  instruction: string;
};

export function parseProposedChangeInput(raw: string): ParsedProposedChangeInput {
  const separator = /\s--\s/.exec(raw);
  if (!separator || separator.index === undefined) {
    throw new Error("separate the instruction with --");
  }
  const optionsText = raw.slice(0, separator.index).trim();
  const instruction = raw.slice(separator.index + separator[0].length).trim();
  if (!instruction || instruction.length > 8_000) {
    throw new Error("change instruction must contain 1–8000 characters");
  }
  const tokens = optionsText.split(/\s+/).filter(Boolean);
  let namedBase: string | undefined;
  let specSource: string | undefined;
  const validationTasks: string[] = [];
  const dependencyHosts: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!value) throw new Error(`missing value for ${option ?? "option"}`);
    if (option === "--base") {
      if (namedBase !== undefined) throw new Error("--base may be provided only once");
      namedBase = value;
    } else if (option === "--spec") {
      if (specSource !== undefined) throw new Error("--spec may be provided only once");
      if (
        value.startsWith("/") ||
        value.includes("\\") ||
        value.includes("\0") ||
        value.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new Error("--spec must be a confined relative Markdown path");
      }
      specSource = value;
    } else if (option === "--check") {
      validationTasks.push(value);
    } else if (option === "--allow") {
      dependencyHosts.push(value);
    } else {
      throw new Error(`unknown change option: ${option ?? ""}`);
    }
  }
  if (!namedBase) throw new Error("change request requires --base <branch-or-tag>");
  if (validationTasks.length === 0) {
    throw new Error("change request requires at least one --check <mise-task>");
  }
  if (validationTasks.length > 8) throw new Error("change request accepts at most 8 checks");
  if (dependencyHosts.length > 16) {
    throw new Error("change request accepts at most 16 dependency hosts");
  }
  createProposedChangePolicy({
    workerId: "input-validation",
    dependencyHosts,
    validationTasks,
  });
  return { namedBase, validationTasks, dependencyHosts, ...(specSource ? { specSource } : {}), instruction };
}
