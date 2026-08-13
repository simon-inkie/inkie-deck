/**
 * Version arithmetic for the toolchain floor.
 *
 * A string compare puts "20.19.5" above "22.13.0" for two characters and then
 * gets the wrong answer, and a parseFloat puts 22.9 above 22.13. Both are
 * plausible one-liners and both would pass a Node 20 environment as meeting a
 * 22.13 floor, which is exactly the class of green-over-broken this rig is
 * built to be incapable of.
 *
 * The floor stopped being a single number when the engines field became a
 * range: `^22.13.0 || >=24.0.0` admits 22.13 and 24, and REFUSES 23, which no
 * `>=` comparison can express. So the range is evaluated as a range. It is
 * hand-rolled rather than delegated to `semver` on purpose: the rig runs
 * before and instead of `pnpm install`, and an instrument that needs the
 * product's node_modules to start cannot report on a machine that has none.
 */

/** @param {string} text @returns {[number, number, number]} */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) {
    throw new Error(`not a version string: ${JSON.stringify(text)}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {string} actual @param {string} floor
 * @returns {boolean} true when `actual` is at or above `floor`
 */
export function versionAtLeast(actual, floor) {
  const a = parseVersion(actual);
  const f = parseVersion(floor);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== f[i]) return a[i] > f[i];
  }
  return true;
}

/**
 * Does `version` satisfy an engines range of the shape the manifests use:
 * `||`-separated clauses, each either `^x.y.z` or `>=x.y.z`?
 *
 * An unrecognised clause THROWS rather than evaluating to false. A range
 * parser that quietly ignores the syntax it does not know reports "this Node
 * is not permitted" about a perfectly good version, or worse reports the
 * reverse, and it does so in silence; a rig that cannot read the range it is
 * asserting against must say so, not guess.
 *
 * @param {string} version @param {string} range
 * @returns {boolean}
 */
export function satisfiesRange(version, range) {
  const actual = parseVersion(version);
  return range
    .split("||")
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      const match = /^(\^|>=)\s*(\d+\.\d+\.\d+)$/.exec(clause);
      if (!match) {
        throw new Error(`unsupported engines range clause: ${JSON.stringify(clause)} in ${JSON.stringify(range)}`);
      }
      const [, operator, bound] = match;
      if (!versionAtLeast(version, bound)) return false;
      // `^` is capped at the next major, which is the whole reason the range
      // form was chosen: it is what keeps a non-LTS line such as 23 out while
      // still admitting every patch of 22.
      return operator === ">=" || actual[0] === parseVersion(bound)[0];
    });
}
