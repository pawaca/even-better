import { test } from "node:test";
import assert from "node:assert/strict";
import { redactToken, maskToken } from "../src/connect-url.js";

test("redactToken hides the token value but keeps the rest of the URL", () => {
  const url = "http://192.168.1.5:3000/?token=deadbeefcafe1234&defaultProvider=claude";
  const out = redactToken(url);
  assert.ok(!out.includes("deadbeefcafe1234"), out);
  assert.match(out, /token=%E2%80%A6|token=…/); // redacted to the ellipsis
  assert.ok(out.includes("192.168.1.5:3000"));
  assert.ok(out.includes("defaultProvider=claude"));
});

test("redactToken is a no-op when there is no token param", () => {
  assert.equal(redactToken("http://host:3000/"), "http://host:3000/");
});

test("redactToken returns the input unchanged when it isn't a URL", () => {
  assert.equal(redactToken("not a url"), "not a url");
});

test("maskToken shows prefix/suffix only for a long token, hides short ones whole", () => {
  assert.equal(maskToken("9f597d422fd5519bad71996507808aaa"), "9f59…8aaa"); // 32 chars → revealed ends
  assert.equal(maskToken("test-token"), "…"); // short custom token → fully hidden (not test…oken)
  assert.equal(maskToken("a".repeat(23)), "…"); // just under the threshold → hidden
  assert.equal(maskToken("a".repeat(24)), "aaaa…aaaa"); // at the threshold → revealed
});
