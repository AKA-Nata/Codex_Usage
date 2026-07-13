import assert from "node:assert/strict";
import test from "node:test";

import { spriteReactionEngineCases } from "./sprite-reaction-engine.cases.js";
import { behaviorStudioModelCases } from "./behavior-studio-model.cases.js";
import { characterAnimationCases } from "./character-animation.cases.js";
import { characterSelectorCases } from "./character-selector.cases.js";

const assertions = {
  equal: (actual, expected, message) => assert.equal(actual, expected, message),
  deepEqual: (actual, expected, message) => assert.deepEqual(actual, expected, message),
  ok: (value, message) => assert.ok(value, message),
};

for (const testCase of [...spriteReactionEngineCases, ...behaviorStudioModelCases, ...characterAnimationCases, ...characterSelectorCases]) {
  test(testCase.name, () => testCase.run(assertions));
}
