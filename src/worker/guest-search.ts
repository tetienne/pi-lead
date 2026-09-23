/**
 * `grep` and `find` for the sandboxed worker, run inside the Gondolin guest.
 *
 * The guest is untrusted (model-driven code runs there), so the host never
 * reads guest files or runs a regular expression over guest content: the
 * guest's own `find` lists files (no symlink following, .git/node_modules
 * pruned) and the guest's own `grep` matches them. The host only consumes
 * their output as a bounded stream: every record is capped in size, the
 * number of listed files and bytes is capped, the search stops once the
 * match or byte limit is reached, and every guest process is time-boxed.
 * Glob filters are applied on the host with a linear-time matcher (no
 * regex), because BusyBox `find` cannot express `**` or `{a,b}`.
 *
 * Portable across BusyBox (the default Alpine image) and GNU (the Debian
 * image): only `-n -H -s -i -F -E -C -e --` are assumed; `-I` (skip binary
 * files) and `-P` (PCRE, closer to ripgrep's syntax than ERE) are detected
 * once per VM. Patterns and paths only ever travel as argv entries, after
 * `-e` and `--`, never through a shell string.
 */
import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	type GrepToolDetails,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";

/** Same value as Pi's (not exported) GREP_MAX_LINE_LENGTH. */
export const GREP_MAX_LINE_LENGTH = 500;
export const DEFAULT_GREP_LIMIT = 100;

export type SearchLimits = {
	/** Files listed by the guest `find` before the scan stops. */
	maxScanFiles: number;
	/** Bytes of `find` output read before the scan stops. */
	maxScanBytes: number;
	/** Paths longer than this (bytes) are skipped. */
	maxPathBytes: number;
	/** Bytes of one grep output line kept by the host; the rest is dropped. */
	maxRecordBytes: number;
	/** argv budget of one guest grep invocation. */
	batchBytes: number;
	batchFiles: number;
	/** Wall-clock budget for the whole search (all guest processes). */
	timeoutMs: number;
	maxPatternBytes: number;
	maxGlobLength: number;
};

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
	maxScanFiles: 100_000,
	maxScanBytes: 16 * 1024 * 1024,
	maxPathBytes: 4096,
	maxRecordBytes: 16 * 1024,
	batchBytes: 128 * 1024,
	batchFiles: 1000,
	timeoutMs: 60_000,
	maxPatternBytes: 16 * 1024,
	maxGlobLength: 1024,
};

/** The subset of a Gondolin VM the search needs (tests pass a fake). */
export type SearchVm = Pick<VM, "exec" | "fs">;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

/** Fixed environment: a C locale keeps grep from classifying non-UTF-8 files as binary. */
const SEARCH_ENV = { LC_ALL: "C", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
const MAX_STDERR = 4096;
const DETECT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Guest process plumbing

type GuestRun = { exitCode: number | undefined; stderr: string; stopped: boolean };

class Deadline {
	private readonly ms: number;
	private readonly end: number;
	constructor(ms: number) {
		this.ms = ms;
		this.end = Date.now() + ms;
	}
	remaining(): number {
		const left = this.end - Date.now();
		if (left <= 0) throw new Error(`Search timed out after ${this.ms}ms`);
		return left;
	}
}

/**
 * Run argv in the guest, streaming stdout to `onStdout` (return false to stop
 * the process early). stderr is kept up to MAX_STDERR characters.
 */
async function runGuest(
	vm: SearchVm,
	argv: string[],
	options: { signal?: AbortSignal; timeoutMs: number; onStdout: (chunk: Buffer) => boolean },
): Promise<GuestRun> {
	if (options.signal?.aborted) throw new Error("Operation aborted");
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);
	let stopped = false;
	let stderr = "";
	const failure = (error: unknown) => {
		if (options.signal?.aborted) return new Error("Operation aborted");
		if (timedOut) return new Error(`Search timed out after ${options.timeoutMs}ms`);
		return error instanceof Error ? error : new Error(String(error));
	};
	try {
		const proc = vm.exec(argv, {
			env: SEARCH_ENV,
			signal: controller.signal,
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			for await (const chunk of proc.output()) {
				if (chunk.stream === "stderr") {
					if (stderr.length < MAX_STDERR) stderr += chunk.data.toString("utf8").slice(0, MAX_STDERR - stderr.length);
					continue;
				}
				if (!options.onStdout(chunk.data)) {
					stopped = true;
					break;
				}
			}
		} catch (error) {
			if (!stopped) throw error;
		}
		if (stopped) {
			controller.abort();
			proc.catch(() => {});
			return { exitCode: undefined, stderr, stopped };
		}
		const result = await proc;
		if (timedOut || options.signal?.aborted) throw new Error("interrupted");
		return { exitCode: result.exitCode, stderr, stopped };
	} catch (error) {
		throw failure(error);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Splits a byte stream into records on `separator`, keeping at most
 * `maxBytes` of each record (the rest is dropped and the record marked cut),
 * so a single huge line cannot grow host memory.
 */
class RecordSplitter {
	private parts: Buffer[] = [];
	private size = 0;
	private cut = false;
	private readonly separator: number;
	private readonly maxBytes: number;
	private readonly emit: (record: Buffer, cut: boolean) => boolean;

	constructor(separator: number, maxBytes: number, emit: (record: Buffer, cut: boolean) => boolean) {
		this.separator = separator;
		this.maxBytes = maxBytes;
		this.emit = emit;
	}

	push(chunk: Buffer): boolean {
		let start = 0;
		while (start <= chunk.length) {
			const index = chunk.indexOf(this.separator, start);
			const end = index === -1 ? chunk.length : index;
			this.append(chunk.subarray(start, end));
			if (index === -1) return true;
			if (!this.flush()) return false;
			start = index + 1;
		}
		return true;
	}

	end(): boolean {
		return this.size > 0 || this.cut ? this.flush() : true;
	}

	private append(part: Buffer): void {
		if (part.length === 0) return;
		const room = this.maxBytes - this.size;
		if (part.length > room) {
			this.cut = true;
			part = part.subarray(0, Math.max(0, room));
		}
		if (part.length === 0) return;
		this.parts.push(Buffer.from(part));
		this.size += part.length;
	}

	private flush(): boolean {
		const record = Buffer.concat(this.parts, this.size);
		const cut = this.cut;
		this.parts = [];
		this.size = 0;
		this.cut = false;
		return this.emit(record, cut);
	}
}

// ---------------------------------------------------------------------------
// Tool detection

export type GuestSearchTools = {
	grep: string;
	find: string;
	/** grep accepts -I (skip binary files). */
	skipBinary: boolean;
	/** grep accepts -P (PCRE). */
	perl: boolean;
};

/** Constant script: no caller data reaches it. Exit status 1 of `grep -X -e x /dev/null` means "flag accepted, no match". */
const DETECT_SCRIPT = [
	'g=$(command -v grep 2>/dev/null) || g=""',
	'f=$(command -v find 2>/dev/null) || f=""',
	'echo "grep=$g"',
	'echo "find=$f"',
	'if [ -n "$g" ]; then',
	'  "$g" -I -e x -- /dev/null >/dev/null 2>&1; echo "I=$?"',
	'  "$g" -P -e x -- /dev/null >/dev/null 2>&1; echo "P=$?"',
	"fi",
].join("\n");

const toolCache = new WeakMap<object, Promise<GuestSearchTools>>();

export function parseDetectOutput(stdout: string): GuestSearchTools {
	const values = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	const grep = values.get("grep") ?? "";
	const find = values.get("find") ?? "";
	if (!grep.startsWith("/")) throw new Error("grep is not available in the sandbox image");
	if (!find.startsWith("/")) throw new Error("find is not available in the sandbox image");
	return { grep, find, skipBinary: values.get("I") === "1", perl: values.get("P") === "1" };
}

export function detectGuestSearchTools(vm: SearchVm, signal?: AbortSignal): Promise<GuestSearchTools> {
	let cached = toolCache.get(vm);
	if (!cached) {
		cached = (async () => {
			let stdout = "";
			await runGuest(vm, ["/bin/sh", "-c", DETECT_SCRIPT], {
				signal,
				timeoutMs: DETECT_TIMEOUT_MS,
				onStdout: (chunk) => {
					stdout += chunk.toString("utf8");
					return stdout.length < 64 * 1024;
				},
			});
			return parseDetectOutput(stdout);
		})();
		toolCache.set(vm, cached);
		cached.catch(() => toolCache.delete(vm));
	}
	return cached;
}

// ---------------------------------------------------------------------------
// File listing

function assertGuestPath(value: string): void {
	if (!value.startsWith("/")) throw new Error(`Expected an absolute guest path: ${value}`);
}

/** argv of the guest listing: symlinks are not followed (find's default -P), .git and node_modules are pruned. */
export function buildFindArgv(findPath: string, root: string, regularFilesOnly: boolean): string[] {
	assertGuestPath(root);
	return [
		findPath,
		root,
		"-mindepth",
		"1",
		"(",
		"-name",
		".git",
		"-o",
		"-name",
		"node_modules",
		")",
		"-prune",
		"-o",
		...(regularFilesOnly ? ["-type", "f"] : ["!", "-type", "d"]),
		"-print0",
	];
}

type ListResult = { scanLimitReached: boolean };

async function listGuestFiles(
	vm: SearchVm,
	tools: GuestSearchTools,
	root: string,
	options: {
		regularFilesOnly: boolean;
		signal?: AbortSignal;
		limits: SearchLimits;
		deadline: Deadline;
		/** Return false to stop listing. */
		onFile: (guestPath: string) => boolean;
	},
): Promise<ListResult> {
	const { limits } = options;
	let files = 0;
	let bytes = 0;
	let scanLimitReached = false;
	let stoppedByCaller = false;
	const splitter = new RecordSplitter(0, limits.maxPathBytes, (record, cut) => {
		if (cut || record.length === 0) return true;
		files++;
		if (files > limits.maxScanFiles) {
			scanLimitReached = true;
			return false;
		}
		if (!options.onFile(record.toString("utf8"))) {
			stoppedByCaller = true;
			return false;
		}
		return true;
	});
	await runGuest(vm, buildFindArgv(tools.find, root, options.regularFilesOnly), {
		signal: options.signal,
		timeoutMs: options.deadline.remaining(),
		onStdout: (chunk) => {
			bytes += chunk.length;
			if (bytes > limits.maxScanBytes) {
				// Keep what fits, then stop.
				const keep = chunk.subarray(0, Math.max(0, chunk.length - (bytes - limits.maxScanBytes)));
				splitter.push(keep);
				scanLimitReached = true;
				return false;
			}
			return splitter.push(chunk);
		},
	});
	if (!scanLimitReached && !stoppedByCaller) splitter.end();
	return { scanLimitReached };
}

async function isGuestDirectory(vm: SearchVm, guestPath: string, signal?: AbortSignal): Promise<boolean> {
	try {
		return (await vm.fs.stat(guestPath, { signal })).isDirectory();
	} catch {
		throw new Error(`Path not found: ${guestPath}`);
	}
}

// ---------------------------------------------------------------------------
// Glob matching (linear time, no regex)

type GlobToken =
	| { kind: "literal"; char: string }
	| { kind: "any" }
	| { kind: "star" }
	| { kind: "class"; negate: boolean; ranges: Array<[string, string]> };
type GlobSegment = GlobToken[] | "globstar";

const MAX_BRACE_EXPANSIONS = 64;

function expandBraces(pattern: string, from = 0, out: string[] = []): string[] {
	for (let open = pattern.indexOf("{", from); open !== -1; open = pattern.indexOf("{", open + 1)) {
		if (open > 0 && pattern[open - 1] === "\\") continue;
		let depth = 0;
		const commas: number[] = [];
		let close = -1;
		for (let i = open; i < pattern.length; i++) {
			const char = pattern[i];
			if (char === "\\") {
				i++;
				continue;
			}
			if (char === "{") depth++;
			else if (char === "}") {
				depth--;
				if (depth === 0) {
					close = i;
					break;
				}
			} else if (char === "," && depth === 1) commas.push(i);
		}
		if (close === -1) break;
		if (commas.length === 0) continue; // `{a}` is literal
		const prefix = pattern.slice(0, open);
		const suffix = pattern.slice(close + 1);
		const bounds = [open, ...commas, close];
		for (let i = 0; i < bounds.length - 1; i++) {
			const option = pattern.slice(bounds[i]! + 1, bounds[i + 1]);
			expandBraces(prefix + option + suffix, prefix.length, out);
			if (out.length > MAX_BRACE_EXPANSIONS) throw new Error("glob pattern expands to too many alternatives");
		}
		return out;
	}
	out.push(pattern);
	return out;
}

function tokenizeSegment(segment: string): GlobSegment {
	if (segment === "**") return "globstar";
	const tokens: GlobToken[] = [];
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i]!;
		if (char === "\\" && i + 1 < segment.length) {
			tokens.push({ kind: "literal", char: segment[++i]! });
		} else if (char === "*") {
			if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
		} else if (char === "?") {
			tokens.push({ kind: "any" });
		} else if (char === "[") {
			let j = i + 1;
			let negate = false;
			if (segment[j] === "!" || segment[j] === "^") {
				negate = true;
				j++;
			}
			const ranges: Array<[string, string]> = [];
			let first = true;
			for (; j < segment.length && (first || segment[j] !== "]"); j++) {
				first = false;
				let low = segment[j]!;
				if (low === "\\" && j + 1 < segment.length) low = segment[++j]!;
				let high = low;
				if (segment[j + 1] === "-" && j + 2 < segment.length && segment[j + 2] !== "]") {
					high = segment[j + 2]!;
					if (high === "\\" && j + 3 < segment.length) {
						high = segment[j + 3]!;
						j++;
					}
					j += 2;
				}
				ranges.push([low, high]);
			}
			if (j >= segment.length) {
				tokens.push({ kind: "literal", char }); // unterminated: literal '['
			} else {
				tokens.push({ kind: "class", negate, ranges });
				i = j;
			}
		} else {
			tokens.push({ kind: "literal", char });
		}
	}
	return tokens;
}

function tokenMatches(token: GlobToken, char: string): boolean {
	if (token.kind === "any") return true;
	if (token.kind === "literal") return token.char === char;
	if (token.kind === "class") {
		const inside = token.ranges.some(([low, high]) => char >= low && char <= high);
		return inside !== token.negate;
	}
	return false;
}

/** Classic two-pointer wildcard match: O(pattern × text), no backtracking blow-up. */
function matchSegment(tokens: GlobToken[], text: string): boolean {
	let ti = 0;
	let si = 0;
	let starToken = -1;
	let starText = 0;
	while (si < text.length) {
		const token = tokens[ti];
		if (token && token.kind === "star") {
			starToken = ti++;
			starText = si;
		} else if (token && tokenMatches(token, text[si]!)) {
			ti++;
			si++;
		} else if (starToken >= 0) {
			ti = starToken + 1;
			si = ++starText;
		} else {
			return false;
		}
	}
	while (tokens[ti]?.kind === "star") ti++;
	return ti === tokens.length;
}

/** Segment-level DP so `**` costs O(segments × depth). */
function matchSegments(pattern: GlobSegment[], parts: string[]): boolean {
	let next = new Array<boolean>(parts.length + 1).fill(false);
	next[parts.length] = true;
	for (let i = pattern.length - 1; i >= 0; i--) {
		const segment = pattern[i]!;
		const current = new Array<boolean>(parts.length + 1).fill(false);
		for (let j = parts.length; j >= 0; j--) {
			if (segment === "globstar") current[j] = next[j]! || (j < parts.length && current[j + 1]!);
			else current[j] = j < parts.length && next[j + 1]! && matchSegment(segment, parts[j]!);
		}
		next = current;
	}
	return next[0]!;
}

function compileGlob(pattern: string): GlobSegment[] {
	return pattern.split("/").filter((segment, index) => segment !== "" || index === 0).map(tokenizeSegment);
}

/**
 * Glob semantics of the previous host walker (and close to Pi's fd/rg):
 * a pattern without `/` matches the basename; with `/` it matches the
 * relative path, anchored or under any directory. `*`, `?`, `[...]`, `**`
 * and `{a,b}` are supported; dotfiles match (Pi searches hidden files).
 */
export function createToolGlobMatcher(pattern: string, maxLength = DEFAULT_SEARCH_LIMITS.maxGlobLength): (relativePath: string) => boolean {
	let normalized = pattern.split(path.sep).join("/");
	if (normalized.length > maxLength) throw new Error(`Glob pattern is longer than ${maxLength} characters`);
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	const byPath = normalized.includes("/");
	const alternatives = expandBraces(normalized).map((alternative) =>
		byPath ? [compileGlob(alternative), compileGlob(`**/${alternative}`)] : [compileGlob(alternative)],
	);
	return (relativePath) => {
		const parts = (byPath ? relativePath : path.posix.basename(relativePath)).split("/");
		return alternatives.some((variants) => variants.some((compiled) => matchSegments(compiled, parts)));
	};
}

// ---------------------------------------------------------------------------
// find

/**
 * FindOperations.glob for Pi's find tool: paths relative to `root` (Pi
 * relativizes absolute results; relative ones pass through unchanged).
 */
export async function guestFind(
	vm: SearchVm,
	root: string,
	pattern: string,
	limit: number,
	signal?: AbortSignal,
	limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
): Promise<string[]> {
	const matches = createToolGlobMatcher(pattern, limits.maxGlobLength);
	const tools = await detectGuestSearchTools(vm, signal);
	if (!(await isGuestDirectory(vm, root, signal))) {
		const name = path.posix.basename(root);
		return limit > 0 && matches(name) ? [name] : [];
	}
	const results: string[] = [];
	if (limit <= 0) return results;
	await listGuestFiles(vm, tools, root, {
		regularFilesOnly: false,
		signal,
		limits,
		deadline: new Deadline(limits.timeoutMs),
		onFile: (guestPath) => {
			const relativePath = path.posix.relative(root, guestPath);
			if (matches(relativePath)) results.push(relativePath);
			return results.length < limit;
		},
	});
	return results;
}

// ---------------------------------------------------------------------------
// grep

export type GuestGrepParams = {
	/** Absolute guest path (file or directory). */
	root: string;
	pattern: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
};

export function buildGrepArgv(
	tools: GuestSearchTools,
	params: { pattern: string; ignoreCase?: boolean; literal?: boolean; context: number },
	files: string[],
): string[] {
	for (const file of files) assertGuestPath(file);
	return [
		tools.grep,
		"-n",
		"-H",
		"-s",
		...(tools.skipBinary ? ["-I"] : []),
		...(params.ignoreCase ? ["-i"] : []),
		params.literal ? "-F" : tools.perl ? "-P" : "-E",
		...(params.context > 0 ? ["-C", String(params.context)] : []),
		"-e",
		params.pattern,
		"--",
		...files,
	];
}

type GrepRecord = { file: string; line: number; isMatch: boolean; text: string };

/**
 * Parse `file:N:text` / `file-N-text` without trusting separators in file
 * names: the file part must be one of the names this invocation was given.
 */
export function parseGrepRecord(record: string, files: ReadonlySet<string>, maxFileLength: number): GrepRecord | undefined {
	const limit = Math.min(record.length, maxFileLength + 1);
	for (let i = 1; i < limit; i++) {
		const separator = record[i];
		if (separator !== ":" && separator !== "-") continue;
		let j = i + 1;
		while (j < record.length && record.charCodeAt(j) >= 48 && record.charCodeAt(j) <= 57) j++;
		if (j === i + 1 || record[j] !== separator) continue;
		const file = record.slice(0, i);
		if (!files.has(file)) continue;
		return { file, line: Number(record.slice(i + 1, j)), isMatch: separator === ":", text: record.slice(j + 1) };
	}
	return undefined;
}

type StoredLine = { text: string; truncated: boolean };

export async function guestGrep(
	vm: SearchVm,
	params: GuestGrepParams,
	signal?: AbortSignal,
	limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
): Promise<TextToolResult<GrepToolDetails>> {
	const { root } = params;
	assertGuestPath(root);
	if (Buffer.byteLength(params.pattern) > limits.maxPatternBytes) {
		throw new Error(`Pattern is longer than ${limits.maxPatternBytes} bytes`);
	}
	const globMatches = params.glob ? createToolGlobMatcher(params.glob, limits.maxGlobLength) : undefined;
	const context = params.context && params.context > 0 ? Math.floor(params.context) : 0;
	const effectiveLimit = Math.max(1, Math.floor(params.limit ?? DEFAULT_GREP_LIMIT));
	const deadline = new Deadline(limits.timeoutMs);

	const tools = await detectGuestSearchTools(vm, signal);
	const rootIsDirectory = await isGuestDirectory(vm, root, signal);

	// 1. List candidate files in the guest (bounded), filter by glob on the host.
	const files: string[] = [];
	let scanLimitReached = false;
	if (rootIsDirectory) {
		({ scanLimitReached } = await listGuestFiles(vm, tools, root, {
			regularFilesOnly: true,
			signal,
			limits,
			deadline,
			onFile: (guestPath) => {
				if (!globMatches || globMatches(path.posix.relative(root, guestPath))) files.push(guestPath);
				return true;
			},
		}));
	} else if (!globMatches || globMatches(path.posix.basename(root))) {
		files.push(root);
	}

	const displayPath = (file: string) => (rootIsDirectory ? path.posix.relative(root, file) : path.posix.basename(file));

	// 2. Grep in the guest, in argv-bounded batches, until a limit is reached.
	const outputLines: string[] = [];
	let outputBytes = 0;
	let matchCount = 0;
	let matchLimitReached = false;
	let lastMatchLine = 0;
	let linesTruncated = false;
	let byteLimitReached = false;
	let current: { file: string; lines: Map<number, StoredLine>; matches: number[]; storedBytes: number } | undefined;

	const flushFile = () => {
		if (!current) return;
		const { lines, matches, file } = current;
		const shown = displayPath(file);
		for (const match of matches) {
			let start = match;
			while (start - 1 >= match - context && lines.has(start - 1)) start--;
			for (let line = start; line <= match + context && lines.has(line); line++) {
				const stored = lines.get(line)!;
				if (stored.truncated) linesTruncated = true;
				const separator = line === match ? ":" : "-";
				const formatted = `${shown}${separator}${line}${separator} ${stored.text}`;
				outputLines.push(formatted);
				outputBytes += Buffer.byteLength(formatted) + 1;
			}
		}
		current = undefined;
	};

	/** Returns false to stop the whole search. */
	const onRecord = (parsed: GrepRecord, cut: boolean): boolean => {
		if (current && parsed.file !== current.file) {
			flushFile();
			if (matchLimitReached) return false;
		}
		if (matchLimitReached && parsed.line > lastMatchLine + context) return false;
		current ??= { file: parsed.file, lines: new Map(), matches: [], storedBytes: 0 };
		const { text, wasTruncated } = truncateLine(parsed.text.replace(/\r/g, ""), GREP_MAX_LINE_LENGTH);
		const stored: StoredLine = wasTruncated || !cut ? { text, truncated: wasTruncated } : { text: `${text}... [truncated]`, truncated: true };
		current.lines.set(parsed.line, stored);
		current.storedBytes += Buffer.byteLength(stored.text) + 1;
		if (parsed.isMatch && !matchLimitReached) {
			matchCount++;
			current.matches.push(parsed.line);
			if (matchCount >= effectiveLimit) {
				matchLimitReached = true;
				lastMatchLine = parsed.line;
				if (context === 0) return false;
			}
		}
		// Every stored line is printed at least once, so past this point the
		// formatted output is certain to exceed Pi's byte limit.
		if (outputBytes + current.storedBytes > DEFAULT_MAX_BYTES) {
			byteLimitReached = true;
			return false;
		}
		return true;
	};

	let stop = false;
	for (let index = 0; index < files.length && !stop; ) {
		const batch: string[] = [];
		let batchBytes = 0;
		let maxFileLength = 0;
		while (index < files.length && batch.length < limits.batchFiles && (batch.length === 0 || batchBytes < limits.batchBytes)) {
			const file = files[index++]!;
			batch.push(file);
			batchBytes += Buffer.byteLength(file) + 1;
			maxFileLength = Math.max(maxFileLength, file.length);
		}
		const names = new Set(batch);
		let recordsInBatch = 0;
		const splitter = new RecordSplitter(0x0a, limits.maxRecordBytes, (record, cut) => {
			const parsed = parseGrepRecord(record.toString("utf8"), names, maxFileLength);
			if (!parsed || parsed.text.includes("\0")) return true; // `--` separators, binary lines
			recordsInBatch++;
			return onRecord(parsed, cut);
		});
		const run = await runGuest(vm, buildGrepArgv(tools, { ...params, context }, batch), {
			signal,
			timeoutMs: deadline.remaining(),
			onStdout: (chunk) => splitter.push(chunk),
		});
		if (run.stopped) {
			stop = true;
			break;
		}
		if (!splitter.end()) stop = true;
		if ((run.exitCode ?? 0) > 1 && recordsInBatch === 0 && run.stderr.trim()) {
			throw new Error(run.stderr.trim());
		}
		// The last match's trailing context is in its own file, so in this batch.
		if (matchLimitReached) stop = true;
	}
	flushFile();

	const scanNotice = scanLimitReached ? `File scan stopped after ${limits.maxScanFiles} files or ${formatSize(limits.maxScanBytes)} of paths; narrow path or glob` : undefined;
	if (matchCount === 0) {
		return { content: [{ type: "text", text: scanNotice ? `No matches found\n\n[${scanNotice}]` : "No matches found" }], details: undefined };
	}

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated || byteLimitReached) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		if (truncation.truncated) details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (scanNotice) notices.push(scanNotice);
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}
