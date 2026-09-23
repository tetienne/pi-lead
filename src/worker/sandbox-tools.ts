/**
 * Pi's built-in tools routed into a Gondolin VM. The file-operation adapters
 * are taken from Pi's official `examples/extensions/gondolin` (v0.86.1); the
 * registration differs: the host path mounted at /workspace is a disposable
 * clone, never the user's checkout. `grep` and `find` differ too: the example
 * walks the guest tree from the host and runs the regex over guest content in
 * this process; here both run inside the guest (guest-search.ts).
 */
import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { GUEST_WORKSPACE } from "../sandbox.ts";
import { guestFind, guestGrep } from "./guest-search.ts";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		// Listed and matched inside the guest (see guest-search.ts); the host
		// never walks the guest tree itself.
		glob: async (pattern, cwd, options) => guestFind(vm, toGuestPath(localCwd, cwd), pattern, options.limit),
	};
}

/**
 * Called with each shell command, its exit code (-1 when it did not complete)
 * and the last `OUTPUT_TAIL` characters of its output.
 */
export type CommandListener = (command: string, exitCode: number, outputTail: string) => void;

export const OUTPUT_TAIL = 1_000;

/** Env assignments and wrappers that may precede a test runner in a shell segment. */
const RUNNER_PREFIX = String.raw`^(?:\w+=\S*\s+)*(?:(?:npx|bunx|uvx|env|time|timeout\s+\S+|(?:pnpm|bundle|poetry|uv|pipenv|yarn)\s+(?:exec|run))\s+)*`;
const TEST_SEGMENTS = [
	String.raw`(?:\S*/)?(?:vitest|jest|pytest|mocha|rspec|phpunit|ctest|tox|nox)\b`,
	String.raw`(?:\S*/)?(?:cargo|go|mix|dotnet|deno|bun|swift|zig|gradle|gradlew|mvn|make|just)\s+test\b`,
	String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|spec|check|typecheck|verify)\b`,
	String.raw`node\s+(?:--\S+\s+)*--test\b`,
	String.raw`python3?\s+-m\s+(?:pytest|unittest)\b`,
	String.raw`mise\s+run\s+(?:test|check)\b`,
].map((pattern) => new RegExp(RUNNER_PREFIX + pattern));

/**
 * Heuristic: does this shell command run a test suite or a project check?
 * It only picks which command's exit code is shown to Jev as evidence. A
 * runner must start a segment of the command line: named in quotes (a commit
 * message, an echo) or as an argument (`npm install -D vitest`, `grep jest`)
 * it does not count, or a later `git commit` would pass for a green run.
 */
export function isTestCommand(command: string): boolean {
	const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
	return unquoted
		.split(/&&|\|\||[;&|\n()]/)
		.some((segment) => TEST_SEGMENTS.some((pattern) => pattern.test(segment.trim())));
}

function createGondolinBashOps(
	vm: VM,
	localCwd: string,
	shellPath: string,
	guestEnv: Record<string, string>,
	onCommand?: CommandListener,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			let tail = "";
			const decoder = new TextDecoder();
			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: guestEnv,
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of proc.output()) {
					onData(chunk.data);
					if (onCommand) tail = (tail + decoder.decode(chunk.data, { stream: true })).slice(-OUTPUT_TAIL);
				}
				const result = await proc;
				onCommand?.(command, result.exitCode, tail);
				return { exitCode: result.exitCode };
			} catch (error) {
				onCommand?.(command, -1, tail);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

/** A running sandbox; `root` is the host directory mounted at /workspace. */
export type SandboxHandle = { vm: VM; shellPath: string; env: Record<string, string>; root: string };

/**
 * Re-register Pi's file and shell tools so every model-driven action runs in
 * the VM. The worker is started with `--no-builtin-tools`, so these are the
 * only tools of those names. `localCwd` (Pi's own cwd) only shapes the tool
 * definitions; paths are mapped against the sandbox's `root`. `onCommand`
 * sees every shell command, from the model or typed with `!` in the tab.
 */
export function registerSandboxTools(
  pi: ExtensionAPI,
  localCwd: string,
  ensureVm: (ctx?: ExtensionContext) => Promise<SandboxHandle>,
  onCommand?: CommandListener,
): void {
  const templates = {
    read: createReadTool(localCwd),
    write: createWriteTool(localCwd),
    edit: createEditTool(localCwd),
    bash: createBashTool(localCwd),
    grep: createGrepTool(localCwd),
    find: createFindTool(localCwd),
    ls: createLsTool(localCwd),
  };

  pi.registerTool({
    ...templates.read,
    async execute(id, params, signal, onUpdate, ctx) {
      const { vm, root } = await ensureVm(ctx);
      return createReadTool(GUEST_WORKSPACE, { operations: createGondolinReadOps(vm, root) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...templates.write,
    async execute(id, params, signal, onUpdate, ctx) {
      const { vm, root } = await ensureVm(ctx);
      return createWriteTool(GUEST_WORKSPACE, { operations: createGondolinWriteOps(vm, root) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...templates.edit,
    async execute(id, params, signal, onUpdate, ctx) {
      const { vm, root } = await ensureVm(ctx);
      return createEditTool(GUEST_WORKSPACE, { operations: createGondolinEditOps(vm, root) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...templates.bash,
    async execute(id, params, signal, onUpdate, ctx) {
      const { vm, shellPath, env, root } = await ensureVm(ctx);
      return createBashTool(GUEST_WORKSPACE, { operations: createGondolinBashOps(vm, root, shellPath, env, onCommand) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...templates.ls,
    async execute(id, params, signal, onUpdate, ctx) {
      const { vm, root } = await ensureVm(ctx);
      return createLsTool(GUEST_WORKSPACE, { operations: createGondolinLsOps(vm, root) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...templates.find,
    async execute(id, params, signal, onUpdate, ctx) {
      const { vm, root } = await ensureVm(ctx);
      return createFindTool(GUEST_WORKSPACE, { operations: createGondolinFindOps(vm, root) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...templates.grep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { vm, root } = await ensureVm(ctx);
      return guestGrep(vm, { ...params, root: toGuestPath(root, params.path ?? ".") }, signal);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const { vm, shellPath, env, root } = await ensureVm(ctx);
    return { operations: createGondolinBashOps(vm, root, shellPath, env, onCommand) };
  });
}
