import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildFindArgv,
	buildGrepArgv,
	createToolGlobMatcher,
	DEFAULT_SEARCH_LIMITS,
	guestFind,
	guestGrep,
	parseDetectOutput,
	parseGrepRecord,
	type SearchLimits,
} from "../src/worker/guest-search.ts";
import { registerSandboxTools } from "../src/worker/sandbox-tools.ts";

type Flavor = "busybox" | "gnu";
type Call = { argv: string[]; signal: AbortSignal };
type Override = (argv: string[]) => { stdout?: Buffer[]; stderr?: string; exitCode?: number; hang?: boolean } | undefined;

/**
 * A fake Gondolin VM over an in-memory guest tree. It answers the detection
 * script, emulates `find ... -print0` and a GNU-style `grep -n -H [-C N]`
 * (the regex runs here, in the test, standing in for the guest).
 */
function fakeVm(files: Record<string, string>, options: { flavor?: Flavor; override?: Override; chunkBytes?: number } = {}) {
	const flavor = options.flavor ?? "busybox";
	const calls: Call[] = [];
	const isDir = (p: string) => Object.keys(files).some((file) => file.startsWith(`${p}/`));
	const run = (argv: string[]): { stdout: Buffer[]; stderr?: string; exitCode: number; hang?: boolean } => {
		const override = options.override?.(argv);
		if (override) return { stdout: override.stdout ?? [], stderr: override.stderr, exitCode: override.exitCode ?? 0, hang: override.hang };
		if (argv[0] === "/bin/sh") {
			const out = flavor === "gnu" ? "grep=/usr/bin/grep\nfind=/usr/bin/find\nI=1\nP=1\n" : "grep=/bin/grep\nfind=/usr/bin/find\nI=1\nP=2\n";
			return { stdout: [Buffer.from(out)], exitCode: 0 };
		}
		if (argv[0]!.endsWith("/find")) {
			const root = argv[1]!;
			const listed = Object.keys(files).filter(
				(file) => file.startsWith(`${root}/`) && !file.slice(root.length).split("/").some((part) => part === ".git" || part === "node_modules"),
			);
			return { stdout: [Buffer.from(listed.map((file) => `${file}\0`).join(""))], exitCode: 0 };
		}
		if (argv[0]!.endsWith("/grep")) return emulateGrep(argv);
		throw new Error(`unexpected argv ${argv.join(" ")}`);
	};
	const emulateGrep = (argv: string[]) => {
		const dashDash = argv.indexOf("--");
		const flags = argv.slice(1, dashDash);
		const targets = argv.slice(dashDash + 1);
		const pattern = flags[flags.indexOf("-e") + 1]!;
		const contextIndex = flags.indexOf("-C");
		const context = contextIndex >= 0 ? Number(flags[contextIndex + 1]) : 0;
		const ignoreCase = flags.includes("-i");
		const matcher = flags.includes("-F")
			? (line: string) => (ignoreCase ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern))
			: ((regex: RegExp) => (line: string) => regex.test(line))(new RegExp(pattern, ignoreCase ? "i" : ""));
		const out: string[] = [];
		let any = false;
		for (const target of targets) {
			const lines = (files[target] ?? "").split("\n");
			if (lines.at(-1) === "") lines.pop();
			const printed = new Set<number>();
			const matched = lines.map((line) => matcher(line));
			let lastPrinted = -1;
			matched.forEach((isMatch, index) => {
				if (!isMatch) return;
				any = true;
				for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) {
					if (printed.has(i)) continue;
					if (context > 0 && lastPrinted >= 0 && i > lastPrinted + 1) out.push("--");
					printed.add(i);
					lastPrinted = i;
					const sep = matched[i] ? ":" : "-";
					out.push(`${target}${sep}${i + 1}${sep}${lines[i]}`);
				}
			});
		}
		const text = out.length ? `${out.join("\n")}\n` : "";
		const buffer = Buffer.from(text);
		const size = options.chunkBytes ?? 7;
		const chunks: Buffer[] = [];
		for (let i = 0; i < buffer.length; i += size) chunks.push(buffer.subarray(i, i + size));
		return { stdout: chunks, exitCode: any ? 0 : 1 };
	};
	const vm = {
		fs: {
			stat: async (p: string) => {
				if (!(p in files) && !isDir(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				return { isDirectory: () => isDir(p) };
			},
			access: async (p: string) => {
				if (!(p in files) && !isDir(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
			readFile: async () => {
				throw new Error("the host must not read guest files");
			},
			listDir: async () => {
				throw new Error("the host must not walk the guest tree");
			},
		},
		exec(argv: string[], execOptions: { signal: AbortSignal; env?: Record<string, string> }) {
			assert.ok(Array.isArray(argv), "argv form only");
			const signal = execOptions.signal;
			calls.push({ argv, signal });
			const spec = run(argv);
			const aborted = new Promise<never>((_, reject) => {
				if (signal.aborted) reject(new Error("aborted"));
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			aborted.catch(() => {});
			const result: Promise<{ exitCode: number }> = spec.hang ? aborted : Promise.resolve({ exitCode: spec.exitCode });
			result.catch(() => {});
			return {
				async *output() {
					for (const data of spec.stdout) {
						if (signal.aborted) throw new Error("aborted");
						yield { stream: "stdout" as const, data, text: data.toString() };
					}
					if (spec.stderr) yield { stream: "stderr" as const, data: Buffer.from(spec.stderr), text: spec.stderr };
					if (spec.hang) await aborted;
				},
				then: (onFulfilled: any, onRejected: any) => result.then(onFulfilled, onRejected),
				catch: (onRejected: any) => result.catch(onRejected),
			};
		},
	};
	return { vm: vm as any, calls };
}

const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join("");
const grepCalls = (calls: Call[]) => calls.filter((call) => call.argv[0]!.endsWith("/grep"));

test("grep runs in the guest with the pattern after -e and the files after --", async () => {
	for (const pattern of ["$(rm -rf /)", "-e foo", "--include=*", "`id`; echo pwned"]) {
		const { vm, calls } = fakeVm({ "/workspace/a.txt": `x\n${pattern}\n` });
		const result = await guestGrep(vm, { root: "/workspace", pattern, literal: true });
		assert.equal(text(result), `a.txt:2: ${pattern}`);
		const [grep] = grepCalls(calls);
		const argv = grep!.argv;
		assert.equal(argv[0], "/bin/grep", "absolute path, no shell");
		assert.equal(argv[argv.indexOf("-e") + 1], pattern);
		assert.ok(argv.indexOf("-e") < argv.indexOf("--"));
		assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["/workspace/a.txt"]);
		for (const call of calls) assert.ok(!call.argv.slice(0, 3).join(" ").includes(pattern), "pattern never reaches a shell script");
	}
});

test("grep flags follow the detected guest grep: ERE on BusyBox, PCRE and -I on GNU", () => {
	const busybox = parseDetectOutput("grep=/bin/grep\nfind=/usr/bin/find\nI=1\nP=2\n");
	const gnu = parseDetectOutput("grep=/usr/bin/grep\nfind=/usr/bin/find\nI=1\nP=1\n");
	assert.deepEqual(buildGrepArgv(busybox, { pattern: "a|b", context: 0 }, ["/w/f"]), ["/bin/grep", "-n", "-H", "-s", "-I", "-E", "-e", "a|b", "--", "/w/f"]);
	assert.deepEqual(buildGrepArgv(gnu, { pattern: "\\d+", ignoreCase: true, context: 2 }, ["/w/f"]), [
		"/usr/bin/grep", "-n", "-H", "-s", "-I", "-i", "-P", "-C", "2", "-e", "\\d+", "--", "/w/f",
	]);
	assert.ok(buildGrepArgv(gnu, { pattern: "a.b", literal: true, context: 0 }, ["/w/f"]).includes("-F"));
	assert.throws(() => parseDetectOutput("grep=\nfind=/usr/bin/find\n"), /grep is not available/);
	assert.throws(() => buildGrepArgv(gnu, { pattern: "x", context: 0 }, ["-rf"]), /absolute guest path/);
});

test("find lists without following symlinks, pruning .git and node_modules", () => {
	assert.deepEqual(buildFindArgv("/usr/bin/find", "/workspace", true), [
		"/usr/bin/find", "/workspace", "-mindepth", "1", "(", "-name", ".git", "-o", "-name", "node_modules", ")", "-prune", "-o", "-type", "f", "-print0",
	]);
	assert.ok(!buildFindArgv("/usr/bin/find", "/workspace", false).some((arg) => arg === "-L" || arg === "-follow"));
	assert.throws(() => buildFindArgv("/usr/bin/find", "-delete", true), /absolute guest path/);
});

test("grep output matches Pi's format, with a block per match and context lines marked -", async () => {
	const { vm } = fakeVm({
		"/workspace/src/a.ts": "one\nfoo 1\ntwo\nfoo 2\nthree\nfour\nfive\n",
		"/workspace/src/b.ts": "nothing\n",
		"/workspace/node_modules/x/c.ts": "foo\n",
		"/workspace/.git/HEAD": "foo\n",
	});
	assert.equal(text(await guestGrep(vm, { root: "/workspace", pattern: "foo \\d" })), "src/a.ts:2: foo 1\nsrc/a.ts:4: foo 2");
	assert.equal(
		text(await guestGrep(vm, { root: "/workspace", pattern: "foo", context: 1 })),
		["src/a.ts-1- one", "src/a.ts:2: foo 1", "src/a.ts-3- two", "src/a.ts-3- two", "src/a.ts:4: foo 2", "src/a.ts-5- three"].join("\n"),
	);
	assert.equal(text(await guestGrep(vm, { root: "/workspace/src/a.ts", pattern: "FOO 2", ignoreCase: true })), "a.ts:4: foo 2");
	assert.equal(text(await guestGrep(vm, { root: "/workspace", pattern: "absent" })), "No matches found");
	await assert.rejects(guestGrep(vm, { root: "/workspace/missing", pattern: "x" }), /Path not found: \/workspace\/missing/);
});

test("grep file names containing : and - are parsed against the names grep was given", async () => {
	const names = new Set(["/w/a:1:b.ts", "/w/c-2-d"]);
	assert.deepEqual(parseGrepRecord("/w/a:1:b.ts:7:hit", names, 12), { file: "/w/a:1:b.ts", line: 7, isMatch: true, text: "hit" });
	assert.deepEqual(parseGrepRecord("/w/c-2-d-3-ctx", names, 12), { file: "/w/c-2-d", line: 3, isMatch: false, text: "ctx" });
	assert.equal(parseGrepRecord("--", names, 12), undefined);
	const { vm } = fakeVm({ "/workspace/x:1:y.txt": "a\nneedle\n" });
	assert.equal(text(await guestGrep(vm, { root: "/workspace", pattern: "needle" })), "x:1:y.txt:2: needle");
});

test("grep glob filters files on the host before the guest grep runs", async () => {
	const { vm, calls } = fakeVm({
		"/workspace/src/a.ts": "hit\n",
		"/workspace/src/a.tsx": "hit\n",
		"/workspace/src/a.spec.ts": "hit\n",
		"/workspace/README.md": "hit\n",
	});
	assert.equal(text(await guestGrep(vm, { root: "/workspace", pattern: "hit", glob: "*.{ts,tsx}" })), "src/a.ts:1: hit\nsrc/a.tsx:1: hit\nsrc/a.spec.ts:1: hit");
	const argv = grepCalls(calls)[0]!.argv;
	assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["/workspace/src/a.ts", "/workspace/src/a.tsx", "/workspace/src/a.spec.ts"]);
	assert.equal(text(await guestGrep(vm, { root: "/workspace", pattern: "hit", glob: "src/**/*.spec.ts" })), "src/a.spec.ts:1: hit");
	assert.equal(text(await guestGrep(vm, { root: "/workspace", pattern: "hit", glob: "*.py" })), "No matches found");
});

test("grep stops the guest process at the match limit and reports it like Pi", async () => {
	const many = Array.from({ length: 50 }, (_, i) => `hit ${i}`).join("\n");
	const { vm, calls } = fakeVm({ "/workspace/a.txt": many, "/workspace/b.txt": many });
	const result = await guestGrep(vm, { root: "/workspace", pattern: "hit", limit: 3 });
	assert.equal(text(result), "a.txt:1: hit 0\na.txt:2: hit 1\na.txt:3: hit 2\n\n[3 matches limit reached. Use limit=6 for more, or refine pattern]");
	assert.equal(result.details?.matchLimitReached, 3);
	assert.ok(grepCalls(calls)[0]!.signal.aborted, "the guest grep is killed once the limit is reached");

	const withContext = await guestGrep(vm, { root: "/workspace", pattern: "hit", limit: 2, context: 1 });
	assert.equal(text(withContext).split("\n\n")[0], "a.txt:1: hit 0\na.txt-2- hit 1\na.txt-1- hit 0\na.txt:2: hit 1\na.txt-3- hit 2");
});

test("grep batches files and stops before later batches once the limit is reached", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 10; i++) files[`/workspace/f${i}.txt`] = "hit\n";
	const { vm, calls } = fakeVm(files);
	const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, batchFiles: 3 };
	const result = await guestGrep(vm, { root: "/workspace", pattern: "hit", limit: 4 }, undefined, limits);
	assert.equal(text(result).split("\n\n")[0]!.split("\n").length, 4);
	const batches = grepCalls(calls).map((call) => call.argv.slice(call.argv.indexOf("--") + 1).length);
	assert.deepEqual(batches, [3, 3]);
});

test("grep keeps only a bounded prefix of huge lines and truncates them like Pi", async () => {
	const huge = `needle${"x".repeat(2 * 1024 * 1024)}`;
	const { vm } = fakeVm({ "/workspace/min.js": `${huge}\n` }, { chunkBytes: 64 * 1024 });
	const result = await guestGrep(vm, { root: "/workspace", pattern: "needle" });
	const [line, notice] = text(result).split("\n\n");
	assert.equal(line, `min.js:1: needle${"x".repeat(494)}... [truncated]`);
	assert.equal(notice, "[Some lines truncated to 500 chars. Use read tool to see full lines]");
	assert.equal(result.details?.linesTruncated, true);
});

test("grep stops at Pi's byte limit instead of buffering every match", async () => {
	const body = Array.from({ length: 5000 }, (_, i) => `hit ${i} ${"y".repeat(400)}`).join("\n");
	const { vm, calls } = fakeVm({ "/workspace/big.txt": body }, { chunkBytes: 4096 });
	const result = await guestGrep(vm, { root: "/workspace", pattern: "hit", limit: 100_000 });
	const output = text(result);
	assert.match(output, /\[50\.0KB limit reached\]$/);
	assert.ok(Buffer.byteLength(output) < 60 * 1024);
	assert.ok(grepCalls(calls)[0]!.signal.aborted);
	assert.ok(result.details?.truncation?.truncated);
});

test("grep surfaces guest grep errors and times out a stuck guest process", async () => {
	const bad = fakeVm({ "/workspace/a.txt": "x\n" }, {
		override: (argv) => (argv[0] === "/bin/grep" ? { exitCode: 2, stderr: "grep: bad regex '(': Missing ')'" } : undefined),
	});
	await assert.rejects(guestGrep(bad.vm, { root: "/workspace", pattern: "(" }), /bad regex/);

	const stuck = fakeVm({ "/workspace/a.txt": "aaaa\n" }, { override: (argv) => (argv[0] === "/bin/grep" ? { hang: true } : undefined) });
	const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, timeoutMs: 50 };
	await assert.rejects(guestGrep(stuck.vm, { root: "/workspace", pattern: "(a+)+$" }, undefined, limits), /timed out/);
	assert.ok(grepCalls(stuck.calls)[0]!.signal.aborted, "the guest process is killed on timeout");

	const controller = new AbortController();
	const pending = guestGrep(stuck.vm, { root: "/workspace", pattern: "a" }, controller.signal);
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(pending, /Operation aborted/);
	await assert.rejects(guestGrep(stuck.vm, { root: "/workspace", pattern: "x".repeat(20_000) }), /Pattern is longer/);
});

test("the file scan is capped in count and bytes", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 20; i++) files[`/workspace/f${String(i).padStart(2, "0")}.txt`] = "hit\n";
	files[`/workspace/${"d".repeat(300)}.txt`] = "hit\n";
	const { vm, calls } = fakeVm(files);
	const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxScanFiles: 5, maxPathBytes: 200 };
	const result = await guestGrep(vm, { root: "/workspace", pattern: "hit" }, undefined, limits);
	assert.equal(text(result).split("\n\n")[0]!.split("\n").length, 5);
	assert.match(text(result), /File scan stopped after 5 files/);
	assert.ok(calls.find((call) => call.argv[0] === "/usr/bin/find")!.signal.aborted);

	const long = fakeVm({ [`/workspace/${"d".repeat(300)}.txt`]: "hit\n", "/workspace/ok.txt": "hit\n" });
	assert.equal(text(await guestGrep(long.vm, { root: "/workspace", pattern: "hit" }, undefined, limits)), "ok.txt:1: hit", "over-long paths are skipped");

	const bytes = fakeVm(files);
	const byteLimits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxScanBytes: 60 };
	assert.match(text(await guestGrep(bytes.vm, { root: "/workspace", pattern: "hit" }, undefined, byteLimits)), /^f00\.txt:1: hit\nf01\.txt:1: hit\nf02\.txt:1: hit\n\n\[File scan stopped/);
});

test("find matches globs on the guest listing and honours the limit", async () => {
	const { vm, calls } = fakeVm({
		"/workspace/src/a.ts": "",
		"/workspace/src/deep/b.spec.ts": "",
		"/workspace/src/.hidden.ts": "",
		"/workspace/node_modules/x/c.ts": "",
		"/workspace/README.md": "",
	});
	assert.deepEqual(await guestFind(vm, "/workspace", "*.ts", 100), ["src/a.ts", "src/deep/b.spec.ts", "src/.hidden.ts"]);
	assert.deepEqual(await guestFind(vm, "/workspace", "src/**/*.spec.ts", 100), ["src/deep/b.spec.ts"]);
	assert.deepEqual(await guestFind(vm, "/workspace/src", "deep/*.ts", 100), ["deep/b.spec.ts"]);
	assert.deepEqual(await guestFind(vm, "/workspace", "*.ts", 1), ["src/a.ts"]);
	assert.ok(calls.at(-1)!.signal.aborted, "listing stops at the limit");
	assert.deepEqual(await guestFind(vm, "/workspace/README.md", "*.md", 10), ["README.md"]);
	const findArgv = calls.find((call) => call.argv[0] === "/usr/bin/find")!.argv;
	assert.deepEqual(findArgv.slice(-4), ["!", "-type", "d", "-print0"]);
});

test("the glob matcher is linear: no regex, no backtracking blow-up", () => {
	const match = createToolGlobMatcher("*.{ts,tsx}");
	assert.ok(match("src/a.ts") && match("a.tsx") && !match("a.js"));
	const spec = createToolGlobMatcher("src/**/*.spec.ts");
	assert.ok(spec("src/a.spec.ts") && spec("src/x/y/a.spec.ts") && spec("pkg/src/a.spec.ts") && !spec("lib/a.spec.ts"));
	const cls = createToolGlobMatcher("file[0-9]?.[!j]s");
	assert.ok(cls("file12.ts") && !cls("file12.js") && !cls("fileA2.ts"));
	assert.ok(createToolGlobMatcher("\\*.txt")("*.txt") && !createToolGlobMatcher("\\*.txt")("a.txt"));
	assert.ok(createToolGlobMatcher("{a}.txt")("{a}.txt"));

	const evil = createToolGlobMatcher(`${"*a".repeat(30)}*b`);
	const deep = createToolGlobMatcher(`${"**/".repeat(40)}*b`);
	const name = "a".repeat(255);
	const started = Date.now();
	assert.equal(evil(name), false);
	assert.equal(deep(Array.from({ length: 200 }, () => name).join("/")), false);
	assert.ok(Date.now() - started < 1000, "pathological globs stay cheap");
	assert.throws(() => createToolGlobMatcher("x".repeat(2000)), /longer than/);
	assert.throws(() => createToolGlobMatcher("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}"), /too many alternatives/);
});

test("the registered grep and find tools map tool paths to guest paths and never touch vm.fs content", async () => {
	const { vm, calls } = fakeVm({ "/workspace/src/a.ts": "const needle = 1;\n", "/workspace/lib/b.ts": "needle\n" });
	const tools = new Map<string, any>();
	const pi: any = { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {} };
	registerSandboxTools(pi, "/host/clone", async () => ({ vm, shellPath: "/bin/sh", env: {}, root: "/host/clone" }));

	const grep = await tools.get("grep").execute("id", { pattern: "needle", path: "src" }, undefined, undefined, {});
	assert.equal(text(grep), "a.ts:1: const needle = 1;");
	assert.equal(grepCalls(calls).at(-1)!.argv.at(-1), "/workspace/src/a.ts");

	const hostAbsolute = await tools.get("grep").execute("id", { pattern: "needle", path: "/host/clone/lib" }, undefined, undefined, {});
	assert.equal(text(hostAbsolute), "b.ts:1: needle");

	const find = await tools.get("find").execute("id", { pattern: "*.ts" }, undefined, undefined, {});
	assert.equal(text(find), "src/a.ts\nlib/b.ts");
});
