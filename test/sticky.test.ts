import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStickiness, nextIncumbent, STICKY_MARGIN } from "../src/sticky.ts";
import type { ProviderId } from "../src/providers.ts";
import type { RunOutcome } from "../src/runner/spawn.ts";

const base = { winner: "claude" as const, incumbent: "muse" as const, availableIds: ["muse", "claude"] as ProviderId[], probabilities: null };

test("07: native-double switch boundary, including decimal-looking equality", () => {
  assert.equal(STICKY_MARGIN, 0.15);
  for (const [winner, incumbent, stayed] of [[0.15, 0, true], [0.3, 0.15, true], [0.16, 0, false], [0.14, 0, true], [0.55, 0.40, false]] as const) {
    const diff = winner - incumbent;
    if (winner === 0.15 || winner === 0.3) assert.equal(diff, STICKY_MARGIN);
    else assert.equal(diff > STICKY_MARGIN, !stayed);
    assert.deepEqual(applyStickiness({ ...base, probabilities: { claude: winner, muse: incumbent } }), { harness: stayed ? "muse" : "claude", stayed });
  }
});

test("07: absent figures, null distribution, agreement and unavailable ids", () => {
  for (const [probabilities, stayed] of [[{ claude: 0.16 }, false], [{ claude: 0.15 }, true], [{ muse: 0.9 }, true], [null, true]] as const) {
    assert.deepEqual(applyStickiness({ ...base, probabilities }), { harness: stayed ? "muse" : "claude", stayed });
  }
  assert.deepEqual(applyStickiness({ ...base, winner: "muse" }), { harness: "muse", stayed: true });
  for (const options of [{ ...base, incumbent: null }, { ...base, availableIds: ["claude"] as ProviderId[] }, { ...base, availableIds: ["muse"] as ProviderId[] }]) {
    assert.deepEqual(applyStickiness(options), { harness: "claude", stayed: false });
  }
});

test("07: hostile inputs and throwing getters always degrade without throwing", () => {
  const throwing = new Proxy({}, { get() { throw new Error("hostile"); } });
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1, "0.9", {}, [], null, undefined]) {
    assert.deepEqual(applyStickiness({ ...base, probabilities: { claude: value, muse: value } } as unknown as Parameters<typeof applyStickiness>[0]), { harness: "muse", stayed: true });
  }
  for (const probabilities of [null, undefined, 3, "bad", true, [], throwing, revoked.proxy]) {
    assert.deepEqual(applyStickiness({ ...base, probabilities } as unknown as Parameters<typeof applyStickiness>[0]), { harness: "muse", stayed: true });
  }
  for (const availableIds of [null, undefined, "muse", {}, throwing, revoked.proxy, new Proxy(["muse", "claude"], { get() { throw new Error("hostile"); } })]) {
    assert.deepEqual(applyStickiness({ ...base, availableIds } as unknown as Parameters<typeof applyStickiness>[0]), { harness: "claude", stayed: false });
  }
  for (const options of [null, undefined, 1, "bad", throwing, revoked.proxy]) {
    assert.doesNotThrow(() => applyStickiness(options as Parameters<typeof applyStickiness>[0]));
  }
  const oneGetter = Object.defineProperty({ muse: 0.2 }, "claude", { get() { throw new Error("hostile"); } });
  assert.deepEqual(applyStickiness({ ...base, probabilities: oneGetter }), { harness: "muse", stayed: true });
  assert.deepEqual(applyStickiness({ ...base, availableIds: Object.assign(["muse", "claude"], { includes() { throw new Error("override"); } }) }), { harness: "muse", stayed: true });
});

test("07: nextIncumbent truth table and unknown outcomes", () => {
  for (const incumbent of [null, "muse"] as const) {
    for (const outcome of ["ok", "nonzero", "timeout", "spawn-error", "aborted", "unknown", null, {}]) {
      assert.equal(nextIncumbent(incumbent, outcome as RunOutcome, "claude"), outcome === "ok" ? "claude" : outcome === "aborted" ? incumbent : null);
    }
  }
});
