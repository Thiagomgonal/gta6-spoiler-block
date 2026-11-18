import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ URL });
for (const file of ["settings.js", "keywords.js", "matcher.js"]) {
  const source = readFileSync(new URL(`../extension/src/shared/${file}`, import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: file });
}

const { createMatcher, normalize } = context.GSBMatcher;
const { sanitizeTerms, siteOf } = context.GSBSettings;
const strict = createMatcher({ strict: true });
const relaxed = createMatcher({ strict: false });
const hits = (matcher, text) => matcher.matches(normalize(text));

test("game name variations", () => {
  for (const text of [
    "GTA 6",
    "GTA VI",
    "gta6",
    "GTAVI",
    "Gta-6 launch",
    "#GTA6Trailer",
    "#GTAVI",
    "GTA Ⅵ",
    "GTA Six",
    "GTA seis",
    "G.T.A. 6",
    "Grand Theft Auto VI",
    "grand theft auto 6",
    "Rockstar's GTA VI: everything we know",
  ]) {
    assert.ok(hits(relaxed, text), text);
  }
});

test("characters, places and groups", () => {
  for (const text of [
    "Lucía Caminos",
    "LUCIA CAMINOS",
    "Jason Duval",
    "Dre’Quan Priest",
    "DreQuan",
    "Boobie Ike",
    "Bae-Luxe and Roxy",
    "Real Dimez",
    "Brian Heder",
    "Cal Hampton",
    "Raul Bautista",
    "Port Gellhorn",
    "Leonida Keys",
    "Vice City",
    "Grassrivers",
    "Mount Kalaga",
    "Only Raw Records",
    "San4San",
    "Final Chapter MC",
    "Cyberleek",
    "Jason and Lucia",
    "Lucia & Jason",
    "Jason e Lucia fogem",
  ]) {
    assert.ok(hits(relaxed, text), text);
  }
});

test("ordinary text is left alone", () => {
  for (const text of [
    "Leonidas was a Spartan king",
    "I love the Lucia song",
    "Jason Momoa new movie",
    "Martha Gellhorn was a war correspondent",
    "take two aspirin and call me",
    "Rockstar energy drink",
    "Lucia went home. Jason stayed.",
    "Brian and Raymond went fishing",
  ]) {
    assert.equal(hits(strict, text), false, text);
  }
});

test("generic mentions depend on strict mode", () => {
  assert.equal(hits(strict, "New GTA Online update"), true);
  assert.equal(hits(relaxed, "New GTA Online update"), false);
  assert.equal(hits(relaxed, "GTA Vice"), false);
  assert.equal(hits(relaxed, "GTA ending leaked"), true);
  assert.equal(hits(relaxed, "Rockstar Games shows Lucia"), true);
  assert.equal(hits(relaxed, "Traffic in the Greater Toronto Area"), false);
});

test("custom terms are literal and bounded", () => {
  const matcher = createMatcher({ strict: false, customTerms: ["Bananinha Boss", "(.*)+", "x"] });
  assert.ok(hits(matcher, "the bananinha-boss mission"));
  assert.equal(hits(matcher, "banana"), false);
  assert.equal(hits(matcher, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"), false);
  assert.deepEqual([...sanitizeTerms(["  a  b  ", "ok term", "ok term", 42, "no"])], ["a b", "ok term"]);
});

test("siteOf keeps only web hostnames", () => {
  assert.equal(siteOf("https://www.youtube.com/watch?v=1"), "youtube.com");
  assert.equal(siteOf("http://old.reddit.com/r/gaming"), "old.reddit.com");
  assert.equal(siteOf("chrome://extensions"), null);
  assert.equal(siteOf("not a url"), null);
});

test("mayMatch skips fragments with nothing relevant", () => {
  assert.equal(strict.mayMatch(normalize("just a normal sentence about cooking")), false);
  assert.equal(strict.mayMatch(normalize("Lucia")), false);
  assert.equal(strict.mayMatch(normalize("gta")), true);
});
