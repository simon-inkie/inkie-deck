/**
 * Tests for app/lib/review-exts.ts (TASK-562).
 *
 * Covers:
 *   - REVIEW_MD_EXTS: markdown extensions present.
 *   - REVIEW_CODE_EXTS: code extensions present, .env absent, .svg absent.
 *   - ALL_REVIEW_EXTS: union.
 *   - extToLang: common mappings, plaintext fallback.
 *   - extKind: markdown vs code.
 *   - isSecretBasename: secret denylist (peer-review addition 2026-06-28).
 *   - isReviewablePath: path-shaped links pass/fail predicates including denylist.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect } from "vitest";
import {
  REVIEW_MD_EXTS,
  REVIEW_CODE_EXTS,
  ALL_REVIEW_EXTS,
  extToLang,
  extKind,
  isSecretBasename,
  isReviewablePath,
  isPathShapedImage,
  reviewAssetUrl,
} from "~/lib/review-exts";

// ---------------------------------------------------------------------------
// Extension set membership
// ---------------------------------------------------------------------------

describe("REVIEW_MD_EXTS", () => {
  it("contains .md, .txt, .markdown", () => {
    expect(REVIEW_MD_EXTS.has(".md")).toBe(true);
    expect(REVIEW_MD_EXTS.has(".txt")).toBe(true);
    expect(REVIEW_MD_EXTS.has(".markdown")).toBe(true);
  });

  it("does not contain code extensions", () => {
    expect(REVIEW_MD_EXTS.has(".ts")).toBe(false);
    expect(REVIEW_MD_EXTS.has(".json")).toBe(false);
  });
});

describe("REVIEW_CODE_EXTS", () => {
  it("contains common code extensions", () => {
    for (const ext of [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".json", ".jsonc", ".css", ".scss", ".html",
      ".sql", ".py", ".sh", ".bash", ".zsh",
      ".rb", ".go", ".rs", ".java", ".kt", ".php",
      ".yml", ".yaml", ".toml", ".ini", ".conf",
      ".prisma", ".graphql", ".proto",
    ]) {
      expect(REVIEW_CODE_EXTS.has(ext), `expected ${ext} in REVIEW_CODE_EXTS`).toBe(true);
    }
  });

  it("does NOT contain .env (secret-bearing)", () => {
    expect(REVIEW_CODE_EXTS.has(".env")).toBe(false);
  });

  it("does NOT contain .svg (TASK-431 decision)", () => {
    expect(REVIEW_CODE_EXTS.has(".svg")).toBe(false);
  });

  it("does NOT contain .md (that is in MD set, not code)", () => {
    expect(REVIEW_CODE_EXTS.has(".md")).toBe(false);
  });
});

describe("ALL_REVIEW_EXTS", () => {
  it("is the union of MD and CODE sets", () => {
    for (const ext of REVIEW_MD_EXTS) {
      expect(ALL_REVIEW_EXTS.has(ext)).toBe(true);
    }
    for (const ext of REVIEW_CODE_EXTS) {
      expect(ALL_REVIEW_EXTS.has(ext)).toBe(true);
    }
  });

  it("does not contain .env or .svg", () => {
    expect(ALL_REVIEW_EXTS.has(".env")).toBe(false);
    expect(ALL_REVIEW_EXTS.has(".svg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extToLang
// ---------------------------------------------------------------------------

describe("extToLang", () => {
  const cases: Array<[string, string]> = [
    [".ts",       "typescript"],
    [".tsx",      "typescript"],
    [".js",       "javascript"],
    [".jsx",      "javascript"],
    [".mjs",      "javascript"],
    [".cjs",      "javascript"],
    [".json",     "json"],
    [".jsonc",    "json"],
    [".css",      "css"],
    [".scss",     "scss"],
    [".html",     "html"],
    [".sql",      "sql"],
    [".py",       "python"],
    [".sh",       "bash"],
    [".bash",     "bash"],
    [".zsh",      "bash"],
    [".rb",       "ruby"],
    [".go",       "go"],
    [".rs",       "rust"],
    [".java",     "java"],
    [".kt",       "kotlin"],
    [".php",      "php"],
    [".yml",      "yaml"],
    [".yaml",     "yaml"],
    [".toml",     "ini"],
    [".ini",      "ini"],
    [".conf",     "ini"],
    [".graphql",  "graphql"],
    [".proto",    "protobuf"],
  ];

  for (const [ext, expectedLang] of cases) {
    it(`maps ${ext} -> ${expectedLang}`, () => {
      expect(extToLang(ext)).toBe(expectedLang);
    });
  }

  it("returns plaintext for unknown extension", () => {
    expect(extToLang(".xyz")).toBe("plaintext");
    expect(extToLang("")).toBe("plaintext");
  });
});

// ---------------------------------------------------------------------------
// extKind
// ---------------------------------------------------------------------------

describe("extKind", () => {
  it("returns markdown for .md, .txt, .markdown", () => {
    expect(extKind(".md")).toBe("markdown");
    expect(extKind(".txt")).toBe("markdown");
    expect(extKind(".markdown")).toBe("markdown");
  });

  it("returns code for code extensions", () => {
    expect(extKind(".ts")).toBe("code");
    expect(extKind(".json")).toBe("code");
    expect(extKind(".py")).toBe("code");
    expect(extKind(".sh")).toBe("code");
    expect(extKind(".rs")).toBe("code");
  });
});

// ---------------------------------------------------------------------------
// isReviewablePath
// ---------------------------------------------------------------------------

describe("isReviewablePath", () => {
  it("returns true for absolute paths ending in markdown extensions", () => {
    expect(isReviewablePath("/home/you/docs/notes.md")).toBe(true);
    expect(isReviewablePath("/home/you/docs/README.txt")).toBe(true);
    expect(isReviewablePath("/home/you/docs/guide.markdown")).toBe(true);
  });

  it("returns true for tilde paths ending in markdown extensions", () => {
    expect(isReviewablePath("~/brain/docs/notes.md")).toBe(true);
  });

  it("returns true for absolute paths ending in code extensions", () => {
    expect(isReviewablePath("/home/you/app/index.ts")).toBe(true);
    expect(isReviewablePath("/home/you/app/config.json")).toBe(true);
    expect(isReviewablePath("/home/you/app/styles.css")).toBe(true);
    expect(isReviewablePath("/home/you/app/main.py")).toBe(true);
    expect(isReviewablePath("/home/you/app/build.sh")).toBe(true);
  });

  it("returns true for tilde paths ending in code extensions", () => {
    expect(isReviewablePath("~/git-repos/app/lib/review.server.ts")).toBe(true);
  });

  it("returns false for .env paths (secret-bearing)", () => {
    expect(isReviewablePath("/home/you/app/.env")).toBe(false);
    expect(isReviewablePath("~/.env")).toBe(false);
  });

  it("returns false for .svg paths", () => {
    expect(isReviewablePath("/home/you/app/logo.svg")).toBe(false);
  });

  it("returns false for relative paths (no leading / or ~/)", () => {
    expect(isReviewablePath("relative/path/to/file.ts")).toBe(false);
    expect(isReviewablePath("notes.md")).toBe(false);
  });

  it("returns false for http/https URLs", () => {
    expect(isReviewablePath("https://example.com/file.ts")).toBe(false);
    expect(isReviewablePath("http://example.com/file.md")).toBe(false);
  });

  it("returns false for paths with no extension", () => {
    expect(isReviewablePath("/home/you/app/Makefile")).toBe(false);
    expect(isReviewablePath("/home/you/app/Dockerfile")).toBe(false);
  });

  it("strips query strings before extension check", () => {
    expect(isReviewablePath("/home/you/app/config.json?v=2")).toBe(true);
  });

  it("strips fragments before extension check", () => {
    expect(isReviewablePath("/home/you/app/notes.md#section")).toBe(true);
  });

  it("returns true for /attachments/ paths, which Markdown.tsx handles separately", () => {
    // isReviewablePath is for path-shaped links, not attachment URLs.
    // /attachments/ paths start with / but their extension check happens elsewhere.
    // A .ts attachment would actually pass (starts with /, ends in .ts) - that is
    // intentional: the link handler in Markdown.tsx checks isAttachmentTextChip
    // BEFORE isPathShapedDocLink so attachments are handled by their own branch.
    // This test documents the current boundary.
    expect(isReviewablePath("/attachments/file.md")).toBe(true);
  });

  // Secret denylist integration in isReviewablePath (peer-review 2026-06-28).
  it("returns false for signing_key.json even though .json is in the code allowlist", () => {
    expect(isReviewablePath("/home/you/git-repos/inkie-app/supabase/signing_key.json")).toBe(false);
    expect(isReviewablePath("~/git-repos/inkie-app/supabase/signing_key.json")).toBe(false);
  });

  it("returns false for .env.production, .env.local etc. (real env files)", () => {
    expect(isReviewablePath("/home/you/app/.env.production")).toBe(false);
    expect(isReviewablePath("/home/you/app/.env.local")).toBe(false);
    expect(isReviewablePath("~/.env.staging")).toBe(false);
  });

  it("returns false for .env.example (not panel-openable: .example not in code allowlist)", () => {
    // .env.example is allowed by the denylist (not a secret), but the extension
    // ".example" is not in ALL_REVIEW_EXTS so the link is not panel-openable.
    // This is correct: .env.example files are not useful to open in a code view.
    // They can be served if the allowlist is widened to .txt-like catch-alls.
    expect(isReviewablePath("/home/you/app/.env.example")).toBe(false);
    expect(isReviewablePath("/home/you/app/.env.sample")).toBe(false);
    expect(isReviewablePath("/home/you/app/.env.template")).toBe(false);
  });

  it("returns false for *.age files (encrypted credentials)", () => {
    expect(isReviewablePath("/home/you/agents/briar/.db-creds.age")).toBe(false);
    expect(isReviewablePath("~/agents/quill/.db-creds.age")).toBe(false);
  });

  it("returns false for *.pem and *.key files", () => {
    expect(isReviewablePath("/home/you/certs/server.pem")).toBe(false);
    expect(isReviewablePath("/home/you/keys/private.key")).toBe(false);
  });

  it("returns false for SSH private key files", () => {
    expect(isReviewablePath("/home/you/.ssh/id_rsa")).toBe(false);
    expect(isReviewablePath("/home/you/.ssh/id_ed25519")).toBe(false);
    expect(isReviewablePath("/home/you/.ssh/id_ecdsa")).toBe(false);
  });

  it("returns true for normal .json files (package.json, tsconfig.json)", () => {
    expect(isReviewablePath("/home/you/app/package.json")).toBe(true);
    expect(isReviewablePath("/home/you/app/tsconfig.json")).toBe(true);
    expect(isReviewablePath("/home/you/app/config.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPathShapedImage (chat image link resolution)
// ---------------------------------------------------------------------------

describe("isPathShapedImage", () => {
  it("returns true for tilde-rooted image paths", () => {
    expect(isPathShapedImage("~/foo/bar.png")).toBe(true);
    expect(isPathShapedImage("~/git-repos/inkie-briar/content/render-pass-two.png")).toBe(true);
    expect(isPathShapedImage("~/a.jpg")).toBe(true);
    expect(isPathShapedImage("~/a.jpeg")).toBe(true);
    expect(isPathShapedImage("~/a.gif")).toBe(true);
    expect(isPathShapedImage("~/a.webp")).toBe(true);
  });

  it("returns true for absolute image paths", () => {
    expect(isPathShapedImage("/abs/path.jpg")).toBe(true);
    expect(isPathShapedImage("/home/you/pics/shot.png")).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    expect(isPathShapedImage("~/foo/BAR.PNG")).toBe(true);
    expect(isPathShapedImage("/abs/Photo.JPG")).toBe(true);
  });

  it("strips query strings and fragments before the extension check", () => {
    expect(isPathShapedImage("~/foo/bar.png?v=2")).toBe(true);
    expect(isPathShapedImage("/abs/path.jpg#frag")).toBe(true);
  });

  it("returns false for relative paths (no leading / or ~/)", () => {
    expect(isPathShapedImage("relative/path.png")).toBe(false);
    expect(isPathShapedImage("bar.png")).toBe(false);
    expect(isPathShapedImage("images/foo.png")).toBe(false);
  });

  it("returns false for http/https/data URLs", () => {
    expect(isPathShapedImage("https://example.com/x.png")).toBe(false);
    expect(isPathShapedImage("http://example.com/x.jpg")).toBe(false);
    expect(isPathShapedImage("data:image/png;base64,AAAA")).toBe(false);
  });

  it("returns false for protocol-relative URLs (//cdn.example.com/x.png)", () => {
    // These start with "/" but are external, not filesystem paths.
    expect(isPathShapedImage("//cdn.example.com/x.png")).toBe(false);
    expect(isPathShapedImage("//example.com/pics/shot.jpg")).toBe(false);
  });

  it("returns false for non-image extensions (docs, code, svg)", () => {
    expect(isPathShapedImage("~/notes.md")).toBe(false);
    expect(isPathShapedImage("/home/you/app/index.ts")).toBe(false);
    expect(isPathShapedImage("~/logo.svg")).toBe(false);
  });

  it("returns false for paths with no extension", () => {
    expect(isPathShapedImage("~/foo/bar")).toBe(false);
    expect(isPathShapedImage("/home/you/Makefile")).toBe(false);
  });

  it("returns false when the basename matches an unconditional secret pattern", () => {
    // A secret file renamed to a .png extension must still be refused
    // (defence in depth, mirrors isReviewablePath). The unconditional
    // patterns (SSH keys, kubeconfig, tfstate) apply regardless of extension.
    expect(isPathShapedImage("~/.ssh/id_rsa.png")).toBe(false);
    // Secret basename must still be caught when a query/fragment is appended.
    expect(isPathShapedImage("~/.ssh/id_rsa.png?download=1")).toBe(false);
    expect(isPathShapedImage("~/.ssh/id_rsa.png#preview")).toBe(false);
    expect(isPathShapedImage("/home/you/k8s/kubeconfig.png")).toBe(false);
    expect(isPathShapedImage("/home/you/tf/terraform.tfstate.png")).toBe(false);
    // A normal image basename passes (server.png is not a secret basename;
    // the secret-token check is scoped to config extensions, not images).
    expect(isPathShapedImage("/home/you/certs/server.png")).toBe(true);
  });

  it("is disjoint from isReviewablePath (images are never panel-openable)", () => {
    // Image paths are path-shaped images but NOT review-panel docs.
    expect(isPathShapedImage("~/foo/bar.png")).toBe(true);
    expect(isReviewablePath("~/foo/bar.png")).toBe(false);
    // Doc/code paths are review-panel docs but NOT path-shaped images.
    expect(isReviewablePath("~/notes.md")).toBe(true);
    expect(isPathShapedImage("~/notes.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewAssetUrl (query strip + single-cycle percent normalisation)
// ---------------------------------------------------------------------------

describe("reviewAssetUrl", () => {
  it("encodes a plain path once", () => {
    expect(reviewAssetUrl("~/pics/plain.png")).toBe(
      "/api/review-asset?path=" + encodeURIComponent("~/pics/plain.png")
    );
  });

  it("strips the query string and fragment before encoding", () => {
    const bare = "~/pics/shot.png";
    expect(reviewAssetUrl(bare + "?v=2")).toBe(
      "/api/review-asset?path=" + encodeURIComponent(bare)
    );
    expect(reviewAssetUrl(bare + "#frag")).toBe(
      "/api/review-asset?path=" + encodeURIComponent(bare)
    );
  });

  it("decodes one layer so an already-encoded space nets to a single cycle", () => {
    // Input already has "%20"; a naive encode would double it to "%2520".
    const url = reviewAssetUrl("~/pics/my%20image.png");
    expect(url).toBe(
      "/api/review-asset?path=" + encodeURIComponent("~/pics/my image.png")
    );
    // The server (one decode layer) recovers the real space, not a literal %20.
    const param = url.slice("/api/review-asset?path=".length);
    expect(decodeURIComponent(param)).toBe("~/pics/my image.png");
    expect(url).not.toContain("%2520");
  });

  it("does not throw on a malformed percent, falls back to the raw stripped path", () => {
    // decodeURIComponent("~/pics/bad%.png") throws URIError (lone %).
    const url = reviewAssetUrl("~/pics/bad%.png");
    expect(url).toBe(
      "/api/review-asset?path=" + encodeURIComponent("~/pics/bad%.png")
    );
  });
});

// ---------------------------------------------------------------------------
// isSecretBasename - direct unit tests
// ---------------------------------------------------------------------------

describe("isSecretBasename", () => {
  // Signing keys.
  it("denies signing_key.json and signing_keys.json", () => {
    expect(isSecretBasename("signing_key.json")).toBe(true);
    expect(isSecretBasename("signing_keys.json")).toBe(true);
    // Case-insensitive.
    expect(isSecretBasename("Signing_Key.json")).toBe(true);
  });

  // .env variants.
  it("denies .env", () => {
    expect(isSecretBasename(".env")).toBe(true);
  });

  it("denies .env.production, .env.local, .env.staging", () => {
    expect(isSecretBasename(".env.production")).toBe(true);
    expect(isSecretBasename(".env.local")).toBe(true);
    expect(isSecretBasename(".env.staging")).toBe(true);
    expect(isSecretBasename(".env.development")).toBe(true);
  });

  it("allows .env.example, .env.sample, .env.template", () => {
    expect(isSecretBasename(".env.example")).toBe(false);
    expect(isSecretBasename(".env.sample")).toBe(false);
    expect(isSecretBasename(".env.template")).toBe(false);
  });

  // Private key and certificate extensions.
  it("denies *.pem, *.key, *.p12, *.pfx, *.keystore, *.jks", () => {
    expect(isSecretBasename("server.pem")).toBe(true);
    expect(isSecretBasename("private.key")).toBe(true);
    expect(isSecretBasename("store.p12")).toBe(true);
    expect(isSecretBasename("store.pfx")).toBe(true);
    expect(isSecretBasename("app.keystore")).toBe(true);
    expect(isSecretBasename("app.jks")).toBe(true);
  });

  // SSH private key basenames.
  it("denies id_rsa, id_dsa, id_ecdsa, id_ed25519 and variants", () => {
    expect(isSecretBasename("id_rsa")).toBe(true);
    expect(isSecretBasename("id_dsa")).toBe(true);
    expect(isSecretBasename("id_ecdsa")).toBe(true);
    expect(isSecretBasename("id_ed25519")).toBe(true);
    // With suffixes.
    expect(isSecretBasename("id_rsa.pub")).toBe(true);
    expect(isSecretBasename("id_ed25519_work")).toBe(true);
  });

  // Age files.
  it("denies *.age files", () => {
    expect(isSecretBasename(".db-creds.age")).toBe(true);
    expect(isSecretBasename("secrets.age")).toBe(true);
  });

  // Credential JSON patterns.
  it("denies service-account*.json", () => {
    expect(isSecretBasename("service-account.json")).toBe(true);
    expect(isSecretBasename("service-account-prod.json")).toBe(true);
  });

  it("denies *service_account*.json", () => {
    expect(isSecretBasename("my-service_account.json")).toBe(true);
    expect(isSecretBasename("gcp-service_account-prod.json")).toBe(true);
  });

  it("denies *credentials*.json", () => {
    expect(isSecretBasename("credentials.json")).toBe(true);
    expect(isSecretBasename("oauth-credentials.json")).toBe(true);
    expect(isSecretBasename("app-credentials-prod.json")).toBe(true);
  });

  it("denies *-secret*.json", () => {
    expect(isSecretBasename("app-secret.json")).toBe(true);
    expect(isSecretBasename("my-secret-key.json")).toBe(true);
  });

  it("denies *.secrets.json", () => {
    expect(isSecretBasename("app.secrets.json")).toBe(true);
    expect(isSecretBasename("prod.secrets.json")).toBe(true);
  });

  // CR regression tests (2026-06-28): separator-aware token check catches
  // names not covered by the earlier prefix/include patterns.
  it("denies secret.json (bare 'secret' token at start)", () => {
    expect(isSecretBasename("secret.json")).toBe(true);
  });

  it("denies client_secret.json and client-secret.json", () => {
    expect(isSecretBasename("client_secret.json")).toBe(true);
    expect(isSecretBasename("client-secret.json")).toBe(true);
  });

  it("denies private_key.json and private-key.json", () => {
    expect(isSecretBasename("private_key.json")).toBe(true);
    expect(isSecretBasename("private-key.json")).toBe(true);
  });

  it("denies google_client_secret.json (token in middle)", () => {
    expect(isSecretBasename("google_client_secret.json")).toBe(true);
  });

  // CR round 2 (2026-06-28): plural 'secrets', dot-separated tokens, and
  // service-account anywhere in the name (not only at the start).
  it("denies secrets.json, private.key.json, gcp-service-account-prod.json", () => {
    expect(isSecretBasename("secrets.json")).toBe(true);
    expect(isSecretBasename("private.key.json")).toBe(true);
    expect(isSecretBasename("gcp-service-account-prod.json")).toBe(true);
    expect(isReviewablePath("/home/you/app/secrets.json")).toBe(false);
    expect(isReviewablePath("/home/you/app/gcp-service-account-prod.json")).toBe(false);
  });

  // Normal JSON files that must still pass.
  it("allows normal .json files (package.json, tsconfig.json, config.json)", () => {
    expect(isSecretBasename("package.json")).toBe(false);
    expect(isSecretBasename("tsconfig.json")).toBe(false);
    expect(isSecretBasename("config.json")).toBe(false);
    expect(isSecretBasename("manifest.json")).toBe(false);
    expect(isSecretBasename("data.json")).toBe(false);
  });

  // Conf and yaml secret patterns.
  it("denies secret patterns in yaml, yml, toml, ini, conf files", () => {
    expect(isSecretBasename("client_secret.yaml")).toBe(true);
    expect(isSecretBasename("client-secret.toml")).toBe(true);
    expect(isSecretBasename("private_key.yml")).toBe(true);
    expect(isSecretBasename("secret.conf")).toBe(true);
    expect(isSecretBasename("app.secrets.yaml")).toBe(true);
  });

  // Exact names and custom credentials.
  it("denies exact sensitive basenames and custom configs", () => {
    expect(isSecretBasename(".npmrc")).toBe(true);
    expect(isSecretBasename(".netrc")).toBe(true);
    expect(isSecretBasename(".git-credentials")).toBe(true);
    expect(isSecretBasename("htpasswd")).toBe(true);
    expect(isSecretBasename("wp-config.php")).toBe(true);
    expect(isSecretBasename("connection.ovpn")).toBe(true);
  });

  // Kubernetes and Terraform.
  it("denies Kubernetes configs and Terraform state files", () => {
    expect(isSecretBasename("kubeconfig")).toBe(true);
    expect(isSecretBasename("kubeconfig.yaml")).toBe(true);
    expect(isSecretBasename("terraform.tfstate")).toBe(true);
    expect(isSecretBasename("my.tfstate")).toBe(true);
  });

  // Confirm isReviewablePath also refuses the new patterns (client-side guard).
  it("isReviewablePath refuses client_secret.json, private_key.json, secret.json", () => {
    expect(isReviewablePath("/home/you/app/client_secret.json")).toBe(false);
    expect(isReviewablePath("/home/you/app/client-secret.json")).toBe(false);
    expect(isReviewablePath("/home/you/app/private_key.json")).toBe(false);
    expect(isReviewablePath("/home/you/app/private-key.json")).toBe(false);
    expect(isReviewablePath("/home/you/app/secret.json")).toBe(false);
  });

  it("isReviewablePath refuses new patterns (yaml secrets, npmrc, kubeconfig, tfstate)", () => {
    expect(isReviewablePath("/home/you/app/client_secret.yaml")).toBe(false);
    expect(isReviewablePath("/home/you/app/.npmrc")).toBe(false);
    expect(isReviewablePath("/home/you/app/kubeconfig.yml")).toBe(false);
    expect(isReviewablePath("/home/you/app/terraform.tfstate")).toBe(false);
  });

  // Confirm normal package.json / tsconfig.json / config.json still pass isReviewablePath.
  it("isReviewablePath allows package.json, tsconfig.json, a plain config.json", () => {
    expect(isReviewablePath("/home/you/app/package.json")).toBe(true);
    expect(isReviewablePath("/home/you/app/tsconfig.json")).toBe(true);
    expect(isReviewablePath("/home/you/app/config.json")).toBe(true);
    expect(isReviewablePath("/home/you/app/docker-compose.yml")).toBe(true);
  });

  // Non-secret files.
  it("allows normal source files", () => {
    expect(isSecretBasename("index.ts")).toBe(false);
    expect(isSecretBasename("review.server.ts")).toBe(false);
    expect(isSecretBasename("README.md")).toBe(false);
    expect(isSecretBasename("main.py")).toBe(false);
  });
});
