/**
 * Docker operations, kept in one place so every container the rig starts is
 * started the same way: no bind mounts, no inherited environment, removed on
 * exit. The isolation is a property of this file rather than of each caller
 * remembering to ask for it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { exec, must, RigError } from "./exec.mjs";

/** @param {string[]} args @param {object} [options] */
export function docker(args, options = {}) {
  return exec("docker", args, options);
}

export function requireDocker() {
  const result = docker(["version", "--format", "{{.Server.Version}}"]);
  if (!result.ok) {
    throw new RigError(
      `docker is not usable by the rig: ${result.spawnFailed ? "not on PATH" : result.output.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** Pull an image so the digest recorded below is the registry's, not a stale local build. */
export function pull(ref) {
  return must("docker", ["pull", "--quiet", ref]);
}

/**
 * Facts about an image that no probe running INSIDE the container could
 * establish about itself: its content digest, and the mounts and environment
 * a container created from it would start with.
 *
 * A container is created (not started) purely so `docker inspect` reports the
 * merged runtime configuration rather than the image's declared one.
 *
 * @param {string} ref
 */
export function containerFacts(ref) {
  const image = must("docker", ["image", "inspect", "--format", "{{json .}}", ref]);
  const imageJson = JSON.parse(image.stdout);
  const created = must("docker", ["create", ref, "true"]);
  const id = created.stdout.trim();
  try {
    const inspected = must("docker", ["inspect", "--format", "{{json .}}", id]);
    const containerJson = JSON.parse(inspected.stdout);
    return {
      ref,
      id: imageJson.Id,
      repoDigests: imageJson.RepoDigests ?? [],
      mounts: containerJson.Mounts ?? [],
      env: containerJson.Config?.Env ?? [],
    };
  } finally {
    docker(["rm", "-f", id]);
  }
}

/**
 * Run a shell script in a throwaway container.
 *
 * `--rm` and the absence of any -v/--mount/-e flag are the isolation
 * guarantee. Environment is passed as an explicit allowlist argument and
 * exported inside the script, so a caller cannot accidentally inherit the
 * developer's environment through the docker client.
 *
 * @param {string} ref
 * @param {string} script  POSIX sh, run with `set -e` left to the caller
 * @param {{ env?: Record<string,string>, network?: string }} [options]
 */
export function runIn(ref, script, options = {}) {
  const exports = Object.entries(options.env ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const args = ["run", "--rm"];
  if (options.network) args.push(`--network=${options.network}`);
  args.push(ref, "sh", "-c", `${exports}\n${script}`);
  return docker(args);
}

/**
 * Build an image from an inline Dockerfile and a context directory.
 *
 * @param {{ tag: string, dockerfile: string, contextDir: string, quiet?: boolean }} spec
 */
export function build({ tag, dockerfile, contextDir }) {
  const file = path.join(contextDir, `Dockerfile.${tag.replace(/[^a-z0-9]+/gi, "-")}`);
  fs.writeFileSync(file, dockerfile, "utf8");
  const result = docker(["build", "-f", file, "-t", tag, contextDir]);
  if (!result.ok) {
    throw new RigError(`image build failed for ${tag}:\n${result.output.slice(-4000)}`);
  }
  return { tag, log: result.output };
}

/** @param {string} value */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
