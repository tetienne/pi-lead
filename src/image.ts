import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { getDefaultArch, importImageFromDirectory, resolveImageSelector, setImageRef } from "@earendil-works/gondolin";

/**
 * The worker image (Debian + git + mise), built by the release workflow for
 * each version and attached to its GitHub release. The first worker downloads
 * the one matching this package's version into Gondolin's image store; later
 * workers find it there. Nothing to build in the consuming project.
 * `sandbox.image` in the config replaces it with an image of your own.
 */

export const RELEASE_REPOSITORY = "tetienne/pi-lead";

export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export function releaseImageAsset(arch: string): string {
  return `pi-lead-image-${arch}.tar.gz`;
}

export function releaseImageUrl(version: string, arch: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${releaseImageAsset(arch)}`;
}

/** Gondolin image reference the release image is tagged with locally. */
export function releaseImageRef(version: string): string {
  return `pi-lead:v${version}`;
}

export type ImageStore = {
  has(ref: string, arch: string): boolean;
  /** Imports the extracted asset directory and tags it `ref`. */
  import(dir: string, ref: string, arch: string): void;
};

const gondolinStore: ImageStore = {
  has(ref, arch) {
    try {
      resolveImageSelector(ref, arch as ReturnType<typeof getDefaultArch>);
      return true;
    } catch {
      return false;
    }
  },
  import(dir, ref, arch) {
    const imported = importImageFromDirectory(dir);
    if (imported.arch !== arch) throw new Error(`the downloaded image is for ${imported.arch}, not ${arch}`);
    setImageRef(ref, imported.buildId, imported.arch);
  },
};

async function download(url: string, to: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText} (${url})`);
  const hash = createHash("sha256");
  const tee = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), tee, createWriteStream(to));
  return hash.digest("hex");
}

/** Returns the Gondolin image selector workers use, downloading the release image the first time. */
export function createWorkerImage(options: {
  version?: string;
  arch?: string;
  store?: ImageStore;
  fetch?: typeof fetch;
} = {}): (progress: (text: string) => void) => Promise<string> {
  const version = options.version ?? PACKAGE_VERSION;
  const arch = options.arch ?? getDefaultArch();
  const store = options.store ?? gondolinStore;
  const fetchImpl = options.fetch ?? fetch;
  const ref = releaseImageRef(version);
  let pending: Promise<string> | undefined;

  const pull = async (progress: (text: string) => void) => {
    const url = releaseImageUrl(version, arch);
    progress(`downloading the PI Lead worker image v${version} (${arch}, first time only)`);
    const dir = await mkdtemp(join(tmpdir(), "pi-lead-image-"));
    try {
      const archive = join(dir, "image.tar.gz");
      let actual: string;
      let expected: string;
      try {
        const checksum = await fetchImpl(`${url}.sha256`);
        if (!checksum.ok) throw new Error(`${checksum.status} ${checksum.statusText} (${url}.sha256)`);
        expected = (await checksum.text()).trim().split(/\s+/, 1)[0]!.toLowerCase();
        actual = await download(url, archive, fetchImpl);
      } catch (error) {
        throw new Error(
          `could not download the PI Lead worker image v${version} for ${arch}: ${(error as Error).message}. ` +
            'Retry later, or set "sandbox": { "image": "<selector>" } in pi-lead.json to use an image of your own.',
        );
      }
      if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
        throw new Error(`the PI Lead worker image v${version} (${arch}) does not match its published sha256`);
      }
      const extracted = join(dir, "image");
      await mkdir(extracted);
      await promisify(execFile)("tar", ["-xzf", archive, "-C", extracted]);
      store.import(extracted, ref, arch);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    progress("worker image ready");
    return ref;
  };

  return (progress) => {
    if (store.has(ref, arch)) return Promise.resolve(ref);
    pending ??= pull(progress).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

