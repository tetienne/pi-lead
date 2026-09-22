const MISE_METADATA_HOST = "mise.jdx.dev";

/**
 * Old pinned mise releases address their public metadata endpoint over HTTP.
 * Upgrade that one known request before Gondolin evaluates destination policy;
 * the hostname must still have been explicitly granted by the Lead request.
 */
export function upgradeExplicitMiseMetadataRequest(
  request: Request,
  allowedHosts: ReadonlySet<string>,
): Request {
  const url = new URL(request.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== MISE_METADATA_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !allowedHosts.has(MISE_METADATA_HOST)
  ) {
    return request;
  }

  url.protocol = "https:";
  return new Request(url, request);
}
