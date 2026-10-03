// Covers lib/secretStore.ts: a pasted token lives in this tab by default, on the device only when the
// person opts in, and never in both places at once.
import test from "node:test";
import assert from "node:assert/strict";
import { clearSecret, readSecret, whereStored, writeSecret, type Stores } from "../lib/secretStore";

function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
const stores = () => ({ session: memory(), local: memory() });
const KEY = "titan-runner:test:v1";

test("a token saved without remember goes to the tab and not the device", () => {
  const s = stores();
  writeSecret(KEY, "  tok-1  ", false, s as unknown as Stores);
  assert.equal(s.session.data.get(KEY), "tok-1");
  assert.equal(s.local.data.size, 0);
  assert.equal(whereStored(KEY, s as unknown as Stores), "session");
});

test("remember moves it to the device and clears the tab copy", () => {
  const s = stores();
  writeSecret(KEY, "tok-1", false, s as unknown as Stores);
  writeSecret(KEY, "tok-2", true, s as unknown as Stores);
  assert.equal(s.local.data.get(KEY), "tok-2");
  assert.equal(s.session.data.size, 0);
  assert.equal(whereStored(KEY, s as unknown as Stores), "local");
  writeSecret(KEY, "tok-3", false, s as unknown as Stores);
  assert.equal(s.local.data.size, 0, "turning remember off removes the device copy");
  assert.equal(readSecret(KEY, s as unknown as Stores), "tok-3");
});

test("read prefers the tab, falls back to the device, and clear removes both", () => {
  const s = stores();
  s.local.data.set(KEY, "from-device");
  assert.equal(readSecret(KEY, s as unknown as Stores), "from-device");
  s.session.data.set(KEY, "from-tab");
  assert.equal(readSecret(KEY, s as unknown as Stores), "from-tab");
  clearSecret(KEY, s as unknown as Stores);
  assert.equal(readSecret(KEY, s as unknown as Stores), null);
  assert.equal(whereStored(KEY, s as unknown as Stores), null);
});

test("blocked storage never throws", () => {
  const boom = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  const s = { session: boom, local: boom } as Stores;
  assert.doesNotThrow(() => writeSecret(KEY, "x", true, s));
  assert.equal(readSecret(KEY, s), null);
  assert.equal(whereStored(KEY, s), null);
  assert.doesNotThrow(() => clearSecret(KEY, s));
  assert.equal(readSecret(KEY, null), null);
  assert.doesNotThrow(() => writeSecret(KEY, "x", false, null));
});
