import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createWorkerImage, PACKAGE_VERSION, releaseImageRef, releaseImageUrl, type ImageStore } from "../src/image.ts";

async function archive(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-image-src-"));
  await writeFile(join(dir, "manifest.json"), '{"buildId":"test"}');
  const out = join(await mkdtemp(join(tmpdir(), "pi-lead-image-tgz-")), "image.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", dir, "."]);
  return readFile(out);
}

function fakeFetch(files: Record<string, Buffer | string>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = files[url];
    return body === undefined ? new Response("missing", { status: 404, statusText: "Not Found" }) : new Response(typeof body === "string" ? body : new Uint8Array(body));
  }) as typeof fetch;
}

function memoryStore(): ImageStore & { imported: { manifest: string; ref: string; arch: string }[] } {
  const imported: { manifest: string; ref: string; arch: string }[] = [];
  return {
    imported,
    has: (ref, arch) => imported.some((image) => image.ref === ref && image.arch === arch),
    import(dir, ref, arch) {
      imported.push({ manifest: readFileSync(join(dir, "manifest.json"), "utf8"), ref, arch });
    },
  };
}

test("the release image of this version is downloaded once, verified and tagged", async () => {
  const tgz = await archive();
  const url = releaseImageUrl("1.2.3", "aarch64");
  assert.equal(url, "https://github.com/tetienne/pi-lead/releases/download/v1.2.3/pi-lead-image-aarch64.tar.gz");
  const calls: string[] = [];
  const store = memoryStore();
  const image = createWorkerImage({
    version: "1.2.3",
    arch: "aarch64",
    store,
    fetch: fakeFetch({ [url]: tgz, [`${url}.sha256`]: `${createHash("sha256").update(tgz).digest("hex")}  pi-lead-image-aarch64.tar.gz\n` }, calls),
  });
  const progress: string[] = [];
  const [first, second] = await Promise.all([image((t) => void progress.push(t)), image(() => {})]);
  assert.equal(first, "pi-lead:v1.2.3");
  assert.equal(second, first);
  assert.equal(await image(() => {}), first);
  assert.deepEqual(store.imported, [{ manifest: '{"buildId":"test"}', ref: "pi-lead:v1.2.3", arch: "aarch64" }]);
  assert.equal(calls.length, 2, "one download for concurrent and later workers");
  assert.match(progress[0]!, /downloading the PI Lead worker image v1\.2\.3/);
});

test("a corrupted or missing image is refused with a way out", async () => {
  const url = releaseImageUrl("1.2.3", "x86_64");
  const store = memoryStore();
  const corrupted = createWorkerImage({
    version: "1.2.3",
    arch: "x86_64",
    store,
    fetch: fakeFetch({ [url]: await archive(), [`${url}.sha256`]: "0".repeat(64) }, []),
  });
  await assert.rejects(corrupted(() => {}), /does not match its published sha256/);
  const missing = createWorkerImage({ version: "9.9.9", arch: "x86_64", store, fetch: fakeFetch({}, []) });
  await assert.rejects(missing(() => {}), /404 Not Found.*"sandbox": \{ "image"/);
  assert.deepEqual(store.imported, []);
});

test("the default image follows the package version", () => {
  assert.equal(releaseImageRef(PACKAGE_VERSION), `pi-lead:v${PACKAGE_VERSION}`);
});
