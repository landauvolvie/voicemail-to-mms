import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNotificationText,
  extractCallerIdentity,
  formatPhone,
  isAllowedSender,
  lookupContactName,
  normalizePhone,
} from "../src/core.js";

test("normalizes NANP numbers", () => {
  assert.equal(normalizePhone("+1 (845) 324-1813"), "8453241813");
  assert.equal(formatPhone("8453241813"), "845-324-1813");
});

test("accepts VoIP.ms voicemail sender domains", () => {
  assert.equal(isAllowedSender("voicemail@voip.ms"), true);
  assert.equal(isAllowedSender("system@mail.voipinterface.net"), true);
  assert.equal(isAllowedSender("attacker@example.com"), false);
});

test("extracts caller name and number from a labeled line", () => {
  const result = extractCallerIdentity(
    'New voicemail\nCaller ID: "John Smith" <+1 (845) 555-1212>\nTo: 8605060971',
    "8605060971",
    "8453241813",
  );
  assert.equal(result.number, "8455551212");
  assert.equal(result.name, "John Smith");
});

test("excludes own DID and MMS destination when finding caller", () => {
  const result = extractCallerIdentity(
    "DID 860-506-0971 destination 845-324-1813 caller 914-555-0100",
    "8605060971",
    "8453241813",
  );
  assert.equal(result.number, "9145550100");
});

test("contact map overrides parsed caller name", () => {
  assert.equal(lookupContactName("8455551212", '{"+1 845-555-1212":"John Contact"}'), "John Contact");
  const text = buildNotificationText(
    { number: "8455551212", name: "Caller ID Name" },
    new Date("2026-08-31T21:32:00Z"),
    "America/New_York",
    '{"8455551212":"John Contact"}',
  );
  assert.match(text, /John Contact/);
  assert.match(text, /845-555-1212/);
});

test("formats a short voicemail notification", () => {
  const text = buildNotificationText(
    { number: "9145550100", name: "Jane Doe" },
    new Date("2026-08-31T21:32:00Z"),
    "America/New_York",
  );
  assert.equal(text, "Voicemail from Jane Doe (914-555-0100) - Aug 31, 2026, 5:32 PM");
});
