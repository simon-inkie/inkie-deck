/**
 * Version arithmetic for the toolchain floor.
 *
 * A string compare puts "20.19.5" above "22.18.0" for two characters and then
 * gets the wrong answer, and a parseFloat puts 22.9 above 22.18. Both are
 * plausible one-liners and both would pass a Node 20 environment as meeting a
 * 22.18 floor, which is exactly the class of green-over-broken this rig is
 * built to be incapable of.
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
