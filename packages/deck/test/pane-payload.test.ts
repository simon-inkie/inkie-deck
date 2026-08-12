import { describe, expect, it } from "vitest";
import { buildPanePayload, SEND_KEYS_MAX_LEN } from "~/lib/tmux.server";

/**
 * Regression cover for the silent-truncation data loss found 2026-07-26.
 *
 * Alex's 4919-char brief was delivered as 2000 chars with a well-formed
 * "[reply via inbox: ...]" footer appended after the cut, so it read as a
 * complete thought. 2974 characters vanished and the recipient acted on the
 * remainder believing it whole.
 */
describe("buildPanePayload", () => {
  const tag = "alex";

  it("delivers a short message whole, with the reply hint", () => {
    const out = buildPanePayload(tag, "short one");
    expect(out).toContain("short one");
    expect(out).toContain(`[inbox from ${tag}]`);
    expect(out).toContain(`[reply via inbox: inbox reply ${tag}]`);
  });

  it("never emits a partial: an over-cap body contributes no body text", () => {
    // A distinctive opening that WOULD have survived the old slice().
    const opening = "OPENINGFRAGMENT";
    const body = opening + "x".repeat(SEND_KEYS_MAX_LEN * 2);
    const out = buildPanePayload(tag, body);
    // The old implementation leaked the head of the body. The nudge must not.
    expect(out).not.toContain(opening);
    expect(out).not.toContain("xxxxx");
  });

  it("states the true length and how to recover it", () => {
    const body = "y".repeat(5000);
    const out = buildPanePayload(tag, body);
    expect(out).toContain("5000 chars");
    expect(out).toContain(`inbox read ${tag}`);
    expect(out).toContain("TOO LONG");
  });

  it("reproduces the real incident: 4919 chars is not delivered as prose", () => {
    // The actual Seven Sisters message length.
    const body = "z".repeat(4919);
    const out = buildPanePayload(tag, body);
    expect(out).toContain("4919 chars");
    expect(out.length).toBeLessThanOrEqual(SEND_KEYS_MAX_LEN);
  });

  it("boundary: a body exactly at the limit is still delivered whole", () => {
    const hint = ` [reply via inbox: inbox reply ${tag}]`;
    const prefix = `[inbox from ${tag}] `;
    const exact = "a".repeat(SEND_KEYS_MAX_LEN - hint.length - prefix.length);
    const out = buildPanePayload(tag, exact);
    expect(out).toContain(exact);
    expect(out.length).toBe(SEND_KEYS_MAX_LEN);
  });

  it("boundary: one char over the limit flips to the nudge", () => {
    const hint = ` [reply via inbox: inbox reply ${tag}]`;
    const prefix = `[inbox from ${tag}] `;
    const over = "a".repeat(SEND_KEYS_MAX_LEN - hint.length - prefix.length + 1);
    const out = buildPanePayload(tag, over);
    expect(out).not.toContain(over);
    expect(out).toContain("TOO LONG");
  });

  /**
   * The structural invariant: a rule that lives in a comment, or in a
   * shared helper nobody is required to call, is not a rule. This is the
   * property that must hold for ANY body, so that no future edit can
   * reintroduce a silent partial without going red.
   */
  it("INVARIANT: output is never over-cap, and is either whole or marked", () => {
    const lengths = [0, 1, 100, 1900, 1961, 1962, 1963, 2000, 5000, 50_000];
    for (const n of lengths) {
      // A unique leading sentinel per case: whole-vs-marked is not enough on its
      // own, because an implementation could emit the marker AND still leak a
      // body prefix, satisfying the disjunction while losing data silently.
      const sentinel = `BODY_${n}_SENTINEL`;
      const body = sentinel + "b".repeat(n);
      const out = buildPanePayload(tag, body);
      expect(out.length, `length ${n} exceeded the send-keys cap`).toBeLessThanOrEqual(
        SEND_KEYS_MAX_LEN
      );
      const whole = out.includes(body);
      const marked = out.includes("TOO LONG") && out.includes(`inbox read ${tag}`);
      expect(whole || marked, `length ${n} was neither whole nor marked`).toBe(true);
      if (marked && !whole) {
        // The nudge path must carry NO body content at all, not even the head.
        expect(out, `length ${n} leaked a body prefix into the nudge`).not.toContain(
          sentinel
        );
      }
    }
  });

  it("reports the SOURCE length, not the rewritten body length", () => {
    // The body reaching buildPanePayload has already had /attachments/ URLs
    // swapped for longer absolute paths. Reporting that inflated length would
    // not reconcile with what the recipient reads in the stored thread, which
    // is the whole value of the marker.
    const rewritten = "z".repeat(6000); // post-rewrite, longer
    const sourceLength = 4919; // what Alex actually wrote
    const out = buildPanePayload(tag, rewritten, sourceLength);
    expect(out).toContain("4919 chars");
    expect(out).not.toContain("6000 chars");
  });

  it("defaults the reported length to the body when no source length given", () => {
    const out = buildPanePayload(tag, "q".repeat(3000));
    expect(out).toContain("3000 chars");
  });

  it("counts CODE POINTS, not UTF-16 units, so emoji match what a reader counts", () => {
    // An emoji is 2 to String.length and 1 to a human, to Python, and to the
    // agent-to-agent CLI. Reporting UTF-16 units made the two paths disagree on
    // identical text by the number of non-BMP characters.
    const body = "\u{1F600}".repeat(2000); // 2000 code points, 4000 UTF-16 units
    const out = buildPanePayload(tag, body);
    expect(out).toContain("2000 chars");
    expect(out).not.toContain("4000 chars");
  });

  it("keeps the payload capped even for a pathological sender tag", () => {
    // buildPanePayload is exported and pure, so its capped-payload contract must
    // hold regardless of caller validation. The tag appears three times.
    const out = buildPanePayload("x".repeat(700), "");
    expect(out.length).toBeLessThanOrEqual(SEND_KEYS_MAX_LEN);
  });

  /**
   * Dictation provenance (2026-08-11). The stored block carried "dictated: true"
   * and the pane push dropped it, so an agent read transcribed speech with no
   * sign it was transcribed. Dictation mangles words ("Binky" for "Inkie",
   * "Norator" for "Narrator", both real, both same-day), and the marker changes
   * both how the text is decoded and whether the agent should ask rather than
   * guess.
   *
   * Named for the OUTCOME each case protects, not the input that produced it.
   */
  describe("dictation marker", () => {
    it("marks a dictated message ahead of the text, so it is read first", () => {
      const out = buildPanePayload(tag, "hello there", undefined, true);
      expect(out).toContain("[DICTATED]");
      expect(out).toContain("hello there");
      // Ahead of the body, not merely present somewhere in the payload: a marker
      // that arrives after the words it qualifies has already failed its job.
      expect(out.indexOf("[DICTATED]")).toBeLessThan(out.indexOf("hello there"));
    });

    it("survives the over-cap nudge, the branch that carries no body at all", () => {
      // THE case this fix exists for. A marker prepended to the BODY by a caller
      // would vanish here, because the nudge deliberately drops all body text -
      // and a long dictated message is both the likeliest to be mangled and the
      // one the recipient is about to go and read in full.
      const out = buildPanePayload(tag, "w".repeat(9000), undefined, true);
      expect(out).toContain("TOO LONG");
      expect(out).toContain("[DICTATED]");
      expect(out.indexOf("[DICTATED]")).toBeLessThan(out.indexOf("TOO LONG"));
    });

    it("does not distort the reported character count", () => {
      // The count must keep reconciling with what `inbox read` shows. The marker
      // is pane-only decoration, excluded on the same grounds as the prefix and
      // the hint.
      const out = buildPanePayload(tag, "w".repeat(5000), undefined, true);
      expect(out).toContain("5000 chars");
    });

    it("leaves ordinary messages unmarked on both branches", () => {
      // No leakage: a marker that showed up on undictated text would be worse
      // than no marker, because it would be trusted.
      const omitted = buildPanePayload(tag, "short one");
      expect(omitted).not.toContain("[DICTATED]");
      expect(buildPanePayload(tag, "w".repeat(9000))).not.toContain("[DICTATED]");
      // Explicit false must behave exactly as omitted, and "exactly" means the
      // WHOLE payload, not merely the absence of the marker: asserting only that
      // both lack [DICTATED] would stay green if the prefix, body or reply hint
      // regressed on one path and not the other (CodeRabbit, 2026-08-11).
      expect(buildPanePayload(tag, "short one", undefined, false)).toBe(omitted);
    });

    it("stays within the send-keys cap even with a pathological tag", () => {
      // The marker must not be the thing that pushes a nudge over the cap.
      const out = buildPanePayload("x".repeat(700), "w".repeat(9000), undefined, true);
      expect(out.length).toBeLessThanOrEqual(SEND_KEYS_MAX_LEN);
      expect(out).toContain("[DICTATED]");
    });

    it("INVARIANT: whole-or-marked still holds with dictation on", () => {
      // The existing structural invariant must not have been weakened by adding
      // a branch. Same lengths, same disjunction, marker required throughout.
      const lengths = [0, 1, 100, 1900, 1961, 1962, 1963, 2000, 5000, 50_000];
      for (const n of lengths) {
        const sentinel = `BODY_${n}_SENTINEL`;
        const body = sentinel + "b".repeat(n);
        const out = buildPanePayload(tag, body, undefined, true);
        expect(out.length, `length ${n} exceeded the send-keys cap`).toBeLessThanOrEqual(
          SEND_KEYS_MAX_LEN
        );
        expect(out, `length ${n} lost the dictation marker`).toContain("[DICTATED]");
        const whole = out.includes(body);
        const marked = out.includes("TOO LONG") && out.includes(`inbox read ${tag}`);
        expect(whole || marked, `length ${n} was neither whole nor marked`).toBe(true);
        if (marked && !whole) {
          expect(out, `length ${n} leaked a body prefix into the nudge`).not.toContain(
            sentinel
          );
        }
      }
    });
  });

  it("does not lean on a subject line (Alex's are routinely stale)", () => {
    const out = buildPanePayload(tag, "Subject-ish first line\nrest of body");
    expect(buildPanePayload(tag, "x".repeat(9000))).not.toContain("Subject-ish");
    expect(out).toContain("Subject-ish first line");
  });
});
