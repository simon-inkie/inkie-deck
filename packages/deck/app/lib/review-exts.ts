/**
 * review-exts.ts
 *
 * Shared extension + language mappings for the review panel (TASK-562).
 * Imported by both the server (review.server.ts) and client components
 * (Markdown.tsx, ReviewPanel.tsx) so the allowlist and link-open predicate
 * stay in one place.
 *
 * No .server suffix - safe to import in the browser bundle (no fs/os/env).
 * ASCII only - no em-dashes (FND-05).
 */

// ---------------------------------------------------------------------------
// Secret denylist (deny-before-allow)
// ---------------------------------------------------------------------------

/**
 * isSecretBasename(basename) returns true when the (lowercased) filename must
 * NEVER be served by the review panel regardless of its extension or location.
 * This guard runs BEFORE the extension allowlist, on BOTH the requested
 * basename AND the realpath-resolved basename (mirrors the double-gate already
 * applied for extensions, so a "safe-name -> secret" symlink is still refused).
 *
 * Rationale for each pattern:
 *
 *   signing_key.json / signing_keys.json
 *     Supabase JWT signing keys present in every repo tree (supabase/signing_key.json).
 *     Extension .json is otherwise allowed, so an explicit name deny is required.
 *
 *   .env and .env.* EXCEPT *.example / *.sample / *.template
 *     Real environment files contain DB URLs, API keys, etc. The extension gate
 *     would only block ".env" (no extension); ".env.production" has extension
 *     ".production" which is not in the allowlist, but the denylist is belt-and-
 *     braces. Only *.example / *.sample / *.template are safe to show as docs.
 *
 *   *.pem / *.key / *.p12 / *.pfx / *.keystore / *.jks
 *     TLS certificates and private keys. None of these are in the code ext
 *     allowlist but the explicit deny makes future allowlist expansions safe.
 *
 *   id_rsa* / id_dsa* / id_ecdsa* / id_ed25519*
 *     SSH private key files. The matching covers "id_rsa", "id_rsa.pub" is
 *     harmless but denied here too (conservative - public keys are not secret
 *     but there is no reason to render them in MC).
 *
 *   *.age
 *     Age-encrypted credential bundles (e.g. .db-creds.age). Extension not in
 *     the allowlist, but an explicit deny prevents accidental future addition.
 *
 *   service-account*.json / *service_account*.json / *credentials*.json /
 *   *-secret*.json / *.secrets.json
 *     GCP service accounts, OAuth credentials, and similar credential JSON files.
 *
 *   mcp.json / .mcp.json
 *     MCP server configuration. Routinely holds live credentials inline: a
 *     bearer value under headers.Authorization, or OAuth material in an `env`
 *     block. Needs an EXACT name deny because the generic config-extension
 *     check below tests the basename for a secret-shaped token, and neither
 *     spelling contains one.
 *
 * Note: the check is on the BASENAME only (not the full path) and is
 * case-insensitive. Callers must lower-case the basename before calling.
 */
export function isSecretBasename(basename: string): boolean {
  // Normalise to lowercase so callers do not need to pre-lowercase.
  const lowerBasename = basename.toLowerCase();

  // Exact names of highly sensitive files.
  const exactDeny = new Set([
    "signing_key.json",
    "signing_keys.json",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "htpasswd",
    "wp-config.php",
    // MCP server configs. These hold credentials inline: a bearer value under
    // headers.Authorization, or OAuth material (client secret, refresh token)
    // in a server's `env` block. An exact name entry is required because the
    // generic isConfigExt check further down tests the BASENAME for a
    // secret-shaped token, and neither spelling contains one. Both spellings
    // occur in real trees: ".mcp.json" at a repository root, "mcp.json" inside
    // an editor's dot-directory.
    "mcp.json",
    ".mcp.json",
  ]);
  if (exactDeny.has(lowerBasename)) return true;

  // .env and .env.* except *.example / *.sample / *.template.
  // ".env" alone has no extension; ".env.production" starts with ".env.".
  if (lowerBasename === ".env") return true;
  if (lowerBasename.startsWith(".env.")) {
    // Allow documentation templates.
    if (
      lowerBasename.endsWith(".example") ||
      lowerBasename.endsWith(".sample") ||
      lowerBasename.endsWith(".template")
    ) {
      return false;
    }
    return true;
  }

  // Private key and certificate extensions.
  for (const ext of [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".ovpn"]) {
    if (lowerBasename.endsWith(ext)) return true;
  }

  // SSH private key basenames.
  for (const prefix of ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]) {
    if (lowerBasename === prefix || lowerBasename.startsWith(prefix + ".") || lowerBasename.startsWith(prefix + "_")) {
      return true;
    }
  }

  // Age-encrypted files.
  if (lowerBasename.endsWith(".age")) return true;

  // Terraform state files.
  if (lowerBasename.includes("tfstate")) return true;

  // Kubernetes configs.
  if (lowerBasename.includes("kubeconfig")) return true;

  // Credential configuration patterns.
  // Applies to all data/config extensions allowed in CODE_EXT_LANG.
  const isConfigExt =
    lowerBasename.endsWith(".json") ||
    lowerBasename.endsWith(".jsonc") ||
    lowerBasename.endsWith(".yaml") ||
    lowerBasename.endsWith(".yml") ||
    lowerBasename.endsWith(".toml") ||
    lowerBasename.endsWith(".ini") ||
    lowerBasename.endsWith(".conf");

  if (isConfigExt) {
    // Separator-aware token check: catches secret, client_secret, private_key
    // when delimited by ".", "_", or "-".
    const hasSecretToken =
      /(^|[._-])(secrets?|client[._-]?secret|private[._-]?key|service[._-]?account)([._-]|$)/.test(
        lowerBasename
      );
    if (
      hasSecretToken ||
      lowerBasename.includes("credentials") ||
      lowerBasename.includes("-secret") ||
      lowerBasename.endsWith(".secrets.json") ||
      lowerBasename.endsWith(".secrets.yaml") ||
      lowerBasename.endsWith(".secrets.yml") ||
      lowerBasename.endsWith(".secrets.toml")
    ) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Markdown extensions
// ---------------------------------------------------------------------------

/** Extensions that should be rendered through the Markdown component. */
export const REVIEW_MD_EXTS = new Set([".md", ".txt", ".markdown"]);

// ---------------------------------------------------------------------------
// Code extensions + language map
// ---------------------------------------------------------------------------

/**
 * Maps a lowercase file extension (with leading dot) to a highlight.js
 * language id. Only extensions in this map are in the code allowlist.
 *
 * Deliberately excludes:
 *   - .env (real, secret-bearing - allowed only as *.example / *.sample)
 *   - .svg (inline asset risk - TASK-431 decision)
 *   - binary-typical extensions (.wasm, .bin, etc.)
 *
 * The binary-NUL guard in readReviewFile handles mislabeled binary files.
 */
export const CODE_EXT_LANG: Record<string, string> = {
  ".ts":       "typescript",
  ".tsx":      "typescript",
  ".js":       "javascript",
  ".jsx":      "javascript",
  ".mjs":      "javascript",
  ".cjs":      "javascript",
  ".json":     "json",
  ".jsonc":    "json",
  ".css":      "css",
  ".scss":     "scss",
  ".html":     "html",
  ".sql":      "sql",
  ".py":       "python",
  ".sh":       "bash",
  ".bash":     "bash",
  ".zsh":      "bash",
  ".rb":       "ruby",
  ".go":       "go",
  ".rs":       "rust",
  ".java":     "java",
  ".kt":       "kotlin",
  ".php":      "php",
  ".yml":      "yaml",
  ".yaml":     "yaml",
  ".toml":     "ini",
  ".ini":      "ini",
  ".conf":     "ini",
  ".prisma":   "plaintext",
  ".graphql":  "graphql",
  ".proto":    "protobuf",
};

/** Set of all allowed code extensions (derived from CODE_EXT_LANG keys). */
export const REVIEW_CODE_EXTS = new Set(Object.keys(CODE_EXT_LANG));

// ---------------------------------------------------------------------------
// Combined allowlist (markdown + code)
// ---------------------------------------------------------------------------

/** All extensions the review server will serve (markdown + code). */
export const ALL_REVIEW_EXTS = new Set([
  ...REVIEW_MD_EXTS,
  ...REVIEW_CODE_EXTS,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a lowercase extension (with leading dot), return the highlight.js
 * language id for code files, or "plaintext" if not found in the map.
 */
export function extToLang(ext: string): string {
  return CODE_EXT_LANG[ext] ?? "plaintext";
}

/**
 * Given a lowercase extension (with leading dot), return whether this is a
 * markdown extension (rendered by Markdown) or a code extension (rendered by
 * CodeView). Callers should already have confirmed the ext is in ALL_REVIEW_EXTS.
 */
export function extKind(ext: string): "markdown" | "code" {
  return REVIEW_MD_EXTS.has(ext) ? "markdown" : "code";
}

// ---------------------------------------------------------------------------
// Path-shaped image references (INK: chat image link resolution)
// ---------------------------------------------------------------------------

/**
 * Image extensions the /api/review-asset endpoint will serve. Kept SEPARATE
 * from ALL_REVIEW_EXTS on purpose: images are never opened in the review panel
 * (TASK-431 decision) - they render inline or open in a new tab. This set MUST
 * stay in sync with REVIEW_ASSET_EXTS in review.server.ts (the server-side gate
 * that actually serves the bytes): png / jpg / jpeg / gif / webp, no SVG.
 */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Strips a query string and/or fragment from an href, returning the bare path.
 * Case-preserving (unlike the lowercased form used for extension checks), so
 * the result is safe to send to the server as a filesystem path. Shared by
 * isPathShapedImage and the Markdown image-resolution call sites so the cleaned
 * path is computed one way, once: isPathShapedImage classifies on the cleaned
 * path, and the callers must send that SAME cleaned path to /api/review-asset
 * (a raw "image.png?v=2" would not match the real file on disk).
 */
export function stripQueryHash(href: string): string {
  return href.split(/[?#]/)[0] ?? "";
}

/**
 * Builds the /api/review-asset URL for a path-shaped image href/src.
 *
 * react-markdown serialises both an angle-bracket destination ("<~/a b.png>")
 * and an already-percent-encoded destination ("~/a%20b.png") into an href/src
 * prop that is ALREADY percent-encoded (e.g. "~/a%20b.png"). A naive
 * encodeURIComponent on top would double-encode ("%20" -> "%2520"), and the
 * server's URLSearchParams.get only peels one layer, recovering a literal
 * "%20" substring rather than a real space, so the file is not found (404).
 *
 * So: strip any query/fragment, decode ONE layer of percent-encoding, then
 * encode once for the query param. The decode is guarded because a genuine
 * path could contain a literal, malformed "%" (which decodeURIComponent would
 * throw on); in that case fall back to the un-decoded stripped path so
 * rendering never breaks. Net effect end to end is exactly one encode/decode
 * cycle, recovering the real filesystem path.
 */
export function reviewAssetUrl(href: string): string {
  const stripped = stripQueryHash(href);
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    decoded = stripped;
  }
  return "/api/review-asset?path=" + encodeURIComponent(decoded);
}

/**
 * Returns true when an href/src is a path-shaped reference to an image file
 * that /api/review-asset can serve: rooted at "/" or "~/", an image extension,
 * and not a secret basename. Deliberately NOT part of isReviewablePath - a
 * true result means "resolve through the review-asset endpoint and open the
 * bytes", never "open the review panel".
 *
 * The secret-basename check mirrors the defence-in-depth in isReviewablePath:
 * the server refuses secret files anyway, but the client must not advertise
 * them as resolvable links either.
 */
export function isPathShapedImage(href: string): boolean {
  // Protocol-relative URLs ("//cdn.example.com/x.png") also start with "/" but
  // are external, not filesystem paths - never route them through review-asset.
  if (href.startsWith("//")) return false;
  if (!href.startsWith("/") && !href.startsWith("~/")) return false;
  // Strip query strings and fragments before checks (same cleaning the callers
  // apply before sending the path to /api/review-asset).
  const clean = stripQueryHash(href).toLowerCase();
  // Extract basename (last path segment).
  const slashIdx = clean.lastIndexOf("/");
  const lowerBasename = slashIdx === -1 ? clean : clean.slice(slashIdx + 1);
  // Secret denylist runs BEFORE the extension allowlist.
  if (isSecretBasename(lowerBasename)) return false;
  const lastDot = lowerBasename.lastIndexOf(".");
  if (lastDot === -1) return false;
  return IMAGE_EXTS.has(lowerBasename.slice(lastDot));
}

/**
 * Returns true when a path (href or filesystem path) should be opened in the
 * review panel. Matches paths starting with "/" or "~/" whose extension is in
 * the full review allowlist AND whose basename is not in the secret denylist.
 *
 * Used by Markdown.tsx link handler and ReviewPanel to agree on which links
 * are review-openable, without duplicating the lists.
 *
 * The denylist check here prevents the Markdown link handler from advertising
 * a signing_key.json (or similar) as a panel-openable link, even if the server
 * would refuse it anyway. Defence in depth: client does not render the chip,
 * server does not serve the file.
 */
export function isReviewablePath(href: string): boolean {
  if (!href.startsWith("/") && !href.startsWith("~/")) return false;
  // Strip query strings and fragments before checks.
  const clean = (href.split(/[?#]/)[0] ?? "").toLowerCase();
  // Extract basename (last path segment).
  const slashIdx = clean.lastIndexOf("/");
  const lowerBasename = slashIdx === -1 ? clean : clean.slice(slashIdx + 1);
  // Secret denylist runs BEFORE extension allowlist.
  if (isSecretBasename(lowerBasename)) return false;
  const lastDot = lowerBasename.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = lowerBasename.slice(lastDot);
  return ALL_REVIEW_EXTS.has(ext);
}
