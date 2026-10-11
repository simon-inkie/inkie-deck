/**
 * push-watch-core.mjs - pure logic for the push watcher.
 *
 * Plain functions, no IO, unit-tested directly. The watcher process
 * (push-watcher.mjs) feeds it file contents and acts on the results.
 *
 * Block grammar: the same append-only inbox format the app parses, but the
 * watcher only needs three facts per block - who sent it, the subject, and
 * how many blocks the file holds. The header delimiter is tolerant of
 * ASCII hyphen AND em/en dash (agents hand-write em-dash headers, so the
 * parser must never choke on them).
 *
 * ASCII only in THIS file - no em-dashes; the dash variants below
 * are unicode escapes.
 */

const HEADER_RE =
  /^## (.+?) [-\u2014\u2013] from: (\S+) [-\u2014\u2013] status: (\S+)(?: [-\u2014\u2013] subject: (.*))?$/;

/**
 * Split a thread file into blocks and parse each header.
 * Returns [{ from, subject, timestamp }] in file order. Blocks whose header
 * does not parse are kept with from "(unknown)" so COUNTS stay stable -
 * a malformed block must not shift later block indices (the watcher's
 * new-block detection is index-based).
 */
export function parseBlocks(content) {
  const blocks = [];
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.startsWith("## ")) continue;
    const m = HEADER_RE.exec(line);
    if (m) {
      blocks.push({
        timestamp: m[1] ?? "",
        from: m[2] ?? "(unknown)",
        subject: (m[4] ?? "").trim(),
      });
    } else {
      blocks.push({ timestamp: "", from: "(unknown)", subject: "" });
    }
  }
  return blocks;
}

/**
 * Given the parsed blocks, the previously-seen count, and the instance
 * user, return the payloads to push: one per NEW block whose sender is not
 * the user. agentName is the thread owner (directory name) and drives the
 * deep link.
 *
 * If the file SHRANK (count < prevCount: rewrite/rotation), returns no
 * payloads - the caller re-baselines. Never push on ambiguity.
 */
export function newBlockPayloads(blocks, prevCount, user, agentName) {
  if (blocks.length <= prevCount) return [];
  const payloads = [];
  for (let i = prevCount; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.from === user || b.from === "(unknown)") continue;
    payloads.push({
      title: b.from,
      body: b.subject || "New message",
      deepLink: `/threads/${agentName}`,
    });
  }
  return payloads;
}
