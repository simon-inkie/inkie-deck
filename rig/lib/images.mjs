/**
 * The images the rig builds, as data.
 *
 * Both the toolchain image and the Node 20 control image come from the same
 * function, differing only in the arguments that the control is testing. Two
 * hand-written Dockerfiles would drift, and a control that differs from the
 * thing it controls in more than one variable measures nothing in particular.
 */
import { BASE_IMAGE } from "../expected.mjs";

/**
 * @param {{ nodeMajor: number, pnpmSpec: string, withRipgrep?: boolean }} spec
 */
export function toolchainDockerfile({ nodeMajor, pnpmSpec, withRipgrep = true }) {
  const apt = ["ca-certificates", "curl", "git", "tmux", ...(withRipgrep ? ["ripgrep"] : [])];
  return [
    `FROM ${BASE_IMAGE}`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    // curl is installed first and separately because it is what fetches the
    // node repository script: on a bare Ubuntu the documented Node install
    // has a prerequisite the documentation does not mention.
    `RUN apt-get update && apt-get install -y --no-install-recommends ${apt.join(" ")} \\`,
    " && rm -rf /var/lib/apt/lists/*",
    `RUN curl -fsSL https://deb.nodesource.com/setup_${nodeMajor}.x | bash - \\`,
    " && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*",
    `RUN corepack enable && corepack prepare ${pnpmSpec} --activate`,
    "WORKDIR /src",
    "COPY source.tar /source.tar",
    "RUN tar -xf /source.tar -C /src && rm /source.tar",
    // The tree arrives from `git archive` and therefore has no `.git`, but two
    // of the product's suites and the leak gate shell out to git against the
    // repository root and fail without one. Making the archived tree a real
    // repository here keeps the source-entry guarantee (the contents are a
    // committed tree, with no developer state) while giving the product the
    // live repository it turns out to assume. `add --all` is correct in a
    // throwaway container: the archive is exactly the tree we want committed.
    "RUN git init -q /src \\",
    " && git -C /src config user.email rig@example.invalid \\",
    " && git -C /src config user.name rig \\",
    " && git -C /src add --all \\",
    ' && git -C /src commit -qm "rig: the archived tree, committed so the product sees a live repository"',
    "",
  ].join("\n");
}

/**
 * The base for measuring INSTALL.md: the source as a clone, and NOTHING else.
 *
 * Deliberately not the toolchain image above. That one installs Node, pnpm,
 * ripgrep, git, curl and tmux, which is most of what INSTALL.md's first
 * section tells a reader to install; measuring the document against it would
 * be measuring a document whose hardest step had already been done for it.
 *
 * git appears in a builder stage only. The tree has to BE a clone (the
 * document says so, and two of the product's suites and the leak gate require
 * it), while the final image must still have no git binary, because installing
 * git is one of the things the document's own block is claiming to do.
 *
 * @param {{ from?: string }} [spec]
 */
export function installBaseDockerfile({ from = BASE_IMAGE } = {}) {
  return [
    `FROM ${from} AS source`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \\",
    " && rm -rf /var/lib/apt/lists/*",
    "COPY source.tar /source.tar",
    "RUN mkdir -p /src && tar -xf /source.tar -C /src && rm /source.tar \\",
    " && git init -q /src \\",
    " && git -C /src config user.email rig@example.invalid \\",
    " && git -C /src config user.name rig \\",
    " && git -C /src add --all \\",
    ' && git -C /src commit -qm "rig: the archived tree, committed so the product sees a live repository"',
    "",
    `FROM ${from}`,
    "COPY --from=source /src /src",
    // $HOME, because the document's own blocks write state under it and a
    // reader's home is not the repository.
    "WORKDIR /root",
    "",
  ].join("\n");
}
