import assert from "node:assert/strict";
import { relativeDelta } from "../skillsets/standalone/tcmd/relative-diff.js";

assert.deepEqual(relativeDelta("prompt", "prompt\n$ command\noutput"), {
  text: "$ command\noutput",
  aligned: true,
});
assert.deepEqual(relativeDelta("old\nprompt", "old\nprompt\noutput"), {
  text: "output",
  aligned: true,
});
assert.deepEqual(relativeDelta("old-1\nold-2\nprompt", "old-2\nprompt\n$ command\noutput"), {
  text: "$ command\noutput",
  aligned: true,
});
assert.deepEqual(relativeDelta("same", "same"), {
  text: "",
  aligned: true,
});
assert.deepEqual(relativeDelta("old\nprompt", "new pane\n$ command\noutput"), {
  text: "new pane\n$ command\noutput",
  aligned: false,
});

console.log("tcmd relative diff checks passed");
